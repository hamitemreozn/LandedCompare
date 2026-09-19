/**
 * The `counters` store: monotonic sequences behind human-facing document codes
 * (`PO-2026-0007`, `SHP-2026-0031`, …).
 *
 * Phase 7 provides the sequence and its atomicity. **Code formatting, the
 * per-year reset and the moment of allocation belong to the phases that own
 * the documents** (Phase 14 onward) — a counter that already knew how to spell
 * a purchase-order code would be purchasing logic living in the storage layer.
 *
 * Gaps are tolerated by design (Data Model §2): a reserved value whose document
 * is then abandoned is not recycled, because reusing it would let two
 * documents, one of them deleted, have carried the same code.
 */

import { expectInteger, expectNoUnknownKeys, expectNonEmptyString, expectObject, invalidRecord } from '../validation'

export interface CounterRecord {
  readonly key: string
  /** The value the next reservation returns. Starts at 1. */
  readonly nextValue: number
}

export function parseCounterRecord(value: unknown, path = 'counter'): CounterRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['key', 'nextValue'], path)
  const nextValue = expectInteger(record.nextValue, `${path}.nextValue`)
  if (nextValue < 1) {
    throw invalidRecord(`${path}.nextValue`, 'expected a positive integer')
  }
  return { key: expectNonEmptyString(record.key, `${path}.key`), nextValue }
}
