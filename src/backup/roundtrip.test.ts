/**
 * The property that makes a backup trustworthy.
 *
 * ```text
 *   database A  →  backup  →  a different, empty database  →  restore  →  backup B
 * ```
 *
 * Ignoring the manifest fields that must legitimately differ — `createdAt`,
 * `installId`, which describe the export and the machine, not the data — the
 * **business payload of A and B must be identical, byte for byte.** Anything
 * that drops a field, reorders a store, re-parses a decimal or normalises a
 * timestamp shows up here as a mismatched checksum, which is the whole point:
 * one assertion covers every record shape at once, including the ones later
 * phases will add.
 *
 * The suite also re-runs the audited comparison engine across the boundary.
 * A backup that restores records the engine then costs *slightly* differently
 * is worse than one that fails loudly, and a count check would never see it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compareSuppliers, type SupplierComparisonResult } from '../comparison/SupplierComparison'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'
import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { createProject, type Project } from '../domain/project/Project'
import { createQuote } from '../domain/quote/Quote'
import { createQuoteItem } from '../domain/quote/QuoteItem'
import { createRequirementItem } from '../domain/requirement/RequirementItem'
import { createSupplier } from '../domain/supplier/Supplier'
import type { Database } from '../persistence/database'
import { toSupplierRecord } from '../persistence/records/supplier'
import { loadProject, saveProject } from '../persistence/stores/projectStore'
import { saveSupplier } from '../persistence/stores/supplierStore'
import { openTestDatabase, TEST_INSTANT, testUuid, type TestDatabase } from '../persistence/testSupport'
import { createBackup } from './externalBackup'
import { applyRestore, prepareRestore } from './restore'
import { createSnapshot, readSnapshot } from './snapshots'
import {
  movementRecord,
  projectRecord,
  readAllStores,
  seedDatabase,
  supplierRecord,
  type SeedSpec,
} from './testSupport'

let source: TestDatabase
let target: TestDatabase

beforeEach(async () => {
  source = await openTestDatabase()
  target = await openTestDatabase()
})

afterEach(async () => {
  await source.destroy()
  await target.destroy()
})

const clock = (instant: string) => () => instant

/** Everything in a backup except the fields that describe *this* export. */
function businessPayload(json: string): unknown {
  const value = JSON.parse(json) as Record<string, unknown>
  return {
    schemaVersion: value.schemaVersion,
    entityCounts: value.entityCounts,
    integrity: value.integrity,
    data: value.data,
  }
}

/** A deterministic fixture of `count` suppliers, projects and movements. */
function generatedSeed(count: number): SeedSpec {
  const suppliers = Array.from({ length: count }, (_, index) => {
    const seed = index + 1
    return supplierRecord(seed, {
      displayName: `Tedarikçi ${seed} ₺`,
      // Every third supplier carries the optional field, so the payload mixes
      // present and absent optionals — the case that broke the round trip
      // before `normaliseStoredValue` existed.
      ...(seed % 3 === 0 ? { note: `note ${seed}` } : {}),
    })
  })
  return {
    suppliers,
    projects: Array.from({ length: Math.max(1, Math.floor(count / 4)) }, (_, index) =>
      projectRecord(500 + index, [suppliers[index % suppliers.length]!.id]),
    ),
    inventoryMovements: Array.from({ length: count * 2 }, (_, index) =>
      movementRecord(2_000 + index, {
        // Decimal strings a float round trip would damage.
        quantity: { value: `${index + 1}.${String((index * 7) % 1000).padStart(3, '0')}` },
        ...(index % 2 === 0 ? { note: `movement ${index}` } : {}),
      }),
    ),
    settings: [
      { key: 'locale', value: 'tr' },
      { key: 'rowsPerPage', value: 50 },
      { key: 'compact', value: false },
    ],
    counters: [
      { key: 'PO', nextValue: 12 },
      { key: 'SHP', nextValue: 3 },
    ],
  }
}

describe('backup → restore → backup', () => {
  it('reproduces the business payload exactly on a different database', async () => {
    await seedDatabase(source.database, generatedSeed(8))

    const first = await createBackup(source.database, { now: clock('2026-09-19T18:32:11.482Z') })
    const plan = await prepareRestore(target.database, first.json)
    await applyRestore(target.database, plan, { now: clock('2026-09-20T09:00:00.000Z') })

    const second = await createBackup(target.database, { now: clock('2026-09-21T11:00:00.000Z') })

    expect(businessPayload(second.json)).toEqual(businessPayload(first.json))
    // The strongest form: the digest over the payload is unchanged.
    expect(second.envelope.integrity.value).toBe(first.envelope.integrity.value)
  })

  it('differs only in the manifest fields that describe the export', async () => {
    await seedDatabase(source.database, generatedSeed(4))
    const first = await createBackup(source.database, { now: clock('2026-09-19T18:32:11.482Z') })
    await applyRestore(target.database, await prepareRestore(target.database, first.json))
    const second = await createBackup(target.database, { now: clock('2026-09-21T11:00:00.000Z') })

    expect(second.envelope.createdAt).not.toBe(first.envelope.createdAt)
    expect(second.envelope.installId).not.toBe(first.envelope.installId)
    expect(second.envelope.data).toEqual(first.envelope.data)
  })

  it('holds at a larger, still bounded record count', async () => {
    await seedDatabase(source.database, generatedSeed(100))

    const first = await createBackup(source.database, { now: clock('2026-09-19T18:32:11.482Z') })
    expect(first.totalRecords).toBeGreaterThan(300)

    await applyRestore(target.database, await prepareRestore(target.database, first.json))
    const second = await createBackup(target.database, { now: clock('2026-09-21T11:00:00.000Z') })

    expect(second.envelope.integrity.value).toBe(first.envelope.integrity.value)
  })

  it('is stable through three generations', async () => {
    await seedDatabase(source.database, generatedSeed(5))
    const first = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })

    await applyRestore(target.database, await prepareRestore(target.database, first.json))
    const second = await createBackup(target.database, { now: clock('2026-09-20T08:00:00.000Z') })

    await applyRestore(target.database, await prepareRestore(target.database, second.json))
    const third = await createBackup(target.database, { now: clock('2026-09-21T08:00:00.000Z') })

    expect(third.envelope.integrity.value).toBe(first.envelope.integrity.value)
  })

  it('does not depend on the order records were written in', async () => {
    const seed = generatedSeed(6)
    await seedDatabase(source.database, seed)
    // The same records, inserted back to front, into a second database.
    await seedDatabase(target.database, {
      suppliers: [...(seed.suppliers ?? [])].reverse(),
      projects: [...(seed.projects ?? [])].reverse(),
      inventoryMovements: [...(seed.inventoryMovements ?? [])].reverse(),
      settings: [...(seed.settings ?? [])].reverse(),
      counters: [...(seed.counters ?? [])].reverse(),
    })

    const a = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    const b = await createBackup(target.database, { now: clock('2026-09-19T08:00:00.000Z') })

    // IndexedDB returns records in primary-key order and the serialiser sorts
    // object keys, so insertion order reaches neither the file nor the digest.
    expect(b.envelope.integrity.value).toBe(a.envelope.integrity.value)
  })

  it('round-trips a snapshot payload through the same equality', async () => {
    await seedDatabase(source.database, generatedSeed(5))
    const backup = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    const snapshot = await createSnapshot(source.database, { kind: 'MANUAL' })

    const stored = await readSnapshot(source.database, snapshot.id)
    expect(stored.payload).toEqual(backup.envelope.data)
  })
})

describe('records written through the real Phase 7 store helpers', () => {
  /**
   * The realistic path. `putSupplierRecord` writes the *parsed* record, which
   * carries `note: undefined` when no note was given, so a database populated
   * through the normal API is exactly the one a naive backup would choke on.
   */
  async function seedThroughStoreHelpers(database: Database): Promise<Project> {
    const suppliers = [
      createSupplier({ id: testUuid(1), displayName: 'Cheap Supplier' }),
      createSupplier({ id: testUuid(2), displayName: 'Pricey Supplier' }),
    ]
    for (const supplier of suppliers) {
      await saveSupplier(
        database,
        toSupplierRecord(supplier, { active: true, createdAt: TEST_INSTANT, updatedAt: TEST_INSTANT }),
      )
    }

    const requirementA = testUuid(10)
    const requirementB = testUuid(11)
    const project = createProject({
      id: testUuid(100),
      name: 'Round trip project',
      baseCurrency: 'EUR',
      createdAt: TEST_INSTANT,
      updatedAt: TEST_INSTANT,
      requirements: [
        createRequirementItem({
          id: requirementA,
          productName: 'Sensor',
          requiredQuantity: '137',
          comparisonUnit: 'pcs',
        }),
        createRequirementItem({
          id: requirementB,
          productName: 'Cable',
          requiredQuantity: '9.75',
          comparisonUnit: 'm',
        }),
      ],
      suppliers,
      quotes: [
        createQuote({
          id: testUuid(200),
          supplierId: suppliers[0]!.id,
          currency: 'EUR',
          items: [
            createQuoteItem({
              id: testUuid(201),
              requirementId: requirementA,
              quotedUnitPrice: Money.fromString('3.335', 'EUR'),
              quotedUnit: 'pack',
              unitsPerQuotedUnit: Quantity.fromString('12'),
              moq: Quantity.fromString('5'),
            }),
            // No MOQ and no pack size: the optional fields are absent here.
            createQuoteItem({
              id: testUuid(202),
              requirementId: requirementB,
              quotedUnitPrice: Money.fromString('0.005', 'EUR'),
              quotedUnit: 'm',
            }),
          ],
        }),
        createQuote({
          id: testUuid(210),
          supplierId: suppliers[1]!.id,
          currency: 'EUR',
          items: [
            createQuoteItem({
              id: testUuid(211),
              requirementId: requirementA,
              quotedUnitPrice: Money.fromString('3.34', 'EUR'),
              quotedUnit: 'pcs',
            }),
            createQuoteItem({
              id: testUuid(212),
              requirementId: requirementB,
              quotedUnitPrice: Money.fromString('0.006', 'EUR'),
              quotedUnit: 'm',
            }),
          ],
        }),
      ],
    })
    await saveProject(database, project)
    return project
  }

  function compare(project: Project): SupplierComparisonResult {
    return compareSuppliers({ project, exchangeRateTable: ExchangeRateTable.create('EUR') })
  }

  /** The figures a user would actually read. */
  function readable(result: SupplierComparisonResult) {
    return {
      baseCurrency: result.baseCurrency,
      minorUnit: result.minorUnit,
      lowestSupplierIds: [...result.lowestSupplierIds],
      insights: result.insights.map((insight) => insight.code),
      suppliers: result.supplierResults.map((entry) => ({
        supplierId: entry.supplierId,
        status: entry.status,
        rank: entry.rank,
        rankingAmount: entry.rankingAmount?.toDecimalString(),
        settledLandedTotal: entry.costResult?.settledLandedTotal.toDecimalString(),
        calculatedLandedTotal: entry.costResult?.calculatedLandedTotal.toDecimalString(),
        differenceFromLowest: entry.differenceFromLowest?.toDecimalString(),
        lines: entry.lines?.map((line) => ({
          requirementId: line.requirementId,
          resolvedQuantity: line.resolvedQuantity?.toDecimalString(),
          excessQuantity: line.excessQuantity?.toDecimalString(),
        })),
      })),
    }
  }

  it('backs up and restores a database populated through the ordinary API', async () => {
    const project = await seedThroughStoreHelpers(source.database)

    const backup = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    await applyRestore(target.database, await prepareRestore(target.database, backup.json))

    expect(await readAllStores(target.database)).toEqual(await readAllStores(source.database))
    const reloaded = await loadProject(target.database, project.id)
    expect(reloaded.quotes[0]?.items[1]?.moq).toBeUndefined()
  })

  it('leaves the comparison engine’s output identical across the round trip', async () => {
    const project = await seedThroughStoreHelpers(source.database)
    const before = compare(project)

    const backup = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    await applyRestore(target.database, await prepareRestore(target.database, backup.json))

    const restored = await loadProject(target.database, project.id)
    expect(readable(compare(restored))).toEqual(readable(before))
  })

  it('rebuilds Money and Quantity as real value objects after a restore', async () => {
    const project = await seedThroughStoreHelpers(source.database)
    const backup = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    await applyRestore(target.database, await prepareRestore(target.database, backup.json))

    const restored = await loadProject(target.database, project.id)
    const item = restored.quotes[0]?.items[0]
    expect(item?.quotedUnitPrice).toBeInstanceOf(Money)
    expect(item?.unitsPerQuotedUnit).toBeInstanceOf(Quantity)
    expect(item?.quotedUnitPrice.multiply('2').toDecimalString()).toBe('6.67')
  })

  it('produces an identical second backup from the restored database', async () => {
    await seedThroughStoreHelpers(source.database)
    const first = await createBackup(source.database, { now: clock('2026-09-19T08:00:00.000Z') })
    await applyRestore(target.database, await prepareRestore(target.database, first.json))
    const second = await createBackup(target.database, { now: clock('2026-09-20T08:00:00.000Z') })

    expect(second.envelope.integrity.value).toBe(first.envelope.integrity.value)
  })
})
