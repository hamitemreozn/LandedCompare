import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../database'
import type { InventoryMovementRecord } from '../records/inventoryMovement'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from '../testSupport'
import * as inventoryMovementStore from './inventoryMovementStore'
import {
  appendInventoryMovements,
  countInventoryMovements,
  listMovementsForProduct,
  postInventoryMovements,
} from './inventoryMovementStore'

let fixture: TestDatabase
let database: Database

const PRODUCT = testUuid(1)
const OTHER_PRODUCT = testUuid(2)

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

function movement(overrides: Partial<InventoryMovementRecord> = {}): InventoryMovementRecord {
  return {
    id: testUuid(100),
    productId: PRODUCT,
    type: 'PURCHASE_RECEIPT',
    direction: 'IN',
    quantity: { value: '25' },
    unit: 'pcs',
    occurredAt: TEST_INSTANT,
    recordedAt: TEST_INSTANT,
    source: { kind: 'WAREHOUSE_RECEIPT', id: testUuid(500) },
    ...overrides,
  }
}

describe('append-only semantics', () => {
  it('exposes no update or delete operation for the ledger', () => {
    const exported = Object.keys(inventoryMovementStore)
    expect(exported).not.toContain('updateInventoryMovement')
    expect(exported).not.toContain('deleteInventoryMovement')
    expect(exported.some((name) => /delete|update|remove/i.test(name))).toBe(false)
  })

  it('refuses to rewrite a movement that has already been posted', async () => {
    await postInventoryMovements(database, [movement()])

    await expect(
      postInventoryMovements(database, [movement({ quantity: { value: '999' } })]),
    ).rejects.toMatchObject({ code: 'APPEND_ONLY_VIOLATION' })

    const stored = await listMovementsForProduct(database, PRODUCT)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.quantity.value).toBe('25')
  })

  it('writes a batch atomically — a duplicate in the batch posts none of it', async () => {
    await postInventoryMovements(database, [movement({ id: testUuid(101) })])

    const batch = [
      movement({ id: testUuid(102) }),
      movement({ id: testUuid(103) }),
      movement({ id: testUuid(101) }),
    ]
    await expect(postInventoryMovements(database, batch)).rejects.toMatchObject({
      code: 'APPEND_ONLY_VIOLATION',
    })

    expect(await countInventoryMovements(database)).toBe(1)
  })

  it('appends into a caller-supplied transaction alongside another store', async () => {
    // The shape Phase 15 needs: a document and its ledger effect committed
    // together, or neither.
    await database.write(['warehouseReceipts', 'inventoryMovements'], async (scope) => {
      await scope.add('warehouseReceipts', {
        id: testUuid(500),
        inboundShipmentId: testUuid(501),
        postedAt: TEST_INSTANT,
      })
      await appendInventoryMovements(scope, [movement({ id: testUuid(110) })])
    })

    expect(await countInventoryMovements(database)).toBe(1)

    const failed = database.write(['warehouseReceipts', 'inventoryMovements'], async (scope) => {
      await scope.add('warehouseReceipts', {
        id: testUuid(600),
        inboundShipmentId: testUuid(601),
        postedAt: TEST_INSTANT,
      })
      await appendInventoryMovements(scope, [movement({ id: testUuid(110) })])
    })
    await expect(failed).rejects.toMatchObject({ code: 'APPEND_ONLY_VIOLATION' })

    const receipts = await database.read(['warehouseReceipts'], (scope) =>
      scope.count('warehouseReceipts'),
    )
    expect(receipts).toBe(1)
    expect(await countInventoryMovements(database)).toBe(1)
  })
})

describe('movement validation at the storage boundary', () => {
  it('rejects a negative magnitude — direction carries the sign, not the quantity', async () => {
    await expect(
      postInventoryMovements(database, [movement({ quantity: { value: '-5' } })]),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  })

  it('rejects a zero magnitude', async () => {
    await expect(
      postInventoryMovements(database, [movement({ quantity: { value: '0.00' } })]),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  })

  it('rejects an unknown movement type rather than storing it', async () => {
    await expect(
      postInventoryMovements(database, [
        movement({ type: 'TRANSFER' as InventoryMovementRecord['type'] }),
      ]),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  })

  it('rejects an unknown source kind', async () => {
    await expect(
      postInventoryMovements(database, [
        movement({ source: { kind: 'IMPORT' as never, id: testUuid(9) } }),
      ]),
    ).rejects.toMatchObject({ code: 'RECORD_INVALID' })
  })

  it('accepts every declared movement type and adjustment reason', async () => {
    const types: InventoryMovementRecord['type'][] = [
      'OPENING_BALANCE',
      'PURCHASE_RECEIPT',
      'CUSTOMER_DISPATCH',
      'CUSTOMER_RETURN',
      'SUPPLIER_RETURN',
      'POSITIVE_ADJUSTMENT',
      'NEGATIVE_ADJUSTMENT',
    ]
    await postInventoryMovements(
      database,
      types.map((type, index) =>
        movement({
          id: testUuid(300 + index),
          type,
          direction: type.includes('DISPATCH') || type === 'SUPPLIER_RETURN' ? 'OUT' : 'IN',
          reason: type.endsWith('ADJUSTMENT') ? 'STOCK_COUNT' : undefined,
          source: { kind: 'MANUAL' },
        }),
      ),
    )
    expect(await countInventoryMovements(database)).toBe(types.length)
  })
})

describe('reading the ledger', () => {
  it('returns only the requested product, ordered by when the event happened', async () => {
    await postInventoryMovements(database, [
      movement({ id: testUuid(401), occurredAt: '2026-03-02T00:00:00.000Z' }),
      movement({ id: testUuid(402), occurredAt: '2026-01-05T00:00:00.000Z' }),
      movement({ id: testUuid(403), occurredAt: '2026-02-01T00:00:00.000Z' }),
      movement({ id: testUuid(404), productId: OTHER_PRODUCT }),
    ])

    const forProduct = await listMovementsForProduct(database, PRODUCT)
    expect(forProduct.map((record) => record.occurredAt)).toEqual([
      '2026-01-05T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-03-02T00:00:00.000Z',
    ])
    expect(await listMovementsForProduct(database, OTHER_PRODUCT)).toHaveLength(1)
  })

  it('rejects a corrupted stored movement instead of returning it', async () => {
    await database.write(['inventoryMovements'], (scope) =>
      scope.add('inventoryMovements', {
        ...movement({ id: testUuid(410) }),
        quantity: { value: 25 },
      }),
    )

    await expect(listMovementsForProduct(database, PRODUCT)).rejects.toMatchObject({
      code: 'RECORD_INVALID',
    })
  })
})
