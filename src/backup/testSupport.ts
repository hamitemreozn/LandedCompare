/**
 * Test-only fixtures for the backup suites. Not a test file, and not imported
 * by production code.
 *
 * The records built here are **real** records: every one of them passes the
 * same Phase 7 validators the application uses, and they are written through
 * ordinary transactions into a `fake-indexeddb` database. Nothing in the
 * backup suites is proven against a mock of the code under test — a backup
 * test that stubbed out IndexedDB would prove the backup module agrees with
 * itself, which is the one thing never in doubt.
 */

import type { Database } from '../persistence/database'
import type { CounterRecord } from '../persistence/records/counter'
import type { InventoryMovementRecord } from '../persistence/records/inventoryMovement'
import type { ProjectRecord } from '../persistence/records/project'
import type { SettingRecord } from '../persistence/records/settings'
import type { SupplierRecord } from '../persistence/records/supplier'
import { testUuid, TEST_INSTANT } from '../persistence/testSupport'
import { BACKUP_STORE_NAMES, type BackupData } from './businessData'

export function supplierRecord(seed: number, overrides: Partial<SupplierRecord> = {}): SupplierRecord {
  return {
    id: testUuid(seed),
    displayName: `Supplier ${seed}`,
    active: true,
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
    ...overrides,
  }
}

export function movementRecord(
  seed: number,
  overrides: Partial<InventoryMovementRecord> = {},
): InventoryMovementRecord {
  return {
    id: testUuid(seed),
    productId: testUuid(900),
    type: 'OPENING_BALANCE',
    direction: 'IN',
    // A decimal string with trailing digits that a float round trip would
    // damage: the persisted contract is character-exact, and this is what
    // proves a backup keeps it that way.
    quantity: { value: '12.345' },
    unit: 'pcs',
    occurredAt: TEST_INSTANT,
    recordedAt: TEST_INSTANT,
    source: { kind: 'OPENING' },
    ...overrides,
  }
}

export function projectRecord(
  seed: number,
  supplierIds: readonly string[],
  overrides: Partial<ProjectRecord> = {},
): ProjectRecord {
  const requirementId = testUuid(seed + 1000)
  return {
    id: testUuid(seed),
    name: `Project ${seed}`,
    baseCurrency: 'EUR',
    createdAt: TEST_INSTANT,
    updatedAt: TEST_INSTANT,
    supplierIds: [...supplierIds],
    requirements: [
      {
        id: requirementId,
        productName: 'Sensor',
        requiredQuantity: { value: '137' },
        comparisonUnit: 'pcs',
      },
    ],
    quotes: supplierIds.map((supplierId, index) => ({
      id: testUuid(seed + 2000 + index),
      supplierId,
      currency: 'EUR',
      items: [
        {
          id: testUuid(seed + 3000 + index),
          requirementId,
          quotedUnitPrice: { amount: '3.335', currency: 'EUR' },
          quotedUnit: 'pack',
          unitsPerQuotedUnit: { value: '12' },
        },
      ],
    })),
    ...overrides,
  }
}

export function settingRecord(key: string, value: string | number | boolean): SettingRecord {
  return { key, value }
}

export function counterRecord(key: string, nextValue: number): CounterRecord {
  return { key, nextValue }
}

export interface SeedSpec {
  readonly suppliers?: readonly SupplierRecord[]
  readonly projects?: readonly ProjectRecord[]
  readonly inventoryMovements?: readonly InventoryMovementRecord[]
  readonly settings?: readonly SettingRecord[]
  readonly counters?: readonly CounterRecord[]
}

/**
 * Writes a whole fixture in one transaction, so the seeded state is coherent
 * for the same reason a snapshot is.
 */
export async function seedDatabase(database: Database, spec: SeedSpec): Promise<void> {
  await database.write(['suppliers', 'projects', 'inventoryMovements', 'settings', 'counters'], async (scope) => {
    for (const record of spec.suppliers ?? []) {
      await scope.put('suppliers', record)
    }
    for (const record of spec.projects ?? []) {
      await scope.put('projects', record)
    }
    for (const record of spec.inventoryMovements ?? []) {
      await scope.put('inventoryMovements', record)
    }
    for (const record of spec.settings ?? []) {
      await scope.put('settings', record)
    }
    for (const record of spec.counters ?? []) {
      await scope.put('counters', record)
    }
  })
}

/**
 * The same fixture as `seedDatabase`, flattened to store → records.
 *
 * For seeding a database this build cannot open through `openDatabase` — a
 * genuine older-version fixture, written through the raw IndexedDB API by
 * `createLegacyV1Database`. Keeping one definition of the records means a
 * migration test and a backup test are looking at the same data.
 */
export function seedRecordsByStore(spec: SeedSpec): Record<string, readonly unknown[]> {
  return {
    suppliers: spec.suppliers ?? [],
    projects: spec.projects ?? [],
    inventoryMovements: spec.inventoryMovements ?? [],
    settings: spec.settings ?? [],
    counters: spec.counters ?? [],
  }
}

/** A small but structurally complete fixture: every validated store non-empty. */
export function standardSeed(): SeedSpec {
  const suppliers = [supplierRecord(1), supplierRecord(2)]
  return {
    suppliers,
    projects: [projectRecord(10, [suppliers[0]!.id, suppliers[1]!.id])],
    inventoryMovements: [movementRecord(20), movementRecord(21)],
    settings: [settingRecord('locale', 'tr'), settingRecord('compactRows', true)],
    counters: [counterRecord('PO', 7)],
  }
}

/** Reads every backed-up store, for comparing two databases record for record. */
export function readAllStores(database: Database): Promise<BackupData> {
  return database.read(BACKUP_STORE_NAMES, async (scope) => {
    const data: Record<string, readonly unknown[]> = {}
    for (const store of BACKUP_STORE_NAMES) {
      data[store] = await scope.getAll<unknown>(store)
    }
    return data as BackupData
  })
}
