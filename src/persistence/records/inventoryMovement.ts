/**
 * The `inventoryMovements` store: the append-only stock ledger.
 *
 * **Scope warning.** Phase 7 owns the *record shape and its storage
 * semantics*; Phase 13 owns the ledger's business behaviour. So this file
 * defines the enums, the structural validation and the append-only contract,
 * and deliberately implements none of the following: stock derivation
 * (`physicalStock`, `reservedStock`, …), reversal matching (invariant I10), the
 * `movement.unit === product.stockUnit` check (I11), or any rule about which
 * document may post which type (I7). Those need the catalog and the documents,
 * which do not exist yet, and guessing at them here would mean Phase 13
 * inherits half-rules it has to find before it can replace them.
 *
 * What this phase does guarantee is that the storage layer cannot make an
 * append-only ledger impossible later: a movement is written with `add()`, not
 * `put()`, so re-writing an existing id fails, and no update or delete
 * operation is exposed for this store at all (Data Model R3, I9).
 */

import {
  expectDecimalString,
  expectEnum,
  expectInstant,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectString,
  expectUuid,
  invalidRecord,
  optional,
} from '../validation'
import type { QuantitySnapshot } from '../../domain/quantity/Quantity'

export const MOVEMENT_TYPES = [
  'OPENING_BALANCE',
  'PURCHASE_RECEIPT',
  'CUSTOMER_DISPATCH',
  'CUSTOMER_RETURN',
  'SUPPLIER_RETURN',
  'POSITIVE_ADJUSTMENT',
  'NEGATIVE_ADJUSTMENT',
] as const
export type MovementType = (typeof MOVEMENT_TYPES)[number]

export const MOVEMENT_DIRECTIONS = ['IN', 'OUT'] as const
export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number]

export const ADJUSTMENT_REASONS = ['STOCK_COUNT', 'DAMAGE', 'LOSS', 'CORRECTION', 'OTHER'] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

export const SOURCE_KINDS = ['WAREHOUSE_RECEIPT', 'OUTBOUND_SHIPMENT', 'MANUAL', 'OPENING'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export interface MovementSource {
  readonly kind: SourceKind
  readonly id?: string
}

export interface InventoryMovementRecord {
  readonly id: string
  readonly productId: string
  readonly type: MovementType
  readonly direction: MovementDirection
  /**
   * A magnitude, always greater than zero — never a signed number. The audited
   * `Quantity` type rejects negatives by construction, and introducing a second
   * sign-permitting quantity next to it would be the start of two quantity
   * models. Every stock query is `Σ(IN) − Σ(OUT)` instead (Data Model §9).
   */
  readonly quantity: QuantitySnapshot
  /** Must equal the product's `stockUnit`. Enforced in Phase 13 (I11). */
  readonly unit: string
  /** When it physically happened. */
  readonly occurredAt: string
  /** When the row was written. Differs whenever anything is entered late. */
  readonly recordedAt: string
  readonly source: MovementSource
  readonly reason?: AdjustmentReason
  readonly reversalOfMovementId?: string
  readonly note?: string
}

const KNOWN_KEYS = [
  'id',
  'productId',
  'type',
  'direction',
  'quantity',
  'unit',
  'occurredAt',
  'recordedAt',
  'source',
  'reason',
  'reversalOfMovementId',
  'note',
]

function parseSource(value: unknown, path: string): MovementSource {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['kind', 'id'], path)
  return {
    kind: expectEnum(record.kind, `${path}.kind`, SOURCE_KINDS),
    id: optional(record.id, `${path}.id`, expectUuid),
  }
}

function parsePositiveQuantity(value: unknown, path: string): QuantitySnapshot {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['value'], path)
  const amount = expectDecimalString(record.value, `${path}.value`)
  if (amount.startsWith('-') || /^0(\.0+)?$/.test(amount)) {
    throw invalidRecord(`${path}.value`, 'expected a magnitude greater than zero')
  }
  return { value: amount }
}

export function parseInventoryMovementRecord(
  value: unknown,
  path = 'inventoryMovement',
): InventoryMovementRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, KNOWN_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    productId: expectUuid(record.productId, `${path}.productId`),
    type: expectEnum(record.type, `${path}.type`, MOVEMENT_TYPES),
    direction: expectEnum(record.direction, `${path}.direction`, MOVEMENT_DIRECTIONS),
    quantity: parsePositiveQuantity(record.quantity, `${path}.quantity`),
    unit: expectNonEmptyString(record.unit, `${path}.unit`),
    occurredAt: expectInstant(record.occurredAt, `${path}.occurredAt`),
    recordedAt: expectInstant(record.recordedAt, `${path}.recordedAt`),
    source: parseSource(record.source, `${path}.source`),
    reason: optional(record.reason, `${path}.reason`, (raw, at) =>
      expectEnum(raw, at, ADJUSTMENT_REASONS),
    ),
    reversalOfMovementId: optional(
      record.reversalOfMovementId,
      `${path}.reversalOfMovementId`,
      expectUuid,
    ),
    note: optional(record.note, `${path}.note`, expectString),
  }
}
