/**
 * Recovery layer 2 — the external portable backup.
 *
 * **This is the only real disaster recovery the pilot has.** The working
 * database and every internal snapshot live in one browser origin on one disk;
 * a dead drive, a wiped profile, a reinstalled operating system or a single
 * click on "clear browsing data" takes all of them at once. A file that has
 * left the origin — ideally the machine — is the only thing that survives
 * that, which is why this module is deliberately not called a snapshot and the
 * snapshot module is deliberately not called a backup.
 *
 * ## No React, no DOM
 *
 * `createBackup()` returns an artifact: the envelope, its canonical JSON text,
 * a filename and a byte length. It touches nothing browser-specific, so the
 * whole backup path is testable without rendering anything. Handing the file
 * to a browser is one small, isolated function in `download.ts`, and the
 * Settings screen that calls it belongs to Phase 9.
 *
 * ## What `lastExternalBackupAt` means, exactly
 *
 * The honest definition, because an over-claimed one would be worse than no
 * timestamp at all:
 *
 * > the last time a complete, checksummed backup file was successfully
 * > generated **and handed to a delivery mechanism that did not fail.**
 *
 * It does **not** mean "the file is on disk". A browser download is initiated,
 * not confirmed: the page is never told whether the user saved the file,
 * cancelled the dialog, or saved it to a folder that is itself on the failing
 * drive. No API available to a web page can close that gap, so the product
 * says what it knows and nothing more. The UI must phrase this as "backup
 * exported", never "backup safely saved".
 *
 * The stamp is therefore written **after** generation and delivery complete —
 * never before, and never on a generation that threw. A failed export leaves
 * the previous timestamp in place, which keeps the staleness warning loud
 * rather than reassuring the user about a backup that does not exist.
 */

import type { Database } from '../persistence/database'
import { META_KEY, parseMetaRecord, type MetaRecord } from '../persistence/records/meta'
import { APP_VERSION, SCHEMA_VERSION } from '../persistence/schema'
import type { DigestProvider } from './checksum'
import {
  BACKUP_STORE_NAMES,
  readBusinessData,
  totalRecords,
  type BackupData,
  type EntityCounts,
} from './businessData'
import {
  backupFilename,
  buildBackupEnvelope,
  serialiseBackupEnvelope,
  type BackupEnvelope,
} from './envelope'
import { utf8ByteLength } from './limits'

/** A generated backup, ready to be written somewhere. */
export interface BackupArtifact {
  readonly envelope: BackupEnvelope
  /** The exact file contents: canonical JSON, UTF-8. */
  readonly json: string
  /** A convenience for the human filing it. Never trusted on the way back in. */
  readonly filename: string
  readonly byteLength: number
  readonly entityCounts: EntityCounts
  readonly totalRecords: number
}

export interface CreateBackupOptions {
  readonly now?: () => string
  readonly appVersion?: string
  readonly digestProvider?: DigestProvider
  readonly filenamePrefix?: string
}

/**
 * Reads the whole business database and produces a complete backup file.
 *
 * Every store is read in **one** readonly transaction, so the payload is one
 * coherent logical state rather than a stitched-together sequence of reads
 * that never coexisted.
 *
 * Creating a backup does not modify a single business record, and does not
 * stamp `lastExternalBackupAt` — generating a file is not the same event as
 * successfully exporting one. `exportBackup()` joins the two.
 */
export async function createBackup(
  database: Database,
  options: CreateBackupOptions = {},
): Promise<BackupArtifact> {
  const now = options.now ?? (() => new Date().toISOString())
  const createdAt = now()

  const data: BackupData = await database.read(BACKUP_STORE_NAMES, readBusinessData)

  // The digest is `crypto.subtle`, which is not an IndexedDB request — so it
  // runs here, after the transaction has committed, and never inside it.
  const envelope = await buildBackupEnvelope({
    data,
    createdAt,
    installId: database.meta.installId,
    schemaVersion: database.schemaVersion,
    // The build that *wrote the file*, which is what a support question asks
    // about — not the build that happened to create the database.
    appVersion: options.appVersion ?? APP_VERSION,
    digestProvider: options.digestProvider,
  })

  const json = serialiseBackupEnvelope(envelope)
  return {
    envelope,
    json,
    filename: backupFilename(createdAt, options.filenamePrefix),
    byteLength: utf8ByteLength(json),
    entityCounts: envelope.entityCounts,
    totalRecords: totalRecords(envelope.entityCounts),
  }
}

/**
 * Stamps `meta.lastExternalBackupAt`.
 *
 * Re-reads and re-validates the stored record inside the transaction rather
 * than writing `database.meta` back: that cached copy was read when the
 * connection opened and would silently revert anything written since.
 */
export async function markExternalBackupCompleted(
  database: Database,
  options: { at: string },
): Promise<MetaRecord> {
  return database.write(['meta'], async (scope) => {
    const stored = await scope.get<unknown>('meta', META_KEY)
    const current = parseMetaRecord(stored)
    const updated: MetaRecord = { ...current, lastExternalBackupAt: options.at }
    await scope.put('meta', updated)
    return updated
  })
}

export interface ExportBackupOptions extends CreateBackupOptions {
  /**
   * Hands the artifact to wherever it is going — a browser download, a file
   * handle, a test spy.
   *
   * If it throws or rejects, the export failed and `lastExternalBackupAt` is
   * **not** stamped. That is the whole reason delivery is a parameter rather
   * than something this function assumes succeeded.
   */
  readonly deliver: (artifact: BackupArtifact) => void | Promise<void>
}

export interface ExportBackupResult {
  readonly artifact: BackupArtifact
  readonly meta: MetaRecord
}

/**
 * Generate → deliver → stamp, in that order and only on success.
 */
export async function exportBackup(
  database: Database,
  options: ExportBackupOptions,
): Promise<ExportBackupResult> {
  const artifact = await createBackup(database, options)
  await options.deliver(artifact)
  const meta = await markExternalBackupCompleted(database, {
    at: artifact.envelope.createdAt,
  })
  return { artifact, meta }
}

/**
 * How long a pilot may go without an external backup before the application
 * starts complaining. Canonical value: 7 days.
 */
export const EXTERNAL_BACKUP_STALE_AFTER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000

export type ExternalBackupState =
  /** No export has ever succeeded. The loudest state, and the correct one. */
  | 'NEVER'
  | 'FRESH'
  | 'STALE'

export interface ExternalBackupStatus {
  readonly state: ExternalBackupState
  readonly lastExternalBackupAt?: string
  readonly ageMs?: number
  /** Whole days since the last export, floored. For a "N days ago" message. */
  readonly ageDays?: number
  readonly staleAfterDays: number
}

/**
 * The backup-freshness state, as data.
 *
 * No string, no icon, no translation key — a machine-readable state a Phase 9
 * screen renders through `src/i18n`. The persistence and backup layers produce
 * codes; user-facing Turkish and English live in exactly one place and this is
 * not it.
 */
export function externalBackupStatus(
  meta: Pick<MetaRecord, 'lastExternalBackupAt'>,
  now: string,
  staleAfterDays = EXTERNAL_BACKUP_STALE_AFTER_DAYS,
): ExternalBackupStatus {
  const last = meta.lastExternalBackupAt
  if (last === undefined) {
    return { state: 'NEVER', staleAfterDays }
  }
  const ageMs = Date.parse(now) - Date.parse(last)
  const ageDays = Math.floor(ageMs / DAY_MS)
  return {
    state: ageMs >= staleAfterDays * DAY_MS ? 'STALE' : 'FRESH',
    lastExternalBackupAt: last,
    ageMs,
    ageDays,
    staleAfterDays,
  }
}

/**
 * True when the user should be warned.
 *
 * "Never exported" counts as stale. It is the state with the most data at
 * risk, and treating it as "not yet due" would mean the warning is quietest
 * exactly when it should be loudest.
 */
export function isExternalBackupStale(
  meta: Pick<MetaRecord, 'lastExternalBackupAt'>,
  now: string,
  staleAfterDays = EXTERNAL_BACKUP_STALE_AFTER_DAYS,
): boolean {
  return externalBackupStatus(meta, now, staleAfterDays).state !== 'FRESH'
}

/**
 * Where this data physically lives, and what makes it disappear.
 *
 * Surfaced as data so a Settings screen can warn without re-deriving it. The
 * pilot runs at `http://localhost:<port>`, and an origin is scheme + host +
 * port: changing the port, the hostname (`localhost` vs `127.0.0.1`), or the
 * protocol produces a **different origin with a different, empty database**.
 * So does a different browser or a different browser profile. The data is not
 * lost in any of those cases — it is simply somewhere this page cannot reach,
 * and no web API can reach across that boundary. Working around browser
 * security is not an option and is not attempted.
 *
 * This is why an external backup file is the only portable copy, and why the
 * origin is worth showing the user before they wonder where their data went.
 */
export interface OriginInfo {
  readonly origin: string
  readonly protocol: string
  readonly host: string
  readonly databaseName: string
  readonly schemaVersion: number
  readonly appVersion: string
  readonly installId: string
}

export function describeOrigin(
  database: Database,
  location?: { origin?: string; protocol?: string; host?: string },
): OriginInfo {
  const source =
    location ?? (globalThis as { location?: { origin?: string; protocol?: string; host?: string } }).location
  return {
    origin: source?.origin ?? 'unknown',
    protocol: source?.protocol ?? 'unknown',
    host: source?.host ?? 'unknown',
    databaseName: database.name,
    schemaVersion: database.schemaVersion,
    appVersion: database.meta.appVersion,
    installId: database.meta.installId,
  }
}

export { SCHEMA_VERSION }
