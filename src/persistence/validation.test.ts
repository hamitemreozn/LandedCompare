import { describe, expect, it } from 'vitest'
import { isPersistenceError, type PersistenceError } from './errors'
import { parseMetaRecord } from './records/meta'
import { parseProjectRecord } from './records/project'
import { parseSupplierRecord } from './records/supplier'
import { parseSettingRecord } from './records/settings'
import { parseCounterRecord } from './records/counter'
import {
  expectBusinessDate,
  expectDecimalString,
  expectEnum,
  expectInstant,
  expectObject,
  expectUuid,
  optional,
} from './validation'
import { TEST_INSTANT, testUuid } from './testSupport'

function codeOf(operation: () => unknown): string {
  try {
    operation()
  } catch (error) {
    if (isPersistenceError(error)) {
      return (error as PersistenceError).code
    }
    throw error
  }
  throw new Error('Expected the validator to reject the value')
}

describe('structural validators', () => {
  it('rejects a non-object where a record is expected', () => {
    expect(codeOf(() => expectObject('nope', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectObject(null, 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectObject([], 'x'))).toBe('RECORD_INVALID')
  })

  it('rejects a record carrying a prototype-polluting key', () => {
    const hostile = JSON.parse('{"id":"a","__proto__":{"polluted":true}}') as unknown
    expect(codeOf(() => expectObject(hostile, 'x'))).toBe('RECORD_INVALID')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects "constructor" and "prototype" as own keys', () => {
    for (const key of ['constructor', 'prototype']) {
      const record = Object.defineProperty({}, key, { value: 1, enumerable: true })
      expect(codeOf(() => expectObject(record, 'x'))).toBe('RECORD_INVALID')
    }
  })

  it('separates instants from business dates', () => {
    expect(expectInstant(TEST_INSTANT, 'x')).toBe(TEST_INSTANT)
    expect(codeOf(() => expectInstant('2026-09-19', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectInstant('2026-09-19T12:00:00Z', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectInstant('not a date', 'x'))).toBe('RECORD_INVALID')

    expect(expectBusinessDate('2026-09-19', 'x')).toBe('2026-09-19')
    expect(codeOf(() => expectBusinessDate(TEST_INSTANT, 'x'))).toBe('RECORD_INVALID')
  })

  it('accepts only canonical decimal strings', () => {
    expect(expectDecimalString('0', 'x')).toBe('0')
    expect(expectDecimalString('-1234.5678', 'x')).toBe('-1234.5678')
    // Exponential notation cannot have been written by Money/Quantity, which
    // serialise through toFixed(); accepting it would break the exact round trip.
    expect(codeOf(() => expectDecimalString('1e3', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectDecimalString('12.34.56', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectDecimalString(12.34, 'x'))).toBe('RECORD_INVALID')
  })

  it('rejects an unknown enum value rather than passing it through', () => {
    expect(expectEnum('IN', 'x', ['IN', 'OUT'] as const)).toBe('IN')
    expect(codeOf(() => expectEnum('SIDEWAYS', 'x', ['IN', 'OUT'] as const))).toBe('RECORD_INVALID')
  })

  it('requires ids to be UUIDs, never array positions or counters', () => {
    expect(expectUuid(testUuid(1), 'x')).toBe(testUuid(1))
    expect(codeOf(() => expectUuid('supplier-1', 'x'))).toBe('RECORD_INVALID')
    expect(codeOf(() => expectUuid('3', 'x'))).toBe('RECORD_INVALID')
  })

  it('treats undefined as absent but null as invalid', () => {
    expect(optional(undefined, 'x', expectInstant)).toBeUndefined()
    expect(codeOf(() => optional(null, 'x', expectInstant))).toBe('RECORD_INVALID')
  })
})

describe('record validators reject data this build cannot interpret', () => {
  const validMeta = {
    key: 'meta',
    schemaVersion: 1,
    appVersion: '0.7.0',
    installId: testUuid(1),
    createdAt: TEST_INSTANT,
  }

  it('accepts a well-formed meta record', () => {
    expect(parseMetaRecord(validMeta).schemaVersion).toBe(1)
  })

  it('rejects a meta record with an unknown field', () => {
    expect(codeOf(() => parseMetaRecord({ ...validMeta, experiment: true }))).toBe('RECORD_INVALID')
  })

  it('rejects a meta record whose version is not an integer', () => {
    expect(codeOf(() => parseMetaRecord({ ...validMeta, schemaVersion: '1' }))).toBe(
      'RECORD_INVALID',
    )
    expect(codeOf(() => parseMetaRecord({ ...validMeta, schemaVersion: 1.5 }))).toBe(
      'RECORD_INVALID',
    )
  })

  it('rejects a supplier record missing a required field', () => {
    expect(
      codeOf(() =>
        parseSupplierRecord({
          id: testUuid(2),
          displayName: 'Alpha',
          createdAt: TEST_INSTANT,
          updatedAt: TEST_INSTANT,
        }),
      ),
    ).toBe('RECORD_INVALID')
  })

  it('rejects a project record whose money amount became a number', () => {
    const record = {
      id: testUuid(3),
      name: 'Project',
      baseCurrency: 'EUR',
      createdAt: TEST_INSTANT,
      updatedAt: TEST_INSTANT,
      supplierIds: [testUuid(4)],
      requirements: [],
      quotes: [
        {
          id: testUuid(5),
          supplierId: testUuid(4),
          currency: 'EUR',
          items: [
            {
              id: testUuid(6),
              requirementId: testUuid(7),
              quotedUnitPrice: { amount: 12.34, currency: 'EUR' },
              quotedUnit: 'pcs',
            },
          ],
        },
      ],
    }
    expect(codeOf(() => parseProjectRecord(record))).toBe('RECORD_INVALID')
  })

  it('names the exact path of the invalid field', () => {
    try {
      parseProjectRecord({
        id: testUuid(3),
        name: 'Project',
        baseCurrency: 'eur',
        createdAt: TEST_INSTANT,
        updatedAt: TEST_INSTANT,
        supplierIds: [],
        requirements: [],
        quotes: [],
      })
      throw new Error('expected rejection')
    } catch (error) {
      expect(isPersistenceError(error)).toBe(true)
      expect((error as PersistenceError).details.path).toBe('project.baseCurrency')
    }
  })

  it('rejects settings values that are neither string, finite number nor boolean', () => {
    expect(parseSettingRecord({ key: 'locale', value: 'tr' }).value).toBe('tr')
    expect(codeOf(() => parseSettingRecord({ key: 'locale', value: Number.NaN }))).toBe(
      'RECORD_INVALID',
    )
    expect(codeOf(() => parseSettingRecord({ key: 'locale', value: { nested: true } }))).toBe(
      'RECORD_INVALID',
    )
  })

  it('rejects a counter that has gone below its starting value', () => {
    expect(parseCounterRecord({ key: 'PO', nextValue: 1 }).nextValue).toBe(1)
    expect(codeOf(() => parseCounterRecord({ key: 'PO', nextValue: 0 }))).toBe('RECORD_INVALID')
  })
})
