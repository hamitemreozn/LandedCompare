/**
 * Stale-write detection.
 *
 * The pilot is single-user, but two browser tabs on the same machine is a real
 * and likely accident, and it is the one way this design can lose data
 * silently: tab A loads a project, tab B edits and saves it, tab A saves its
 * older copy over the top and nothing anywhere reports a problem.
 *
 * Every editable aggregate therefore carries `updatedAt`, and a write states
 * which version it is replacing. A mismatch is **refused**, not merged — see
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §5. Detecting the conflict and
 * stopping is the goal; resolving it is the user's job, and the UI's message
 * is "this record changed elsewhere — reload".
 */

import { PersistenceError } from './errors'

export interface StaleWriteCheck {
  /** Store or aggregate name, for the error details. */
  readonly entity: string
  readonly id: string
  /** `updatedAt` currently in the database, or `undefined` if nothing is stored. */
  readonly storedUpdatedAt: string | undefined
  /** `updatedAt` the caller loaded. `undefined` asserts "this record is new". */
  readonly previousUpdatedAt: string | undefined
}

export function assertNotStale(check: StaleWriteCheck): void {
  const { entity, id, storedUpdatedAt, previousUpdatedAt } = check

  if (storedUpdatedAt === undefined) {
    if (previousUpdatedAt !== undefined) {
      // The caller is updating something that is no longer there. Recreating
      // it under the same id would resurrect a record someone deleted.
      throw new PersistenceError('RECORD_NOT_FOUND', `No ${entity} with id "${id}" to update`, {
        details: { entity, id },
      })
    }
    return
  }

  if (previousUpdatedAt === undefined) {
    throw new PersistenceError(
      'STALE_WRITE',
      `A ${entity} with id "${id}" already exists; this write claimed to create it`,
      { details: { entity, id, storedUpdatedAt } },
    )
  }

  if (storedUpdatedAt !== previousUpdatedAt) {
    throw new PersistenceError(
      'STALE_WRITE',
      `The stored ${entity} "${id}" changed since it was loaded; the write was refused`,
      { details: { entity, id, storedUpdatedAt, previousUpdatedAt } },
    )
  }
}
