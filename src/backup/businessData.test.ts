/**
 * Backup scope and payload validation, at the unit level.
 *
 * The scope rules are worth testing directly because they are the kind of
 * thing that drifts silently: a store added to the schema and forgotten by the
 * backup would be discovered on the day someone restores and finds it empty.
 */

import { describe, expect, it } from 'vitest'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { BUSINESS_STORE_NAMES, STORE_NAMES } from '../persistence/schema'
import { testUuid } from '../persistence/testSupport'
import { canonicalize } from './canonicalJson'
import {
  BACKUP_STORE_NAMES,
  VALIDATED_STORE_NAMES,
  countEntities,
  emptyBackupData,
  isBusinessStoreName,
  totalRecords,
  validateBackupData,
  normaliseStoredValue,
} from './businessData'
import { BackupError } from './errors'
import { movementRecord, projectRecord, supplierRecord } from './testSupport'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (cause) {
    return cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  return 'did-not-throw'
}

function dataWith(overrides: Record<string, readonly unknown[]>) {
  return { ...emptyBackupData(), ...overrides }
}

describe('backup scope', () => {
  it('covers every store except meta and snapshots', () => {
    expect([...BACKUP_STORE_NAMES].sort()).toEqual([...BUSINESS_STORE_NAMES].sort())
    expect(BACKUP_STORE_NAMES).not.toContain('meta')
    expect(BACKUP_STORE_NAMES).not.toContain('snapshots')
  })

  it('is derived from the schema, so a new store is covered without being listed twice', () => {
    const expected = STORE_NAMES.filter((name) => name !== 'meta' && name !== 'snapshots')
    expect([...BACKUP_STORE_NAMES]).toEqual([...expected])
  })

  it('knows which stores this build can actually validate', () => {
    expect([...VALIDATED_STORE_NAMES].sort()).toEqual(
      ['counters', 'inventoryMovements', 'projects', 'settings', 'suppliers'].sort(),
    )
  })

  it('recognises store names and rejects invented ones', () => {
    expect(isBusinessStoreName('suppliers')).toBe(true)
    expect(isBusinessStoreName('snapshots')).toBe(false)
    expect(isBusinessStoreName('meta')).toBe(false)
    expect(isBusinessStoreName('invoices')).toBe(false)
  })

  it('counts every store, zeros included', () => {
    const counts = countEntities(dataWith({ suppliers: [supplierRecord(1)] }))
    expect(Object.keys(counts).sort()).toEqual([...BACKUP_STORE_NAMES].sort())
    expect(counts.suppliers).toBe(1)
    expect(counts.products).toBe(0)
    expect(totalRecords(counts)).toBe(1)
  })
})

/**
 * The normalisation contract, both halves of it.
 *
 * The first block is the licence: a plain-object property whose value is
 * exactly `undefined` may be omitted. The second is the far more important
 * half — everything this boundary must refuse rather than quietly convert.
 *
 * That half exists because the original implementation converted. A `Date`
 * became `{}`. So did a `Map`, a `Set`, a `RegExp` and an `ArrayBuffer`. A
 * `Uint8Array` became an object with numeric keys. Every one of those is a
 * value IndexedDB stores and reads back intact, so the loss happened here, on
 * the way into a payload — and `canonicalize()` could not object afterwards
 * because there was nothing left to object to. The result was a checksummed
 * backup file that had silently thrown data away.
 */
describe('normaliseStoredValue — what it may normalise', () => {
  it('drops an absent optional field rather than storing it as undefined', () => {
    const cleaned = normaliseStoredValue({ id: 'a', note: undefined, active: true })
    expect(Object.keys(cleaned)).toEqual(['id', 'active'])
    expect('note' in cleaned).toBe(false)
  })

  it('drops an absent optional field nested inside another plain object', () => {
    const cleaned = normaliseStoredValue({
      quote: { id: 'q', notes: undefined, item: { id: 'i', moq: undefined, unit: 'pcs' } },
    })
    expect(cleaned).toEqual({ quote: { id: 'q', item: { id: 'i', unit: 'pcs' } } })
    expect('notes' in cleaned.quote).toBe(false)
    expect('moq' in cleaned.quote.item).toBe(false)
  })

  it('reaches into arrays of plain objects', () => {
    const cleaned = normaliseStoredValue({
      quotes: [{ id: 'q', notes: undefined, items: [{ id: 'i', moq: undefined, unit: 'pcs' }] }],
    })
    expect(cleaned).toEqual({ quotes: [{ id: 'q', items: [{ id: 'i', unit: 'pcs' }] }] })
  })

  it('preserves array order and length exactly', () => {
    const input = ['c', 'a', 'b', 'a']
    expect(normaliseStoredValue(input)).toEqual(['c', 'a', 'b', 'a'])

    const records = [{ id: '3' }, { id: '1' }, { id: '2' }]
    expect(normaliseStoredValue(records).map((record) => record.id)).toEqual(['3', '1', '2'])
  })

  it('keeps null, false, zero and the empty string', () => {
    expect(normaliseStoredValue({ a: null, b: false, c: 0, d: '' })).toEqual({
      a: null,
      b: false,
      c: 0,
      d: '',
    })
  })

  it('returns a rebuilt value rather than the input object', () => {
    const input = { id: 'a', nested: { b: 1 } }
    const cleaned = normaliseStoredValue(input)
    expect(cleaned).toEqual(input)
    expect(cleaned).not.toBe(input)
    expect(cleaned.nested).not.toBe(input.nested)
  })
})

describe('normaliseStoredValue — what it must refuse', () => {
  class Widget {
    readonly id: string
    constructor(id: string) {
      this.id = id
    }
  }

  it('rejects an undefined array element instead of removing it', () => {
    // Removing it would renumber everything after it: three quote lines would
    // come back as two, at different indices, with nothing reported.
    expect(codeOf(() => normaliseStoredValue({ items: ['a', undefined, 'b'] }))).toBe(
      'CANONICALIZATION_FAILED',
    )
    expect(codeOf(() => normaliseStoredValue([undefined]))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects a hole in a sparse array, which reads back as undefined', () => {
    const sparse = ['a', 'b']
    sparse.length = 4
    expect(codeOf(() => normaliseStoredValue(sparse))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects a Date instead of turning it into {}', () => {
    expect(codeOf(() => normaliseStoredValue({ at: new Date('2026-09-19T12:00:00Z') }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a Map instead of turning it into {}', () => {
    expect(codeOf(() => normaliseStoredValue({ m: new Map([['a', 1]]) }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a Set instead of turning it into {}', () => {
    expect(codeOf(() => normaliseStoredValue({ s: new Set([1, 2]) }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a RegExp instead of turning it into {}', () => {
    expect(codeOf(() => normaliseStoredValue({ r: /abc/g }))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects an ArrayBuffer instead of turning it into {}', () => {
    expect(codeOf(() => normaliseStoredValue({ b: new ArrayBuffer(8) }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a typed array instead of turning it into numeric keys', () => {
    expect(codeOf(() => normaliseStoredValue({ b: new Uint8Array([12, 7]) }))).toBe(
      'CANONICALIZATION_FAILED',
    )
    expect(codeOf(() => normaliseStoredValue({ b: new Float64Array([1.5]) }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a Money instance, because the persisted contract is the decimal string', () => {
    const money = Money.fromString('3.335', 'EUR')
    expect(codeOf(() => normaliseStoredValue({ price: money }))).toBe('CANONICALIZATION_FAILED')
    // The plain shape the records actually store is accepted, unchanged.
    expect(normaliseStoredValue({ price: { amount: '3.335', currency: 'EUR' } })).toEqual({
      price: { amount: '3.335', currency: 'EUR' },
    })
  })

  it('rejects a Quantity instance for the same reason', () => {
    const quantity = Quantity.fromString('12.345')
    expect(codeOf(() => normaliseStoredValue({ q: quantity }))).toBe('CANONICALIZATION_FAILED')
    expect(normaliseStoredValue({ q: { value: '12.345' } })).toEqual({ q: { value: '12.345' } })
  })

  it('rejects an arbitrary class instance', () => {
    expect(codeOf(() => normaliseStoredValue({ w: new Widget('a') }))).toBe(
      'CANONICALIZATION_FAILED',
    )
    expect(codeOf(() => normaliseStoredValue(new Widget('a')))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects a class instance buried inside an array', () => {
    expect(codeOf(() => normaliseStoredValue({ items: [{ ok: 1 }, { at: new Date() }] }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects functions, symbols and bigint', () => {
    expect(codeOf(() => normaliseStoredValue({ f: () => 1 }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => normaliseStoredValue({ s: Symbol('x') }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => normaliseStoredValue({ n: 1n }))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects NaN and the infinities, which JSON would turn into null', () => {
    expect(codeOf(() => normaliseStoredValue({ n: Number.NaN }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => normaliseStoredValue({ n: Number.POSITIVE_INFINITY }))).toBe(
      'CANONICALIZATION_FAILED',
    )
    expect(codeOf(() => normaliseStoredValue({ n: Number.NEGATIVE_INFINITY }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects a cycle rather than recursing forever', () => {
    const cyclic: Record<string, unknown> = { id: 'a' }
    cyclic.self = cyclic
    expect(codeOf(() => normaliseStoredValue(cyclic))).toBe('CANONICALIZATION_FAILED')

    const viaArray: Record<string, unknown> = { id: 'a' }
    viaArray.items = [viaArray]
    expect(codeOf(() => normaliseStoredValue(viaArray))).toBe('CANONICALIZATION_FAILED')
  })

  it('accepts the same value appearing twice, which is sharing, not a cycle', () => {
    const shared = { unit: 'pcs' }
    expect(normaliseStoredValue({ a: shared, b: shared })).toEqual({
      a: { unit: 'pcs' },
      b: { unit: 'pcs' },
    })
  })

  it('rejects a prototype-polluting key rather than assigning it', () => {
    const hostile = JSON.parse('{"id":"a","__proto__":{"isAdmin":true}}') as Record<string, unknown>
    expect(codeOf(() => normaliseStoredValue(hostile))).toBe('BACKUP_FORBIDDEN_KEY')
    expect(codeOf(() => normaliseStoredValue({ constructor: { x: 1 } }))).toBe(
      'BACKUP_FORBIDDEN_KEY',
    )
    expect(codeOf(() => normaliseStoredValue({ prototype: { x: 1 } }))).toBe('BACKUP_FORBIDDEN_KEY')
    expect(Object.prototype).not.toHaveProperty('isAdmin')
  })

  it('names the path of the value it refused', () => {
    try {
      normaliseStoredValue({ quotes: [{ items: [{ at: new Date() }] }] }, 'projects[0]')
      throw new Error('expected a rejection')
    } catch (cause) {
      expect(cause).toBeInstanceOf(BackupError)
      expect((cause as BackupError).details.path).toBe('projects[0].quotes[0].items[0].at')
    }
  })

  it('agrees with canonicalize: anything it accepts, canonicalize can serialise', () => {
    const accepted = [
      { id: 'a', note: undefined, tags: ['x', 'y'], nested: { n: 0, ok: false, none: null } },
      [],
      [{ a: 1 }, { a: 2 }],
      'plain string',
      42,
      null,
    ]
    for (const value of accepted) {
      const normalised = normaliseStoredValue(value)
      expect(() => canonicalize(normalised)).not.toThrow()
    }
  })
})

describe('validateBackupData', () => {
  it('returns records rebuilt by the parsers, not the input objects', () => {
    const input = supplierRecord(1)
    const validated = validateBackupData(dataWith({ suppliers: [input] }))
    expect(validated.suppliers[0]).toEqual(input)
    expect(validated.suppliers[0]).not.toBe(input)
  })

  it('validates an embedded aggregate all the way down', () => {
    const suppliers = [supplierRecord(1), supplierRecord(2)]
    const project = projectRecord(10, [suppliers[0]!.id, suppliers[1]!.id])
    const validated = validateBackupData(dataWith({ suppliers, projects: [project] }))
    expect(validated.projects[0]).toEqual(project)
  })

  it('rejects an unknown store name', () => {
    expect(codeOf(() => validateBackupData({ ...emptyBackupData(), invoices: [] }))).toBe(
      'BACKUP_ENVELOPE_INVALID',
    )
  })

  it('rejects a store that is missing entirely', () => {
    const partial = { ...emptyBackupData() } as Record<string, readonly unknown[]>
    delete partial.suppliers
    expect(codeOf(() => validateBackupData(partial))).toBe('BACKUP_ENVELOPE_INVALID')
  })

  it('refuses records for a store this build has no validator for', () => {
    expect(
      codeOf(() => validateBackupData(dataWith({ products: [{ id: testUuid(1), sku: 'A' }] }))),
    ).toBe('BACKUP_STORE_UNSUPPORTED')
  })

  it('accepts an empty array for such a store', () => {
    expect(() => validateBackupData(dataWith({ products: [] }))).not.toThrow()
  })

  it('rejects duplicate primary keys inside one store', () => {
    expect(
      codeOf(() => validateBackupData(dataWith({ suppliers: [supplierRecord(1), supplierRecord(1)] }))),
    ).toBe('BACKUP_RECORD_INVALID')
  })

  it('reports which record failed and why', () => {
    try {
      validateBackupData(dataWith({ suppliers: [supplierRecord(1), { ...supplierRecord(2), id: 'no' }] }))
      throw new Error('expected a rejection')
    } catch (cause) {
      expect(cause).toBeInstanceOf(BackupError)
      const error = cause as BackupError
      expect(error.details.store).toBe('suppliers')
      expect(error.details.index).toBe(1)
      expect(error.details.path).toBe('suppliers[1]')
    }
  })

  it('enforces a per-store record ceiling', () => {
    const many = Array.from({ length: 5 }, (_, index) => supplierRecord(index + 1))
    expect(codeOf(() => validateBackupData(dataWith({ suppliers: many }), { maxRecordsPerStore: 3 }))).toBe(
      'BACKUP_TOO_LARGE',
    )
  })

  it('enforces a total record ceiling across stores', () => {
    const data = dataWith({
      suppliers: [supplierRecord(1), supplierRecord(2)],
      inventoryMovements: [movementRecord(20), movementRecord(21)],
    })
    expect(codeOf(() => validateBackupData(data, { maxTotalRecords: 3 }))).toBe('BACKUP_TOO_LARGE')
  })

  it('accepts a payload that is entirely empty', () => {
    const validated = validateBackupData(emptyBackupData())
    expect(totalRecords(countEntities(validated))).toBe(0)
  })
})
