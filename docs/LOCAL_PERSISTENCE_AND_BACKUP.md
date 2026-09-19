# Local Persistence & Backup

**Canonical source** for how LandedCompare stores data locally, how the schema
is versioned and migrated, how autosave behaves, and how backup, snapshots and
restore work.

- What the data *is* → [Data Model](DATA_MODEL.md)
- Why the pilot is local-only → [Product Scope](PRODUCT_SCOPE.md)
- Layering → [Architecture](ARCHITECTURE.md)

**Implementation status.** §2 (the working database), §3 (persisted vs runtime
shape), §4 (schema versioning and migrations) and §5 (autosave) are implemented
by Phase 7 in `src/persistence/`. §6 (snapshots), §7 (external backup), §8
(restore) and §9 (backup security) are **not** implemented; they are Phase 8.
Where Phase 7 could not fully honour a rule because it depends on Phase 8 — the
`PRE_MIGRATION` snapshot in §4, rule 3 — that is stated inline rather than left
to be discovered ([Implementation Plan](IMPLEMENTATION_PLAN.md)).

---

## 1. The stance

The pilot runs on one computer, in a browser, with no server. That makes the
storage design carry a responsibility it would not carry in a hosted product:
**there is no operations team, no nightly database dump, and no second copy of
anything unless this application creates it.**

So the architecture is deliberately three layers, and the difference between
them is stated in the product, not just in this document:

```text
          WORKING DATA
          └── IndexedDB                  ← everything the app reads and writes

          RECOVERY
          ├── internal snapshots         ← undo. Dies with the disk.
          └── external backup files      ← disaster recovery. The only real one.
```

**IndexedDB alone is not a backup strategy, and internal snapshots are not
either.** Both live in the same browser origin on the same disk. A failed drive,
a reinstalled operating system, a wiped browser profile, or the user clicking
"clear browsing data" destroys the working database and every snapshot in it, in
one action. Only a file that has left the origin — ideally the machine — is
disaster recovery. The UI must say this where the user makes the choice, not
only here.

---

## 2. IndexedDB — the working database

### Database and stores

One database, `landedcompare`, whose IndexedDB version number **is** the
application's `schemaVersion` (§4). The name is a constant
(`src/persistence/schema.ts`), never derived from a route, a project, a user or
a generated id — one database is what a backup and a restore have to cover.

IndexedDB is scoped to the **browser origin**, and nothing in this design
changes that: a different browser, a different profile, or a cleared profile is
a different — or empty — database. That limit is not a gap to work around; it
is the reason §7 exists.

| Store | Key | Contents | Indexes |
| --- | --- | --- | --- |
| `meta` | fixed key | `schemaVersion`, `appVersion`, `installId`, `createdAt`, `lastExternalBackupAt` | — |
| `settings` | key | locale and UI preferences | — |
| `counters` | key | human-code sequences (`PO`, `SHP`, `RCP`, `OUT`) | — |
| `products` | `id` | catalog | `sku` (unique), `active` |
| `suppliers` | `id` | supplier master | `active` |
| `customers` | `id` | customer master | `active` |
| `projects` | `id` | analysis projects, requirements + quotes embedded, `supplierIds` referenced | `updatedAt` |
| `purchaseOrders` | `id` | header + lines | `supplierId`, `status`, `code` (unique) |
| `inboundShipments` | `id` | header + lines | `supplierId`, `status`, `code` (unique) |
| `warehouseReceipts` | `id` | header + lines, immutable | `inboundShipmentId`, `postedAt` |
| `inventoryMovements` | `id` | **append-only ledger** | `productId`, `occurredAt`, `[productId+occurredAt]`, `type`, `sourceId` |
| `inventoryReservations` | `id` | reservations | `productId`, `customerId`, `status` |
| `outboundShipments` | `id` | header + lines | `customerId`, `status`, `code` (unique) |
| `snapshots` | `id` | internal recovery checkpoints | `createdAt`, `kind` |

### Embedded lines, standalone ledger

Document lines (purchase-order lines, shipment lines, receipt lines, outbound
lines) are **embedded in their parent record**, not stored separately. The
parent and its lines are one aggregate: always read together, always written
together, and a write of half of them is never valid (Data Model, R5).

`inventoryMovements` is the deliberate exception. It is queried *across*
documents — "every movement for product X, in time order" — which is what the
`[productId+occurredAt]` compound index exists for, and what stock derivation
scans.

### Transaction boundaries

The rule: **one user action, one transaction, spanning every store it touches.**
IndexedDB gives multi-store atomicity as long as all stores are named when the
transaction opens, so there is no excuse for a partial write.

The three that matter, because they are the ones that could corrupt the ledger:

| Action | Stores in one `readwrite` transaction |
| --- | --- |
| Post a warehouse receipt | `warehouseReceipts`, `inventoryMovements`, `counters` |
| Dispatch an outbound shipment | `outboundShipments`, `inventoryMovements`, `counters` |
| Post a manual movement / stock count | `inventoryMovements` |

A receipt that wrote its document but not its movements — or the reverse — is
precisely the failure the whole ledger design exists to prevent, so these are
never split across transactions and never issued as two awaited writes.

Validation runs **before** the transaction opens (IndexedDB transactions
auto-close on the first turn of the event loop with no pending request, so
nothing may `await` anything non-IndexedDB inside one).

As implemented, `Database` exposes only `read(stores, …)` and
`write(stores, …)`: every operation names its stores up front and runs inside
one transaction, and a write resolves on the transaction's `complete` event
rather than on the individual request — a save is not reported as saved until
it has committed. Anything thrown inside the callback aborts the whole
transaction, so a validation failure between two writes leaves neither.

Every store in the table above is created at `schemaVersion` 1, including the
ones whose records a later phase writes: creating an object store *is* a schema
change, so deferring it would cost a migration per phase for no benefit. What a
later phase adds is the record type and its typed operations, not the store.

### No stored balances

Nothing in this database holds a stock quantity. Physical, reserved, available,
on-order and in-transit figures are computed from the ledger and the open
documents on read (Data Model, I1 and I19).

At pilot volume this is not a performance problem: a few thousand movements,
scanned through an index, is single-digit milliseconds. If it ever becomes one,
the answer is a `stockBalanceCache` store that is explicitly rebuildable, never
authoritative, and rebuilt after every migration and every restore — not a
balance column on `products`.

### Storage durability

- Request `navigator.storage.persist()` on first run. Without it, browsers may
  evict origin data under storage pressure.
- Show `navigator.storage.estimate()` usage in a diagnostics view — quota
  exhaustion is a realistic pilot failure and it should be visible before it
  becomes a failed write.
- Quota errors (`QuotaExceededError`) get their own error path and their own
  message: "storage is full — export a backup and remove old snapshots", not a
  generic save failure.

---

## 3. Persisted record shape vs runtime domain shape

The persistence layer is allowed to store a **different shape** from the one the
domain and engine work with, and it converts on the boundary. This is what lets
the operational model normalise data without touching audited code.

The concrete case: `Project` in `src/domain/project/Project.ts` holds
`readonly suppliers: readonly Supplier[]`, and `compareSuppliers()` expects
exactly that. But a purchase order references a company-wide supplier, not a
project-local copy (Data Model §4). So:

```text
stored:   ProjectRecord { …, supplierIds: string[] }  +  suppliers store
loaded:   read the record, read the referenced suppliers, assemble
runtime:  Project { …, suppliers: Supplier[] }        ← unchanged shape
```

`src/domain`, `src/calculation` and `src/comparison` are unaware of any of this.
The same mechanism restores `Money` and `Quantity` through their existing
`fromJSON()` contracts rather than storing class instances — decimal.js
internals have never been a persistence contract and are not becoming one.

---

## 4. Schema versioning

Three version numbers, none of which is the same thing as another.

| Version | What it describes | Changes when | Form |
| --- | --- | --- | --- |
| `schemaVersion` | the shape of the stored data | a store or record shape changes | integer, = IndexedDB version |
| `backupFormatVersion` | the shape of the backup *envelope* | the manifest/checksum/container changes | integer |
| `appVersion` | the build | every release | semver string, informational only |

**`schemaVersion` and `backupFormatVersion` must not be conflated.** A backup
file written with a wrapper the reader understands may contain a payload the
reader does not (old app, new data) — and a wrapper change may carry a payload
shape that has not moved at all. Keeping them separate is what lets a future app
read an old backup: it recognises the envelope, sees an older `schemaVersion`,
and runs the same migration chain the database uses (§7).

`appVersion` is recorded for support ("which build wrote this?") and never
branched on.

### Migration rules

1. Migrations are **ordered, numbered functions**: `v1→v2`, `v2→v3`, applied in
   sequence. There is no "detect the shape and adapt" path — inferring a schema
   from data is how corrupt data gets silently accepted.
2. **Never assume old data matches the new shape.** Each migration reads the
   previous shape explicitly and writes the new one.
3. **A snapshot is written before any migration runs** (kind `PRE_MIGRATION`),
   in its own transaction, before the upgrade begins. **Not implemented as of
   Phase 7** — snapshots are Phase 8, so this protection does not exist yet.
   Rule 4's guarantee is in force and tested; rule 3's is not. Until Phase 8
   ships there is no remedy for a migration that commits successfully and is
   logically wrong, which is the reason no pilot data should be entered before
   then.
4. Migrations execute inside IndexedDB's `upgradeneeded` transaction, which
   aborts as a unit on any thrown error — a failed migration leaves the database
   at its previous version with its previous data (Data Model, I21). The
   snapshot in rule 3 covers the other failure mode: a migration that succeeds
   technically but is logically wrong.
5. **A database whose `schemaVersion` is higher than the build supports must not
   be opened.** IndexedDB cannot downgrade, and an older build writing into a
   newer schema corrupts it. The app refuses, explains, and tells the user to
   update — it does not try. Checked twice, because the two versions can
   disagree: the stored database version is inspected before `open()`, and the
   `meta` record's `schemaVersion` is re-validated after it, so a hand-edited
   `meta` is refused as loudly as a genuinely newer database.
6. Migration code is **frozen once released**. A shipped migration is edited only
   to fix a defect, never to accommodate a later schema change; that is what the
   next numbered migration is for.
7. Every migration ships with tests that run it against a realistic fixture of
   the previous version, not against a hand-written object.
8. **Steps run strictly in sequence.** A migration's work is issued as
   IndexedDB requests and completes asynchronously, so the runner waits for one
   step's writes to land before starting the next. Two steps cursoring over the
   same store concurrently would have the later one read records the earlier
   one had not rewritten yet — and silently overwrite its output.

`MIGRATIONS` is empty at `schemaVersion` 1, and deliberately so: no earlier
version of this schema has ever existed in anyone's browser, so there is no
data to transform, and a fabricated `v0 → v1` step would run on every fresh
install for no reason. The runner, its failure semantics and its tests exist
now so the first real entry is a one-function change.

---

## 5. Autosave

Phase 7 implements this; Phase 6.5 fixes the behaviour it must implement.

**What Phase 7 shipped:** `src/persistence/autosave.ts` — the debounce, the
flush, the four-state model, the retry backoff, the kept dirty buffer and the
typed failure. It is plain TypeScript with no React and no global timers: the
clock is injected, so the debounce and the backoff are tested with a controlled
clock rather than by waiting, and the only timers that exist are started by a
change and cancelled when nothing is left to save.

**What belongs to the UI phases:** the indicator itself, the `beforeunload`
guard (the controller answers `hasUnsavedChanges()`; wiring it to the window is
a React concern), and the translated wording of each state. Persistence
produces machine-readable error codes only — no user-facing Turkish or English
string is written anywhere in this layer.

### What a save is

**The unit of save is the aggregate, never the field.** Editing three fields of a
purchase order produces one validated write of the whole order, not three
partial ones. Form state lives in React; a save is an explicit transactional
write of a validated domain object.

### Debounce, and where it does not apply

| Interaction | Behaviour |
| --- | --- |
| Typing in a field of an open editable aggregate | debounce **600 ms** after the last keystroke, then write |
| Leaving a field / closing an editor / navigating away | flush immediately, do not wait for the debounce |
| A state-changing command (place order, cancel, close, post receipt, dispatch, adjust stock, restore) | **no debounce, no autosave** — explicit action, explicit confirmation, immediate transaction |

The second row of that table is the important one. **Ledger-affecting operations
are never autosaved.** A timer must not be able to post a stock movement. Posting
is a decision a person takes, once, knowingly — which is also why receipts and
dispatches have no draft state (Data Model §8).

### Save state and failure

A single visible indicator with four states: `IDLE`, `SAVING`, `SAVED`, `ERROR`.

On failure the dirty buffer is **kept**, not discarded. Retry with backoff
(roughly 1s, 3s, 10s), then stop and leave the error visible with a manual retry.
While a save is failing:

- navigating away from the record and closing the tab are guarded
  (`beforeunload`);
- the failure is not swallowed into a toast that disappears;
- quota errors get the distinct message from §2.

### Concurrency

The pilot is single-user, but **two browser tabs on the same machine is a real
and likely accident**, and it is the one way this design can lose data silently.

- Every editable aggregate carries `updatedAt`. A write compares the stored
  `updatedAt` against the value loaded; a mismatch means another tab wrote
  first, and the save is **refused** with a "this record changed elsewhere —
  reload" message rather than overwriting.
- A `BroadcastChannel` advisory announces which tab is active, so a second tab
  can warn on open instead of waiting for the first conflict.

Neither is a merge mechanism. Detecting the conflict and refusing is the whole
goal; resolving it is the user's job.

---

## 6. Recovery layer 1 — internal snapshots

A snapshot is a complete, timestamped copy of every business store, written into
the `snapshots` store inside the same database.

```text
Snapshot
  id             UUID
  kind           MANUAL | DAILY | PRE_MIGRATION | PRE_IMPORT | PRE_RESTORE
  createdAt      instant
  schemaVersion  integer
  appVersion     string
  entityCounts   { store: count }
  sizeBytes      integer
  payload        the serialised store contents
```

### What they are for, and what they are not for

They are **undo at the database level**: a bad bulk edit, a mistaken import, a
migration that turned out wrong, a restore the user regrets. They are fast, they
need no user action, and they cannot be forgotten.

They are **not disaster recovery.** They share a disk, a browser profile and an
origin with the data they protect. Everything that destroys the working database
destroys them at the same instant. This must be stated in the UI next to the
snapshot list, not only in this document.

### When snapshots are taken

- automatically once per day, on first app use that day (`DAILY`);
- before a migration (`PRE_MIGRATION`);
- before importing data (`PRE_IMPORT`);
- before a restore (`PRE_RESTORE`) — see §8 for the ordering rule;
- on demand (`MANUAL`).

### Retention

Browser storage is finite and snapshots are full copies, so retention is a
policy, not "keep everything".

| Kind | Keep |
| --- | --- |
| `DAILY` | last 7 |
| weekly promotion | the newest daily of each of the last 4 weeks |
| `PRE_MIGRATION` | last 3, and never pruned within 30 days of creation |
| `PRE_IMPORT` | last 3 |
| `PRE_RESTORE` | last 3, and **the newest is never pruned** |
| `MANUAL` | last 5, user-deletable |

Plus a global ceiling: total snapshot bytes stay under roughly 40% of the
estimated quota (`navigator.storage.estimate()`). When it is exceeded, the
oldest prunable snapshot is removed first, honouring the two exemptions above.
If pruning cannot free enough space, snapshotting degrades loudly — the user is
told snapshots are paused and asked to export a backup — rather than silently
stopping.

**External backup files have no automatic retention.** Keeping, rotating and
storing them off-machine is a human process during the pilot, which is why §9
adds a staleness reminder instead of pretending the app can manage files it
cannot see.

---

## 7. Recovery layer 2 — external portable backup

### Format

A single **JSON file**, UTF-8:

```text
LandedCompare_Backup_2026-09-19_1832.json
```

`.json`, not a custom `.lcb` extension. A custom extension would signal a
container format that does not exist, hide the content from every tool the user
already has, and buy nothing — the format is one JSON document. When attachments
or photos eventually justify a ZIP container, that is a `backupFormatVersion`
bump and `.lcb` becomes meaningful then.

### Envelope

```jsonc
{
  "magic": "LandedCompareBackup",
  "backupFormatVersion": 1,
  "schemaVersion": 3,
  "appVersion": "0.4.0",
  "createdAt": "2026-09-19T18:32:11.482Z",
  "installId": "…",
  "entityCounts": {
    "products": 412,
    "purchaseOrders": 58,
    "inventoryMovements": 5320
  },
  "integrity": {
    "algorithm": "SHA-256",
    "scope": "data",
    "value": "…"
  },
  "data": {
    "products": [ /* … */ ],
    "inventoryMovements": [ /* … */ ]
  }
}
```

- `magic` is checked first — it rejects "the user picked the wrong JSON file"
  before anything else runs.
- `entityCounts` is what the pre-restore summary shows the user, and is
  re-verified against `data` after parsing. A mismatch fails the restore: it
  means the file was edited or truncated.
- `integrity.value` is a SHA-256 over a **canonical serialisation** of `data`
  (store keys sorted, records in stored order, no incidental whitespace),
  computed with `crypto.subtle.digest`. Canonicalisation is required or the
  checksum is unreproducible.

**What the checksum does and does not do:** it detects corruption, truncation
and accidental editing. It is **not** tamper-proof — there is no secret, so
anyone who edits the payload can recompute it. Claiming otherwise would be worse
than not having it.

### Scope

The backup covers **all user and business data**: catalog, parties, analysis
projects, purchase orders, shipments, receipts, the full movement ledger,
reservations, outbound shipments, settings and counters.

Excluded: the `snapshots` store (a backup of backups multiplies file size for no
recovery value) and any future derived cache (rebuildable by definition).

### Export paths

Two, and the order matters.

1. **Download backup — always available, always the fallback.** A `Blob` and a
   download. Works in every browser the pilot could plausibly run in. **The
   product never loses backup capability because of a missing API.**
2. **Save to a chosen folder — optional convenience.** Where the File System
   Access API exists (Chromium desktop, which the pilot machine most likely
   runs), a `FileSystemDirectoryHandle` can be persisted in IndexedDB and reused,
   so repeat backups go to the same folder with one click. Permission must be
   re-checked each session (`queryPermission` / `requestPermission`) and can be
   revoked at any time; when it is, path 1 takes over with no loss of function.

Be honest about what "automatic" can mean in a browser: there is no background
scheduler and no silent write to an arbitrary path. The realistic behaviour is a
**prompted backup** — the app notices a backup is overdue and offers a one-click
export, and with a granted directory handle that click writes straight to the
folder. It is not an unattended nightly job, and the UI should not imply one.

### Backup freshness reminder

`meta.lastExternalBackupAt` is stamped on every successful export. The app shows
a persistent, non-dismissible-by-default warning when it is more than 7 days old
or absent. This is honest even when the app cannot see where the file went, and
in a single-machine pilot it is the single highest-value safety feature in this
document.

---

## 8. Restore

Restore is the most dangerous operation in the application: it is the only one
that can destroy everything. It is designed accordingly.

### Flow

```text
 1  user selects a file
 2  size check            reject > 100 MB before reading into memory
 3  read as text
 4  JSON.parse            with a prototype-safe reviver (§9)
 5  envelope check        magic, backupFormatVersion supported
 6  schema version check  equal → proceed
                          lower → run the migration chain over the payload
                          higher → REFUSE, explain, stop
 7  integrity check       recompute SHA-256 over canonical(data), compare
 8  structural validation every record through the same validators/factories
                          used at runtime — no blind hydration
 9  count check           entityCounts vs data
10  SUMMARY               show the user: file date, app version, counts per
                          entity, and what currently exists — i.e. what is
                          about to be replaced
11  explicit confirmation typed/checked, not a single OK
12  PRE_RESTORE snapshot  separate transaction, committed BEFORE step 13
13  restore transaction   one readwrite transaction over every business store:
                          clear, then repopulate.  `snapshots` and `meta` are
                          NOT cleared.
14  verify                re-read counts from the database and compare
15  report                success with counts, or failure with the reason and
                          the confirmation that nothing changed
```

### The rules inside that flow

- **Steps 2–9 all run before step 12.** Nothing is written until the file has
  fully proven itself. A restore that fails validation is a no-op.
- **Step 12 must commit before step 13 opens.** The pre-restore snapshot is
  useless if it is in the transaction that replaces the data, and the restore
  transaction must not clear the `snapshots` store or it deletes the escape
  hatch it just created.
- **Step 13 is a single transaction** covering every business store. Either all
  of it lands or none of it does, so a failure — including a crash or a closed
  laptop — leaves the working database exactly as it was (Data Model, I20). At
  pilot volumes one transaction is comfortable; if a payload is large enough to
  risk it, the user is warned before step 11, and the fallback design is to
  restore into shadow stores and swap at the end.
- **Higher `schemaVersion` is refused, never guessed at.** Reading a newer
  backup with an older build means dropping fields it does not understand, which
  is silent data loss wearing a success message.
- **Replace-all only.** Merge is not offered (Product Scope, Open Decision 10).

---

## 9. Backup security

The file contains a company's operational data, and restore is an untrusted-input
parser. Both are treated as such.

**Parsing**

- `JSON.parse` only. No `eval`, no `Function`, no dynamic module loading, no
  YAML/JS config formats.
- A reviver drops `__proto__`, `constructor` and `prototype` keys outright —
  **prototype pollution is the realistic attack on a JSON importer**, and it is
  cheap to close.
- Objects are built with `Object.create(null)` or explicit field-by-field
  construction. Nothing is restored by `Object.assign` onto a live object or by
  spreading a parsed blob into a domain type.

**Validation**

- Every record goes through the **same validators the application uses at
  runtime** — the `createX()` factories and their invariant checks. A backup is
  not a trusted path into the domain.
- `Money` and `Quantity` are rebuilt through their existing `fromJSON()`
  contracts from decimal strings. No class instance is ever serialised or
  hydrated.
- Unknown top-level keys, unknown store names and unknown enum values are
  rejected, not ignored. Silently dropping a field is how a restore "succeeds"
  with less data than it was given.

**Limits**

- Hard file-size cap (100 MB for the pilot), checked before reading.
- Maximum nesting depth and maximum array lengths per store, to bound
  pathological input.
- Anything that fails any check is rejected as a whole file with a specific
  reason. There is no partial-acceptance mode.

**Encryption at rest: post-pilot, not MVP.** Product Scope, Open Decision 9 has
the full reasoning; in short, the realistic risk in a single-machine pilot is
losing the file, and a password-based scheme adds a permanent, irreversible way
to lose it. When it is added: Web Crypto AES-GCM with PBKDF2 key derivation, as
a `backupFormatVersion` bump, with the unencrypted format still readable.

---

## 10. What the user must be told, in the product

Design constraints on the UI, recorded here because they are the point of the
whole chapter:

1. Snapshots are labelled as **undo**, with an explicit note that they are lost
   if the computer is lost.
2. External backup is labelled as **the only disaster recovery**, with the date
   of the last one always visible.
3. A restore always shows what will be replaced before it does anything.
4. A failed save, a failed migration and a failed restore each say what
   happened and what state the data is now in — never a generic error.
5. Storage usage and quota are visible somewhere the user can find them before
   the disk fills, not after.
