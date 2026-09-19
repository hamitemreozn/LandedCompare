/**
 * Read and write the analysis-project aggregate.
 *
 * This is the concrete demonstration of the persisted-vs-runtime rule: a
 * project is *stored* with `supplierIds` and *loaded* as a `Project` holding
 * full `Supplier` objects, which is exactly the shape `compareSuppliers()`
 * already expects. `src/domain`, `src/calculation` and `src/comparison` are
 * unaware that any of this happens.
 *
 * Both operations span two stores in **one** transaction. On save that is what
 * makes the reference check meaningful — a project naming a supplier that does
 * not exist is rejected with nothing written, rather than saved now and
 * discovered broken on the next load.
 */

import type { Project } from '../../domain/project/Project'
import type { Supplier } from '../../domain/supplier/Supplier'
import type { Database } from '../database'
import { PersistenceError } from '../errors'
import type { TransactionScope } from '../idb'
import {
  parseProjectRecord,
  toProjectRecord,
  toRuntimeProject,
  type ProjectRecord,
} from '../records/project'
import { toRuntimeSupplier } from '../records/supplier'
import { assertNotStale } from '../staleWrite'
import { readSupplierRecord } from './supplierStore'

const PROJECT_STORES = ['projects', 'suppliers'] as const

export async function readProjectRecord(
  scope: TransactionScope,
  id: string,
): Promise<ProjectRecord | undefined> {
  const stored = await scope.get<unknown>('projects', id)
  return stored === undefined ? undefined : parseProjectRecord(stored)
}

async function resolveSuppliers(
  scope: TransactionScope,
  record: ProjectRecord,
): Promise<Map<string, Supplier>> {
  const suppliers = new Map<string, Supplier>()
  for (const supplierId of record.supplierIds) {
    const supplierRecord = await readSupplierRecord(scope, supplierId)
    if (supplierRecord === undefined) {
      throw new PersistenceError(
        'REFERENCE_MISSING',
        `Project "${record.id}" references supplier "${supplierId}", which does not exist`,
        { details: { projectId: record.id, supplierId } },
      )
    }
    suppliers.set(supplierId, toRuntimeSupplier(supplierRecord))
  }
  return suppliers
}

/**
 * Writes the project aggregate, after proving every supplier it references
 * exists and that nobody else has written it since it was loaded.
 *
 * `project.updatedAt` is taken from the domain object — this layer does not
 * stamp it. The caller decides when a change happened; a persistence helper
 * quietly setting `updatedAt = now` on every write would make the stale-write
 * comparison a comparison against itself.
 */
export async function saveProject(
  database: Database,
  project: Project,
  options: { previousUpdatedAt?: string } = {},
): Promise<void> {
  // Mapping and structural validation happen before the transaction opens:
  // an IndexedDB transaction must not wait on work that is not a request.
  // `async` so a validation failure rejects rather than throwing synchronously.
  const record = parseProjectRecord(toProjectRecord(project))

  await database.write(PROJECT_STORES, async (scope) => {
    const stored = await readProjectRecord(scope, record.id)
    assertNotStale({
      entity: 'project',
      id: record.id,
      storedUpdatedAt: stored?.updatedAt,
      previousUpdatedAt: options.previousUpdatedAt,
    })

    for (const supplierId of record.supplierIds) {
      const supplier = await readSupplierRecord(scope, supplierId)
      if (supplier === undefined) {
        throw new PersistenceError(
          'REFERENCE_MISSING',
          `Project "${record.id}" references supplier "${supplierId}", which does not exist`,
          { details: { projectId: record.id, supplierId } },
        )
      }
    }

    await scope.put('projects', record)
  })
}

export function loadProject(database: Database, id: string): Promise<Project> {
  return database.read(PROJECT_STORES, async (scope) => {
    const record = await readProjectRecord(scope, id)
    if (record === undefined) {
      throw new PersistenceError('RECORD_NOT_FOUND', `No project with id "${id}"`, {
        details: { store: 'projects', id },
      })
    }
    return toRuntimeProject(record, await resolveSuppliers(scope, record))
  })
}

export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly baseCurrency: string
  readonly updatedAt: string
}

/**
 * The project list, newest first, without hydrating any aggregate.
 *
 * A list screen needs four fields per row; loading every requirement, quote
 * and quote item to render them would read the whole database to draw a menu.
 */
export function listProjectSummaries(database: Database): Promise<ProjectSummary[]> {
  return database.read(['projects'], async (scope) => {
    const stored = await scope.getAllFromIndex<unknown>('projects', 'updatedAt')
    return stored
      .map((value, index) => parseProjectRecord(value, `projects[${index}]`))
      .map(({ id, name, baseCurrency, updatedAt }) => ({ id, name, baseCurrency, updatedAt }))
      .reverse()
  })
}

export function deleteProject(database: Database, id: string): Promise<void> {
  return database.write(['projects'], (scope) => scope.delete('projects', id))
}
