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
(restore) and §9 (backup security) are implemented by Phase 8 in `src/backup/`.

Where the implementation made a rule concrete, this document now states the
concrete form rather than the intention, and where it *strengthened* a rule —
the parse reviver in §9 rejects rather than drops, the restore flow in §8
verifies integrity before it migrates — the change and the reason are recorded
inline. Two things named here remain deliberately unbuilt and are marked where
they appear: the optional File System Access directory handle in §7, which
needs a picker and therefore a UI, and every user-facing string in §10, which
belongs to Phase 9 ([Implementation Plan](IMPLEMENTATION_PLAN.md)).

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
| `products` | `id` | catalog | `sku` (unique) |
| `suppliers` | `id` | supplier master | — |
| `customers` | `id` | customer master | — |
| `projects` | `id` | analysis projects, requirements + quotes embedded, `supplierIds` referenced | `updatedAt` |
| `purchaseOrders` | `id` | header + lines | `supplierId`, `status`, `code` (unique) |
| `inboundShipments` | `id` | header + lines | `supplierId`, `status`, `code` (unique) |
| `warehouseReceipts` | `id` | header + lines, immutable | `inboundShipmentId`, `postedAt` |
| `inventoryMovements` | `id` | **append-only ledger** | `productId`, `occurredAt`, `[productId+occurredAt]`, `type`, `sourceId` |
| `inventoryReservations` | `id` | reservations | `productId`, `customerId`, `status` |
| `outboundShipments` | `id` | header + lines | `customerId`, `status`, `code` (unique) |
| `snapshots` | `id` | internal recovery checkpoints | `createdAt`, `kind` |

### No index on `active`, and no mirrored copy of it either

`schemaVersion` 1 declared an index on `active` for `products`, `suppliers` and
`customers`. It could never have worked: **a boolean is not a valid IndexedDB
key.** Valid keys are numbers, strings, `Date`s, binary data and arrays of
those; a record whose index keyPath resolves to anything else is not rejected,
not warned about, and simply *left out of the index*.

So those three indexes contained no entries at all, over stores holding real
records, and `index('active').getAll(true)` would have answered "there are
none" — successfully. A catalogue screen built on it would show a blank list
over a populated database, which is the worst shape a defect can take: correct
code, successful call, wrong answer, no signal.

`schemaVersion` 2 **removes them**. The alternative — a second, index-friendly
copy of the same fact, `activeFlag: 0 | 1` or `activeKey: 'ACTIVE' |
'INACTIVE'` written beside `active` — buys an index at the price of two fields
that mean one thing and can disagree. Every writer has to remember both, and
the first one that forgets leaves the index contradicting the record with
nothing to detect it. Duplicated state whose only justification is a lookup is
a correctness liability, and this schema does not take it.

`active: boolean` therefore remains exactly what it is: the canonical field on
the record. "Only the active ones" is answered by **reading the store and
filtering the result**, which at pilot volume — a few hundred products,
suppliers and customers, already being rendered — is single-digit milliseconds.
This is the same reasoning as "No stored balances" below. If catalogue volume
ever makes it a real cost, the answer is an index on a field that is genuinely
a key, not a mirrored boolean.

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
   in its own transaction, before the upgrade begins. Implemented as
   `ensurePreMigrationSnapshot()` in `src/backup/preMigration.ts`, which reads
   the stored version, and if it is behind this build **opens the database at
   the version it is already at**, snapshots, and closes — then the caller
   opens normally and the migration runs.

   That detour is not fussiness. `upgradeneeded` fires *inside* the
   version-change transaction, so a snapshot written there rolls back together
   with a failed migration — it disappears in exactly the case it exists for.
   And `openDatabase()` cannot take it either: `src/persistence` sits below
   `src/backup` in the dependency graph, and having the opener call the backup
   module would invert that. So the sequence belongs to whoever starts the
   application.

   The function reports rather than enforces. When the browser does not
   implement `indexedDB.databases()` the honest answer is `VERSION_UNKNOWN`,
   and what to do about it — refuse to upgrade, or require an external backup
   first — is a decision with a user in it.

   **Phase 9 made that decision and wired it in** (`src/app/bootstrap.ts`).
   The startup sequence calls `ensurePreMigrationSnapshot()` before
   `openDatabase()`, and **refuses to open** on anything other than `CREATED`,
   `NOT_NEEDED` or `NO_DATABASE`:

   - `VERSION_UNKNOWN` blocks. "No database" and "a database one version
     behind" are the same answer from a browser that will not enumerate, and
     picking the harmless reading is the guess that silently migrates real data
     with no snapshot behind it. The user is told to open the application in a
     browser that reports the version.
   - A snapshot that could not be written blocks. The upgrade is not attempted
     and the stored data is untouched. There is deliberately **no override**: a
     button labelled "upgrade anyway" is a button that destroys data, and the
     honest remedy is free space, not a confirmation dialog.

   The mechanism's own guarantee is tested separately, including the case that
   matters: a snapshot taken this way survives a migration that aborts.
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

### The released chain

**Current `schemaVersion`: 3.**

| Step | What it does | Payload effect |
| --- | --- | --- |
| `v1 → v2` | deletes the `products.active`, `suppliers.active` and `customers.active` indexes | none — structurally a no-op |
| `v2 → v3` | Phase 9: `products` and `customers` gain record types and writers; `RequirementItem` gains the optional `productId` | none — structurally a no-op |

There is no `v0 → v1`, and there never will be: version 1 is the first that has
existed in anyone's browser, so a fabricated step would run on every fresh
install and transform nothing.

`v1 → v2` rewrites no record. The set of indexes is part of the stored schema
and an upgrade is the only place IndexedDB permits changing it, so this is a
genuine version bump — but `active: boolean` was never the problem and is not
touched, which means **every existing row survives the upgrade byte for byte.**
That is asserted by the migration's tests rather than assumed, against a
genuine version-1 database rebuilt from the layout version 1 actually created,
indexes and all. Editing `STORE_DEFINITIONS` without the numbered step would
have left the three dead indexes in every database already created, with
nothing that would ever remove them.

Because `schemaVersion` describes the payload as well as the database, the
**backup migration chain gets a matching `v1 → v2` step** (§7). It returns the
payload unchanged, and it is declared rather than skipped for two reasons:
without an entry at 2 a perfectly good version-1 file would be refused with
`BACKUP_SCHEMA_UNSUPPORTED`; and an explicit step makes "a version-1 payload
needs no transformation" an assertion a test can *fail*, where silently
treating 1 and 2 as interchangeable would be an assumption nothing could catch.
`backupFormatVersion` does **not** move — the envelope did not change.

`v2 → v3` rewrites no record either, for two reasons that are worth separating.
`products` and `customers` are **empty in every version-2 database**: the
stores were created at version 1, but no code path had a record type, a store
helper or a screen to write one, so there is nothing to transform. And
`productId` is optional and absent, which is exactly what an unlinked
requirement means — backfilling it would require inventing a product reference,
which is the one thing a migration may never do.

It is still a real bump, and the reason is rule 5 rather than the data. A
version-2 build opening a version-3 database would find products it has no
validator for: it would read them as nothing, and `validateBackupData` would
refuse the backup it then produced with `BACKUP_STORE_UNSUPPORTED`. The bump
turns that silent mismatch into the explicit refusal rule 5 exists to give.
The payload chain gains a matching step for the same reason `v1 → v2` has one:
so a version-2 file is not rejected, and so "a version-2 payload needs no
transformation" is an assertion a test can fail.

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

### Coherence

Every store is read **and** the snapshot is written inside **one** `readwrite`
transaction. A snapshot that caught the database mid-write would be worse than
no snapshot, because it would look restorable: reading suppliers, returning to
the event loop, then reading projects can capture a project referencing a
supplier that had not been saved yet — a state that never existed. Building the
record in between is pure synchronous work, so the transaction never waits on
anything that is not an IndexedDB request.

### When snapshots are taken

- automatically once per day, on first app use that day (`DAILY`);
- before a migration (`PRE_MIGRATION`) — see §4, rule 3 for why this is a
  startup step and not something `openDatabase()` can do;
- before importing data (`PRE_IMPORT`);
- before a restore (`PRE_RESTORE`) — see §8 for the ordering rule;
- on demand (`MANUAL`).

**"Daily" means what it can honestly mean in a browser.** A tab gets no
guaranteed timer: `setInterval` stops when the tab closes, throttles when it is
backgrounded, and is gone when the machine sleeps. An "automatic nightly
snapshot" built that way would silently not happen on exactly the days the
computer was off — the days nobody would notice. So the rule is: *when the
application is opened, if no `DAILY` snapshot exists for the current day, take
one.* `ensureDailySnapshot()` is idempotent within a day and is driven by the
application's lifecycle, not by a clock it does not control. Nothing in this
module schedules anything.

The day boundary is **UTC**, sliced from the ISO instant so the same inputs
decide the same way on every machine and in every test. In Istanbul (UTC+3) a
snapshot taken at 02:00 local belongs to the previous UTC day; the cost is that
a snapshot can be a few hours older than a local-midnight rule would give,
which is not a difference any recovery scenario turns on.

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
stopping. `applyRetention()` returns `overCeiling: true` for that case; it is a
machine-readable state, not a thrown error, because the application must keep
working while it is true.

**The quota estimate is a hint, not a dependency.** Where
`navigator.storage.estimate()` is missing or throws, the ceiling is simply not
applied and `quotaKnown` is false. The per-kind policy still runs, snapshots
are still bounded, and nothing fails because a browser declined to answer a
question about free space.

Two protections are not negotiable and hold even under the ceiling:

- **The newest `PRE_RESTORE` snapshot is never pruned.** It is the escape hatch
  from the most destructive operation in the application, and a ceiling that
  could delete it would make the restore guarantee conditional on free disk
  space.
- **A `PRE_MIGRATION` snapshot younger than 30 days is never pruned.** A
  migration that is technically successful and logically wrong is discovered
  weeks later, by someone noticing a number is off. That is the window this
  covers.

Deciding what to keep is a pure function of the snapshot metadata, the clock
and the quota (`planRetention()`), with ties broken by id so the same inputs
always produce the same plan. Retention fails quietly by nature — nobody
notices a wrongly pruned snapshot until the day they reach for it — so it is
testable in isolation rather than only through the database.

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
- `entityCounts` **lists every backed-up store, including the empty ones.** A
  partial list would make "the manifest and the payload agree" a weaker claim
  than it looks, since a missing entry and a zero would be indistinguishable.
  It is what the pre-restore summary shows the user, and it is re-verified
  against `data` after parsing; a mismatch fails the restore, because it means
  the file was edited or truncated.
- `integrity.value` is a SHA-256 over a **canonical serialisation** of `data`
  (store keys sorted, records in primary-key order as stored, no incidental
  whitespace), computed with `crypto.subtle.digest`. Canonicalisation is
  required or the checksum is unreproducible. The whole envelope is written
  with the same canonical serialiser, so two exports of the same data are
  byte-identical apart from the manifest fields that must differ.
- The canonical form **rejects** anything without a reproducible JSON shape:
  `undefined`, `NaN`, `±Infinity`, functions, symbols, `bigint`, cycles, and
  anything that is not a plain object or an array — `Date`, `Map`, `Set`,
  `RegExp`, `ArrayBuffer`, typed arrays, and class instances including ones
  with a `toJSON`. That last exclusion is deliberate: `Money` and `Quantity`
  would serialise happily, and the checksum would then depend on decimal.js
  internals. The persisted contract is the decimal *string*, and refusing the
  instance is what keeps it that way.

**The rejection has to happen before the payload is assembled, not after.**
Every one of `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer` and the typed arrays
is a value IndexedDB stores and reads back intact — the store is not wrong
about them. So a normalisation step above the store that walked each object by
its own enumerable properties would turn a `Date` into `{}` and a `Uint8Array`
into `{ "0": 12, "1": 7 }`, and by the time the canonical serialiser saw the
result there would be nothing left to object to. The payload would checksum
cleanly, the file would verify, the restore would succeed, and the value would
be gone. A successful, verified artifact with data silently removed is strictly
worse than a failed one.

So the read boundary (`normaliseStoredValue`) enforces **exactly the table
above**, using the same predicates and the same failure as the serialiser, and
it is allowed to normalise exactly one thing: a plain-object property whose
value is `undefined` may be omitted (§3's absent-optional rule, applied on the
side of the boundary Phase 7 missed). Everything else fails loudly, at a named
path. Arrays are not normalised at all — **order and length are data**, so an
`undefined` element is rejected rather than dropped, because dropping it would
renumber every element after it and restore a different document without
complaint.

**What the checksum does and does not do:** it detects corruption, truncation
and accidental editing. It is **not** tamper-proof and **not** authentication —
there is no secret, so anyone who edits the payload can recompute it and
produce a file that verifies perfectly. Claiming otherwise would be worse than
not having it, because it would invite trusting a file on the strength of a
check that cannot carry that weight. A backup file is exactly as trustworthy as
the place it was stored.

**What the checksum does not cover.** Its scope is `data`, recorded in the file
as `integrity.scope`. The manifest is outside it, which is why two independent
cross-checks exist rather than being redundant: `entityCounts` is recomputed
from the payload, and `schemaVersion` is re-proven by validating every record
against the shapes that version defines. A header that disagrees with its body
is caught by those, not by the digest.

### Scope

The backup covers **all user and business data**: catalog, parties, analysis
projects, purchase orders, shipments, receipts, the full movement ledger,
reservations, outbound shipments, settings and counters. In code that set is
`BUSINESS_STORE_NAMES`, derived from the schema rather than retyped, so a store
added later is covered without anyone remembering to add it twice.

Excluded: the `snapshots` store (a backup of backups multiplies file size for no
recovery value), `meta`, and any future derived cache (rebuildable by
definition).

`meta` is excluded because it describes *this installation* — its `installId`,
the day it was created, when it last exported a backup. Those are facts about
the machine, not about the data, and restoring them would overwrite one
machine's identity with a stranger's and silence a staleness warning that had
been counting correctly. The parts a reader genuinely needs travel in the
manifest instead, where they are read as provenance rather than restored as
state.

**The validator registry is the real compatibility boundary.** Every record in
a payload is re-proven with the same validators the application uses at
runtime, so a store this build has no record type for cannot be restored, and
a payload carrying records for one is refused outright. Today that means
`products`, `customers`, `purchaseOrders`, `inboundShipments`,
`warehouseReceipts`, `inventoryReservations` and `outboundShipments`: their
stores exist (Phase 7 created every store up front) but their record types
arrive with the phase that owns them.

This is a second line behind the `schemaVersion` check rather than a duplicate
of it. Introducing a record type for an already-created store **is** a
record-shape change and therefore bumps `schemaVersion` (§4), so a newer
build's file is already refused one step earlier. The registry makes the
refusal hold even if that rule is broken by accident — which is the kind of
mistake that otherwise surfaces as a half-restored database.

### Export paths

Two, and the order matters.

1. **Download backup — always available, always the fallback.** A `Blob` and a
   download. Works in every browser the pilot could plausibly run in. **The
   product never loses backup capability because of a missing API.**
   Implemented as `downloadBackup()`, the single DOM-aware function in
   `src/backup/`; everything that decides what a backup contains and whether it
   is valid runs without a browser.
2. **Save to a chosen folder — optional convenience. Not built.** Where the
   File System Access API exists (Chromium desktop, which the pilot machine
   most likely runs), a `FileSystemDirectoryHandle` can be persisted in
   IndexedDB and reused, so repeat backups go to the same folder with one
   click. A handle can only be obtained from a real user gesture in a real
   picker — which is a Settings screen, and therefore Phase 9. Building half of
   it now would mean an untestable path behind a permission prompt no test can
   grant. Since path 1 is required to remain the fallback in every case, adding
   the handle later changes nothing about what a backup *is*.

Be honest about what "automatic" can mean in a browser: there is no background
scheduler and no silent write to an arbitrary path. The realistic behaviour is a
**prompted backup** — the app notices a backup is overdue and offers a one-click
export, and with a granted directory handle that click writes straight to the
folder. It is not an unattended nightly job, and the UI should not imply one.

### What `lastExternalBackupAt` actually means

The precise definition, because an over-claimed one would be worse than no
timestamp:

> the last time a complete, checksummed backup file was successfully generated
> **and handed to a delivery mechanism that did not fail.**

It does **not** mean "the file is on disk". A browser download is initiated,
not confirmed: the page is never told whether the user saved the file,
cancelled the dialog, or wrote it to the same failing drive the backup is meant
to survive. No API available to a web page closes that gap, so the product says
what it knows and nothing more. **The UI must phrase this as "backup exported",
never "backup safely saved".**

This is enforced by the shape of the API rather than by discipline:
`createBackup()` generates and stamps nothing; `exportBackup()` generates,
delivers, and stamps only if delivery resolved. A generation that throws and a
delivery that rejects both leave the previous timestamp in place — which keeps
the warning loud instead of reassuring the user about a backup that does not
exist.

### Backup freshness reminder

The app shows a persistent, non-dismissible-by-default warning when
`lastExternalBackupAt` is more than **7 days** old or absent. "Never exported"
is treated as stale, not as "not yet due": it is the state with the most data
at risk, and it should be the loudest.

`externalBackupStatus()` returns that as data — `NEVER | FRESH | STALE` plus
the age — and no string. The wording lives in `src/i18n`, like every other
user-facing sentence in this application.

In a single-machine pilot this is the single highest-value safety feature in
this document.

---

## 8. Restore

Restore is the most dangerous operation in the application: it is the only one
that can destroy everything. It is designed accordingly.

### Flow

The API is split in two, and that split is the design:
`prepareRestore()` covers steps 2–11 and **writes nothing**; `applyRestore()`
covers 12–15 and takes a plan that has already proven itself.

```text
 1  user selects a file
 2  size check            reject > 100 MB — a Blob is checked by `size`, before
                          it is read into memory at all
 3  read as text
 4  depth check           max 32 levels, scanned on the raw text before
                          JSON.parse allocates anything
 5  JSON.parse            with a prototype-safe reviver (§9)
 6  envelope check        magic first, then shape, then backupFormatVersion,
                          then unknown top-level keys
 7  schema version check  equal → proceed
                          lower → a migration chain must exist for it
                          higher → REFUSE, explain, stop
 8  integrity check       recompute SHA-256 over canonical(data AS WRITTEN)
 9  count check           entityCounts vs data, every store
10  migrate in memory     the payload, never the working database
11  structural validation every record of the MIGRATED payload, through the
                          same validators/factories used at runtime — plus
                          duplicate-key detection
    SUMMARY               file date, app version, counts per entity, and what
                          currently exists — i.e. what is about to be replaced
    ── everything above is read-only.  A failure here is a no-op. ──
12  explicit confirmation typed/checked, not a single OK          (Phase 9 UI)
13  PRE_RESTORE snapshot  separate transaction, COMMITTED BEFORE step 14
14  restore transaction   one readwrite transaction over every business store:
                          clear, then repopulate.  `snapshots` and `meta` are
                          NOT in the transaction at all.
15  verify, INSIDE 14     count every store and re-validate a sample against
                          the transaction's own uncommitted writes.  A failure
                          ABORTS the transaction, so a refused restore is a
                          no-op like every other failure above.
16  confirm after commit  a fresh read on a new transaction.  Defence in depth,
                          never the first line of defence, and a DIFFERENT
                          error code because by then the no-op guarantee has
                          stopped applying.
    report                success with counts, or failure with the reason and
                          the confirmation that nothing changed
```

### The rules inside that flow

- **Everything up to the summary is read-only.** Nothing is written until the
  file has fully proven itself, and a restore that fails validation is a no-op
  — asserted after every single rejection case in the test suite, not assumed.
- **Integrity (8–9) is verified before migration (10).** The canonical flow
  listed the schema decision before the checksum; the implementation *decides*
  about the version at step 7 but *applies* the migration at step 10, because
  the checksum covers the payload **as written to the file**. Hashing a payload
  the reader had already transformed would verify the reader's own work rather
  than the file's integrity. The same reasoning applies to `entityCounts`,
  which describes the file. Validation at step 11 then runs on the migrated
  payload, which is the shape actually about to be written.
- **Migration operates on the payload, in memory.** The working database is
  never a scratchpad. If a step throws, or the payload it produces fails
  validation, the restore fails with nothing written anywhere.
- **Step 13 must commit before step 14 opens.** A pre-restore snapshot inside
  the transaction that replaces the data is not a safety net — it rolls back
  with everything else, exactly when it is needed. `createSnapshot()` resolves
  on the transaction's `complete` event, so "committed before" is a promise
  that can actually be awaited. **There is no option to skip it**, and none is
  offered: a force flag would exist for precisely one purpose, which is to be
  used on the day it matters most.
- **Step 14 is a single transaction** covering every business store — and only
  those, so it cannot delete the escape hatch it just created, and cannot
  overwrite this installation's `meta` with the file's. Either all of it lands
  or none of it does, so a failure, a crash or a closed laptop leaves the
  working database exactly as it was (Data Model, I20). Records are written
  with `add()` rather than `put()`: the stores were just cleared, so a key
  collision means the payload carries a duplicate, and aborting beats quietly
  overwriting. At pilot volumes one transaction is comfortable; if a payload is
  ever large enough to risk it, the fallback design is to restore into shadow
  stores and swap at the end.
- **Step 15 reads the database back, and does it inside step 14's
  transaction.** A resolved `add()` means a request was accepted, not that the
  data is right, so verification counts every store and re-parses a bounded
  sample of records through the runtime validators. Success is never reported
  on the strength of writes having been *issued*.

  **The placement is the contract, not an optimisation.** `Database.write`
  resolves on the transaction's `complete` event, so verification placed after
  it would be inspecting a database that had *already* replaced the user's
  data — and a failure there would report "the restore failed" over a working
  database that is neither the old one nor a valid new one. The pre-restore
  snapshot would make that *recoverable*, which is a strictly weaker promise
  than **never entered**. IndexedDB lets a transaction read its own
  uncommitted writes, so verifying inside it checks exactly the state about to
  be committed and can still abort. *Failed restore = no-op* therefore covers
  verification failure too, not just parse and write failure.
- **Step 16 is defence in depth and says so.** A fresh read after the commit
  distinguishes "the transaction reported complete" from "a new connection can
  read it". It cannot be the first place a bad restore is discovered, because
  step 15 already proved the same invariants while they were still
  revocable. Its failure carries a separate code,
  `RESTORE_COMMITTED_BUT_UNVERIFIABLE`, because by that point the replacement
  *has* landed: the working database is the restored data and the pre-restore
  snapshot is the way back. Folding it into the same code as step 15 would let
  a destructive outcome be reported with a no-op's error.

  **The code covers the whole phase, not just the comparison.** The counts are
  what step 16 is *about*, but they are not the only thing in it that can fail:
  the read needs a connection, a transaction and a `count` on every store. The
  realistic failure is `connection.onversionchange` closing the handle because
  another tab started an upgrade, which makes the transaction refuse to open
  before a single count is issued. Letting that escape as a bare
  `TRANSACTION_ABORTED` would name the *confirmation's* transaction while
  implying the *restore's* had rolled back — the exact opposite of the truth,
  and a caller acting on it would tell the user nothing had happened to a
  database that had already been replaced.

  So every path out of step 16 reports the same code with the same two
  non-negotiable facts — `workingDatabaseReplaced: true` and
  `preRestoreSnapshotId` — and distinguishes the cause in a machine-readable
  `reason`: `COUNT_MISMATCH` when the read succeeded and disagreed,
  `CONFIRMATION_UNREADABLE` when it could not be performed. An underlying
  persistence failure travels as its `code`; a raw `DOMException` message never
  becomes user-facing content.

  The distinction a caller must be able to make is therefore exactly two
  outcomes, and it is the one thing this flow will not ask anyone to guess:

  | Outcome | Codes | Working database |
  | --- | --- | --- |
  | rejected or aborted before the commit | `RESTORE_PRECONDITION_FAILED`, `RESTORE_VERIFICATION_FAILED`, `SNAPSHOT_FAILED`, every parse/validate refusal | **unchanged** — exactly as it was |
  | committed, then unconfirmable | `RESTORE_COMMITTED_BUT_UNVERIFIABLE` | **replaced** — the snapshot is the way back |
- **Higher `schemaVersion` is refused, never guessed at.** Reading a newer
  backup with an older build means dropping fields it does not understand, which
  is silent data loss wearing a success message.
- **Replace-all only.** Merge is not offered (Product Scope, Open Decision 10).

### Restoring a snapshot

`prepareRestoreFromSnapshot()` produces the same kind of plan from an internal
snapshot and goes through the identical `applyRestore()` — same pre-restore
snapshot, same atomic replace, same verification. The snapshot's payload is
re-proven record by record like any other input: it was written by this
application, but it has been sitting in a database a user can open in devtools,
and "we wrote it ourselves" is exactly the assumption that lets corrupt data
back in.

### What a restore deliberately leaves alone

`meta` and `snapshots`. The practical consequence worth stating: restoring a
backup does **not** reset `lastExternalBackupAt`. The staleness warning keeps
counting from this machine's last export, not from whenever the restored file
happened to be written — the file proves a backup was taken *somewhere*, not
that this installation is protected going forward.

---

## 9. Backup security

The file contains a company's operational data, and restore is an untrusted-input
parser. Both are treated as such.

**Parsing**

- `JSON.parse` only. No `eval`, no `Function`, no dynamic module loading, no
  YAML/JS config formats.
- A reviver **rejects the whole file** on `__proto__`, `constructor` or
  `prototype` as a key — **prototype pollution is the realistic attack on a
  JSON importer**, and it is cheap to close. This document originally said the
  reviver *drops* those keys; the implementation rejects instead, which is the
  stronger reading of the same intent and follows the rule two bullets below:
  silently dropping a field is how a restore "succeeds" with less data than it
  was given. A file written by this application can never contain one — the
  canonical serialiser refuses to emit it — so a file that does is corrupt or
  hostile, and neither deserves a partial import. Only *keys* are dangerous: a
  supplier legitimately named `constructor` is a value, and is accepted.
- Objects are built by explicit field-by-field construction: every record is
  rebuilt by its validator from checked values, so what comes out has no
  unknown keys, no inherited properties and no prototype the input chose.
  Nothing is restored by `Object.assign` onto a live object or by spreading a
  parsed blob into a domain type.

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

| Limit | Value | Checked |
| --- | --- | --- |
| file size | 100 MB | against `Blob.size` *before* the file is read |
| JSON nesting depth | 32 levels | by scanning the raw text before `JSON.parse` |
| records per store | 200 000 | during payload validation |
| records per payload | 1 000 000 | during payload validation |

The depth scan exists because `JSON.parse` has no depth limit and a reviver
cannot impose one — it is called on the way *out*, after the structure already
exists. Scanning the text is one allocation-free pass, so a `[[[[…]]]]` bomb is
refused before it is ever built.

The numbers are generous on purpose: a pilot year of orders, shipments,
receipts and stock movements is a few tens of thousands of records and
single-digit megabytes. A limit small enough to reject real data would only
teach the user to work around it.

Anything that fails any check is rejected as a whole file with a specific
machine-readable reason. There is no partial-acceptance mode.

**Encryption at rest: post-pilot, not MVP.** Product Scope, Open Decision 9 has
the full reasoning; in short, the realistic risk in a single-machine pilot is
losing the file, and a password-based scheme adds a permanent, irreversible way
to lose it. When it is added: Web Crypto AES-GCM with PBKDF2 key derivation, as
a `backupFormatVersion` bump, with the unencrypted format still readable.

---

## 10. What the user must be told, in the product

Design constraints on the UI, recorded here because they are the point of the
whole chapter. **None of these are built** — `src/backup/` contains no string
in any language, only machine-readable codes and states for Phase 9 to render
through `src/i18n`.

1. Snapshots are labelled as **undo**, with an explicit note that they are lost
   if the computer is lost.
2. External backup is labelled as **the only disaster recovery**, with the date
   of the last one always visible — and worded as *exported*, never *saved to
   disk* (§7).
3. A restore always shows what will be replaced before it does anything.
4. A failed save, a failed migration and a failed restore each say what
   happened and what state the data is now in — never a generic error.
5. Storage usage and quota are visible somewhere the user can find them before
   the disk fills, not after, and `overCeiling` is shown as "snapshots are
   paused" rather than hidden.
6. **The browser origin is named somewhere the user can find it.** This is the
   one in the list that sounds like an implementation detail and is not.

### Why the origin matters enough to be in the product

IndexedDB is scoped to the **browser origin** — scheme, host and port together.
The pilot runs at something like `http://localhost:5173`, and every one of the
following produces a *different origin with a different, empty database*:

- a different port (`5173` → `5174`, which a dev server picks on its own when
  the first port is busy);
- `localhost` versus `127.0.0.1`;
- `http` versus `https`;
- a different browser, or a different profile in the same browser.

In every one of those cases the data is not lost — it is simply somewhere the
page cannot reach, and no web API can reach across that boundary. Working
around browser security is not an option and is not attempted. But the symptom
is indistinguishable from total data loss, and a user who sees an empty
application will not guess that a port number changed.

`describeOrigin()` returns the origin, the database name, the schema version
and the install id as data, so a diagnostics view can show *where this data
lives* next to the warning that an external backup is the only copy that
travels.
