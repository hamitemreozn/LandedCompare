/**
 * Test-only helpers. Not a test file, and not imported by production code.
 *
 * Isolation is the point. Every test opens a database under its own generated
 * name, so files running in parallel cannot see, overwrite or delete each
 * other's data, and no test can touch the production database by forgetting a
 * parameter — `deleteDatabase` refuses that name without an explicit token.
 */

import { deleteDatabase, openDatabase, type Database, type OpenDatabaseOptions } from './database'

export function createTestDatabaseName(label = 'test'): string {
  return `landedcompare-${label}-${crypto.randomUUID()}`
}

/**
 * Deterministic UUIDs, so a record written by a test has a stable id without
 * hard-coding one that could collide across files.
 */
export function testUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

export const TEST_INSTANT = '2026-09-19T12:00:00.000Z'

export interface TestDatabase {
  readonly database: Database
  readonly name: string
  /** Closes the connection and removes the database. */
  destroy(): Promise<void>
}

export async function openTestDatabase(
  options: Omit<OpenDatabaseOptions, 'name'> & { name?: string } = {},
): Promise<TestDatabase> {
  const name = options.name ?? createTestDatabaseName()
  const database = await openDatabase({ ...options, name })
  return {
    database,
    name,
    destroy: async () => {
      database.close()
      await deleteDatabase(name)
    },
  }
}
