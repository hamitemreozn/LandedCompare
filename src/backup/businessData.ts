/**
 * What a backup covers, and how its records are proven.
 *
 * ## Scope
 *
 * The backup payload is exactly `BUSINESS_STORE_NAMES` from
 * `src/persistence/schema.ts` — every store except `meta` and `snapshots`. The
 * two exclusions are the canonical ones
 * (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §7):
 *
 * - **`snapshots`** because a backup of backups multiplies the file size by
 *   the retention count for no recovery value. A snapshot is a copy of the
 *   same business data the file already contains.
 * - **`meta`** because it describes *this installation* — its `installId`, the
 *   day it was created, when it last exported a backup. Those are facts about
 *   the machine, not about the data, and carrying them into another machine on
 *   a restore would overwrite that machine's identity with a stranger's. The
 *   parts of `meta` a reader genuinely needs (`schemaVersion`, `appVersion`,
 *   `installId` as provenance) travel in the manifest instead, where they are
 *   read as information rather than restored as state.
 *
 * ## The validator registry is the real compatibility boundary
 *
 * Every record in a payload is re-proven with the **same validators the
 * application uses at runtime** — a backup is not a trusted path into the
 * domain. A store this build has no validator for therefore cannot be
 * restored, and a payload carrying records for one is rejected outright rather
 * than written unchecked or silently skipped.
 *
 * That is a deliberate second line behind the `schemaVersion` check. Adding a
 * record type to an already-created store *is* a record-shape change and so
 * bumps `schemaVersion` (§4), which means a newer build's payload is already
 * refused one step earlier. This registry makes the refusal hold even if that
 * rule is ever broken by accident, which is the kind of mistake that otherwise
 * surfaces as a half-restored database.
 */

import { PersistenceError } from '../persistence/errors'
import type { TransactionScope } from '../persistence/idb'
import { BUSINESS_STORE_NAMES, type StoreName } from '../persistence/schema'
import { parseCounterRecord } from '../persistence/records/counter'
import { parseInventoryMovementRecord } from '../persistence/records/inventoryMovement'
import { parseProjectRecord } from '../persistence/records/project'
import { parseSettingRecord } from '../persistence/records/settings'
import { parseSupplierRecord } from '../persistence/records/supplier'
import {
  canonicalizationFailure,
  forbiddenKeyFailure,
  isForbiddenKey,
  isPlainObject,
} from './canonicalJson'
import { BackupError } from './errors'
import { MAX_JSON_DEPTH, MAX_RECORDS_PER_STORE, MAX_TOTAL_RECORDS } from './limits'

/** Every store a backup covers. `meta` and `snapshots` are excluded by name. */
export type BusinessStoreName = Exclude<StoreName, 'meta' | 'snapshots'>

/**
 * The backed-up stores, in a fixed order.
 *
 * Derived from `BUSINESS_STORE_NAMES` rather than retyped, so a store added to
 * the schema is covered by the backup without anyone remembering to add it
 * here. The cast narrows what `Array.prototype.filter` could not.
 */
export const BACKUP_STORE_NAMES = BUSINESS_STORE_NAMES as readonly BusinessStoreName[]

/** Store name → its records, exactly as they are stored. */
export type BackupData = Readonly<Record<BusinessStoreName, readonly unknown[]>>

export type EntityCounts = Readonly<Record<BusinessStoreName, number>>

type RecordParser = (value: unknown, path: string) => unknown

/**
 * The validators this build can prove a record with.
 *
 * Stores absent from this map exist in the schema (Phase 7 created every store
 * up front) but have no record type yet — their entities arrive with the phase
 * that owns them. Until then they hold nothing, and a payload claiming
 * otherwise is refused.
 */
const RECORD_PARSERS: Partial<Record<BusinessStoreName, RecordParser>> = {
  settings: parseSettingRecord,
  counters: parseCounterRecord,
  suppliers: parseSupplierRecord,
  projects: parseProjectRecord,
  inventoryMovements: parseInventoryMovementRecord,
}

/** The stores whose records this build can validate, and therefore restore. */
export const VALIDATED_STORE_NAMES: readonly BusinessStoreName[] = BACKUP_STORE_NAMES.filter(
  (store) => RECORD_PARSERS[store] !== undefined,
)

/** `keyPath` per store, mirroring `STORE_DEFINITIONS`. Used to detect duplicates. */
const KEY_PATHS: Record<BusinessStoreName, string> = {
  settings: 'key',
  counters: 'key',
  products: 'id',
  suppliers: 'id',
  customers: 'id',
  projects: 'id',
  purchaseOrders: 'id',
  inboundShipments: 'id',
  warehouseReceipts: 'id',
  inventoryMovements: 'id',
  inventoryReservations: 'id',
  outboundShipments: 'id',
}

export function isBusinessStoreName(value: string): value is BusinessStoreName {
  return (BACKUP_STORE_NAMES as readonly string[]).includes(value)
}

export function emptyBackupData(): BackupData {
  const data: Record<string, readonly unknown[]> = {}
  for (const store of BACKUP_STORE_NAMES) {
    data[store] = []
  }
  return data as BackupData
}

export function countEntities(data: BackupData): EntityCounts {
  const counts: Record<string, number> = {}
  for (const store of BACKUP_STORE_NAMES) {
    counts[store] = data[store].length
  }
  return counts as EntityCounts
}

export function totalRecords(counts: EntityCounts): number {
  return BACKUP_STORE_NAMES.reduce((sum, store) => sum + counts[store], 0)
}

/**
 * Reads every backed-up store inside the caller's transaction.
 *
 * Taking a `TransactionScope` rather than a `Database` is the whole point: the
 * caller opens **one** transaction over all of these stores, so the result is
 * one coherent logical state. Reading store A, returning to the event loop,
 * and then reading store B would produce a payload that never existed — a
 * project referring to a supplier saved after the projects were read, or a
 * receipt without the movements it posted.
 *
 * Records come back in primary-key order, which `getAll` guarantees and which
 * makes the payload — and therefore the checksum — reproducible.
 */
export async function readBusinessData(scope: TransactionScope): Promise<BackupData> {
  const data: Record<string, readonly unknown[]> = {}
  for (const store of BACKUP_STORE_NAMES) {
    // Normalised on the way out, so a payload never carries an explicit
    // `undefined` no matter how the record was written — and so a stored value
    // this format cannot represent stops the backup here, loudly, instead of
    // being flattened into something that checksums cleanly and means nothing.
    // See `normaliseStoredValue`.
    data[store] = normaliseStoredValue(await scope.getAll<unknown>(store), store)
  }
  return data as BackupData
}

/**
 * The one normalisation the backup boundary is allowed to perform, and the
 * rejection of everything else.
 *
 * ## The single thing it normalises
 *
 * An absent optional field is represented by the key *not existing* — the rule
 * `records/project.ts` states and enforces with its own `withoutUndefined` on
 * the write path. But the Phase 7 *read* path reintroduces the key:
 * `optional()` returns `undefined`, so `parseSupplierRecord({…})` yields
 * `{ …, note: undefined }`, structured clone preserves that own property, and
 * `putSupplierRecord`/`putX` write it straight back into the store.
 *
 * Two consequences a backup cannot live with:
 *
 * 1. `canonicalize()` rejects `undefined` — deliberately, because it has no
 *    reproducible JSON form — so a payload carrying one could not be
 *    checksummed at all.
 * 2. A record that went through a restore would come back with a key the
 *    record it was taken from did not have, so `backup → restore → backup`
 *    would not be a fixed point.
 *
 * So a **plain-object property whose value is exactly `undefined` is omitted**.
 * That is the whole licence, and it is bounded on purpose.
 *
 * ## Why everything else is refused instead of converted
 *
 * The obvious generalisation — "walk the value and tidy it up" — is how this
 * function was originally written, and it was silently destructive. A `Date`
 * has no own enumerable properties, so copying its entries produced `{}`. So
 * did a `Map`, a `Set`, a `RegExp` and an `ArrayBuffer`. A `Uint8Array` became
 * `{ "0": 12, "1": 7 }`. Each of those is a **valid IndexedDB value**: the
 * store accepts it, structured clone preserves it, and it reads back intact.
 * The damage happened here, on the way out — and it happened *before*
 * `canonicalize()` could object, because by then there was nothing left to
 * object to. The payload checksummed cleanly, the backup file was written, the
 * restore succeeded, and the value was gone. A successful, verified artifact
 * with the data quietly removed is strictly worse than a failed one.
 *
 * Hence: this function transforms nothing it does not understand. It enforces
 * exactly the table in `canonicalJson.ts` — plain objects and arrays of
 * strings, finite numbers, booleans and `null`, and nothing else — using that
 * module's own predicates and its own failure, so the two boundaries cannot
 * drift into disagreeing about what is serialisable.
 *
 * | Input | Treatment |
 * | --- | --- |
 * | plain object | recursed; a property whose value is `undefined` is omitted |
 * | array | recursed; **order and length preserved**, an `undefined` element rejected |
 * | `string`, `boolean`, finite `number`, `null` | kept as they are |
 * | `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, typed array | rejected |
 * | `Money`, `Quantity`, any class instance | rejected |
 * | `undefined` inside an array | rejected — length and order are data |
 * | functions, symbols, `bigint`, `NaN`, `±Infinity` | rejected |
 * | cycles | rejected |
 * | `__proto__` / `constructor` / `prototype` keys | rejected |
 *
 * An array is the case worth spelling out. Dropping an `undefined` element
 * would renumber every element after it, so a list of three quote lines would
 * come back as two with different indices — a different document, restored
 * without complaint. Order and length are data, and data is not normalised.
 */
export function normaliseStoredValue<T>(value: T, path = '$'): T {
  return normalise(value, path, 0, new Set<object>()) as T
}

function normalise(value: unknown, path: string, depth: number, ancestors: Set<object>): unknown {
  if (depth > MAX_JSON_DEPTH) {
    throw new BackupError(
      'BACKUP_TOO_DEEP',
      `Value at "${path}" nests deeper than ${MAX_JSON_DEPTH} levels`,
      { details: { path, maxDepth: MAX_JSON_DEPTH } },
    )
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw canonicalizationFailure(path, 'expected a finite number')
      }
      return value
    case 'undefined':
      throw canonicalizationFailure(path, 'undefined has no canonical form; omit the key instead')
    case 'function':
      throw canonicalizationFailure(path, 'functions are not data')
    case 'symbol':
      throw canonicalizationFailure(path, 'symbols are not data')
    case 'bigint':
      throw canonicalizationFailure(path, 'bigint has no JSON form')
    default:
      break
  }

  if (value === null) {
    return null
  }

  const object = value as object
  if (ancestors.has(object)) {
    throw canonicalizationFailure(path, 'cyclic reference')
  }
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      // Indexed rather than `map`, so a hole in a sparse array is seen as the
      // `undefined` it reads back as instead of being copied through as a hole.
      const items = new Array<unknown>(value.length)
      for (let index = 0; index < value.length; index += 1) {
        const item: unknown = value[index]
        if (item === undefined) {
          throw canonicalizationFailure(
            `${path}[${index}]`,
            'an array element may not be undefined; length and order are data',
          )
        }
        items[index] = normalise(item, `${path}[${index}]`, depth + 1, ancestors)
      }
      return items
    }

    if (!isPlainObject(object)) {
      throw canonicalizationFailure(
        path,
        'expected a plain object; class instances and built-ins are never serialised',
      )
    }

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(object)) {
      if (isForbiddenKey(key)) {
        // Rejected before the assignment, not after: writing `result.__proto__`
        // would invoke the prototype setter rather than create a property.
        throw forbiddenKeyFailure(path, key)
      }
      const child: unknown = (object as Record<string, unknown>)[key]
      if (child === undefined) {
        continue
      }
      result[key] = normalise(child, `${path}.${key}`, depth + 1, ancestors)
    }
    return result
  } finally {
    ancestors.delete(object)
  }
}

function recordKey(store: BusinessStoreName, record: unknown, index: number): string {
  const keyPath = KEY_PATHS[store]
  const value = (record as Record<string, unknown>)[keyPath]
  if (typeof value !== 'string') {
    throw new BackupError(
      'BACKUP_RECORD_INVALID',
      `Record ${index} of "${store}" has no usable "${keyPath}"`,
      { details: { store, index, keyPath } },
    )
  }
  return value
}

export interface ValidateBackupDataOptions {
  readonly maxRecordsPerStore?: number
  readonly maxTotalRecords?: number
}

/**
 * Proves an untrusted payload, store by store and record by record.
 *
 * Returns the **parsed** records rather than the input ones. That is not a
 * formality: each parser rebuilds the record field by field from validated
 * values, so what comes out has no unknown keys, no inherited properties and
 * no prototype the input could have chosen. Nothing here spreads, assigns or
 * casts an untrusted object into a stored one.
 *
 * Duplicate primary keys are caught here, before any write, so a payload that
 * would have collided mid-transaction is refused while the working database is
 * still untouched.
 */
export function validateBackupData(
  raw: Readonly<Record<string, readonly unknown[]>>,
  options: ValidateBackupDataOptions = {},
): BackupData {
  const maxPerStore = options.maxRecordsPerStore ?? MAX_RECORDS_PER_STORE
  const maxTotal = options.maxTotalRecords ?? MAX_TOTAL_RECORDS

  for (const store of Object.keys(raw)) {
    if (!isBusinessStoreName(store)) {
      throw new BackupError('BACKUP_ENVELOPE_INVALID', `Unknown store "${store}" in backup data`, {
        details: { store },
      })
    }
  }

  let total = 0
  const validated: Record<string, readonly unknown[]> = {}

  for (const store of BACKUP_STORE_NAMES) {
    const records = raw[store]
    if (!Array.isArray(records)) {
      throw new BackupError(
        'BACKUP_ENVELOPE_INVALID',
        `Backup data is missing an array for store "${store}"`,
        { details: { store } },
      )
    }
    if (records.length > maxPerStore) {
      throw new BackupError(
        'BACKUP_TOO_LARGE',
        `Store "${store}" carries more records than the pilot limit allows`,
        { details: { store, count: records.length, maxRecordsPerStore: maxPerStore } },
      )
    }
    total += records.length
    if (total > maxTotal) {
      throw new BackupError('BACKUP_TOO_LARGE', 'Backup carries more records than the pilot limit allows', {
        details: { count: total, maxTotalRecords: maxTotal },
      })
    }

    const parse = RECORD_PARSERS[store]
    if (parse === undefined) {
      if (records.length > 0) {
        throw new BackupError(
          'BACKUP_STORE_UNSUPPORTED',
          `This build cannot validate records for store "${store}", so it refuses to restore them`,
          { details: { store, count: records.length } },
        )
      }
      validated[store] = []
      continue
    }

    const seen = new Set<string>()
    const parsed = records.map((record, index) => {
      const path = `${store}[${index}]`
      let value: unknown
      try {
        value = parse(record, path)
      } catch (cause) {
        const reason = cause instanceof PersistenceError ? cause.details.reason : undefined
        throw new BackupError('BACKUP_RECORD_INVALID', `Backup record ${path} is invalid`, {
          details: {
            store,
            index,
            path,
            ...(typeof reason === 'string' ? { reason } : {}),
          },
          cause,
        })
      }
      // The parsers re-add absent optional fields as explicit `undefined`;
      // the record that gets written must have exactly the keys it had.
      value = normaliseStoredValue(value, path)
      const key = recordKey(store, value, index)
      if (seen.has(key)) {
        throw new BackupError(
          'BACKUP_RECORD_INVALID',
          `Store "${store}" carries two records with the key "${key}"`,
          { details: { store, index, key } },
        )
      }
      seen.add(key)
      return value
    })
    validated[store] = parsed
  }

  return validated as BackupData
}
