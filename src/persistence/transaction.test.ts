import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from './database'
import { PersistenceError, isPersistenceError } from './errors'
import { reserveNextCounterValue } from './stores/counterStore'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from './testSupport'
import type { SupplierRecord } from './records/supplier'
import type { InventoryMovementRecord } from './records/inventoryMovement'

let fixture: TestDatabase
let database: Database

beforeEach(async () => {
  fixture = await openTestDatabase()
  database = fixture.database
})

afterEach(async () => {
  await fixture.destroy()
})

function supplierRecord(seed: number): SupplierRecord {
  return {
    id: testUuid(seed),
    displayName: `Supplier ${seed}`,
    active: true,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
  }
}

function movementRecord(seed: number): InventoryMovementRecord {
  return {
    id: testUuid(9000 + seed),
    productId: testUuid(100),
    type: 'PURCHASE_RECEIPT',
    direction: 'IN',
    quantity: { value: '10' },
    unit: 'pcs',
    occurredAt: TEST_INSTANT,
    recordedAt: TEST_INSTANT,
    source: { kind: 'WAREHOUSE_RECEIPT', id: testUuid(500) },
  }
}

describe('multi-store transactions', () => {
  it('commits every write of a successful transaction', async () => {
    await database.write(['suppliers', 'inventoryMovements', 'counters'], async (scope) => {
      await scope.put('suppliers', supplierRecord(1))
      await scope.add('inventoryMovements', movementRecord(1))
      await reserveNextCounterValue(scope, 'RCP')
    })

    const stored = await database.read(
      ['suppliers', 'inventoryMovements', 'counters'],
      async (scope) => ({
        suppliers: await scope.count('suppliers'),
        movements: await scope.count('inventoryMovements'),
        counter: await scope.get<{ nextValue: number }>('counters', 'RCP'),
      }),
    )

    expect(stored.suppliers).toBe(1)
    expect(stored.movements).toBe(1)
    expect(stored.counter?.nextValue).toBe(2)
  })

  it('rolls back every participating store when the transaction throws', async () => {
    // This is the shape of the receipt-posting transaction Phase 15 will run:
    // the document, its ledger movements, and the counter that numbered it.
    // A failure after two of the three writes must leave none of them.
    const failure = database.write(
      ['suppliers', 'inventoryMovements', 'counters'],
      async (scope) => {
        await scope.put('suppliers', supplierRecord(2))
        await scope.add('inventoryMovements', movementRecord(2))
        await reserveNextCounterValue(scope, 'RCP')
        throw new PersistenceError('RECORD_INVALID', 'simulated failure after three writes')
      },
    )

    await expect(failure).rejects.toMatchObject({ code: 'RECORD_INVALID' })

    const stored = await database.read(
      ['suppliers', 'inventoryMovements', 'counters'],
      async (scope) => ({
        suppliers: await scope.count('suppliers'),
        movements: await scope.count('inventoryMovements'),
        counter: await scope.get<unknown>('counters', 'RCP'),
      }),
    )

    expect(stored.suppliers).toBe(0)
    expect(stored.movements).toBe(0)
    expect(stored.counter).toBeUndefined()
  })

  it('keeps a typed failure raised mid-transaction rather than flattening it to an abort', async () => {
    const failure = database.write(['suppliers'], async (scope) => {
      await scope.put('suppliers', supplierRecord(3))
      throw new PersistenceError('STALE_WRITE', 'simulated conflict', {
        details: { entity: 'supplier' },
      })
    })

    try {
      await failure
      throw new Error('expected the transaction to fail')
    } catch (error) {
      expect(isPersistenceError(error)).toBe(true)
      expect((error as PersistenceError).code).toBe('STALE_WRITE')
      expect((error as PersistenceError).details.entity).toBe('supplier')
    }
  })

  it('leaves earlier writes rolled back when a later one violates a unique index', async () => {
    await database.write(['products'], (scope) =>
      scope.put('products', { id: testUuid(10), sku: 'SKU-1', active: true }),
    )

    const failure = database.write(['products', 'suppliers'], async (scope) => {
      await scope.put('suppliers', supplierRecord(4))
      await scope.put('products', { id: testUuid(11), sku: 'SKU-1', active: true })
    })

    await expect(failure).rejects.toMatchObject({ code: 'DUPLICATE_KEY' })

    const counts = await database.read(['products', 'suppliers'], async (scope) => ({
      products: await scope.count('products'),
      suppliers: await scope.count('suppliers'),
    }))
    expect(counts.products).toBe(1)
    expect(counts.suppliers).toBe(0)
  })

  it('refuses a transaction that names no store', async () => {
    await expect(database.write([], () => undefined)).rejects.toMatchObject({
      code: 'TRANSACTION_ABORTED',
    })
  })

  it('resolves a write only after the transaction has committed', async () => {
    // A resolved `put` means the request was accepted, not that the data is
    // durable. `write` must not resolve until `oncomplete`, which is what lets
    // the UI show "Saved" truthfully.
    await database.write(['suppliers'], (scope) => scope.put('suppliers', supplierRecord(5)))

    const reopened = await openTestDatabase({ name: fixture.name })
    const stored = await reopened.database.read(['suppliers'], (scope) =>
      scope.get<SupplierRecord>('suppliers', testUuid(5)),
    )
    expect(stored?.displayName).toBe('Supplier 5')
    reopened.database.close()
  })
})

describe('counter reservation', () => {
  it('hands out consecutive values and never repeats one', async () => {
    const values: number[] = []
    for (let index = 0; index < 4; index += 1) {
      values.push(await database.write(['counters'], (scope) => reserveNextCounterValue(scope, 'PO')))
    }
    expect(values).toEqual([1, 2, 3, 4])
  })

  it('does not consume a value when the surrounding transaction fails', async () => {
    await database.write(['counters'], (scope) => reserveNextCounterValue(scope, 'SHP'))

    const failure = database.write(['counters', 'suppliers'], async (scope) => {
      await reserveNextCounterValue(scope, 'SHP')
      throw new PersistenceError('RECORD_INVALID', 'document failed validation')
    })
    await expect(failure).rejects.toMatchObject({ code: 'RECORD_INVALID' })

    const next = await database.write(['counters'], (scope) => reserveNextCounterValue(scope, 'SHP'))
    expect(next).toBe(2)
  })
})
