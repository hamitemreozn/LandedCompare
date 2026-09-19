/**
 * The thin layer over the native IndexedDB API. Nothing above this file
 * touches `IDBRequest`, `IDBTransaction` or event handlers.
 *
 * Deliberately native rather than a wrapper library: the surface actually
 * needed here is "promisify a request" plus "run a callback inside one
 * transaction and settle on `complete`/`abort`", which is this file. A library
 * would add a dependency and a proxy layer between the code and the one
 * property of IndexedDB that most needs to stay visible — when a transaction
 * is still alive.
 *
 * ## The rule for transaction callbacks
 *
 * An IndexedDB transaction deactivates as soon as control returns to the event
 * loop with no request outstanding. Promises resolved from IndexedDB's own
 * success callbacks settle in the same task, so awaiting a `TransactionScope`
 * method is safe; awaiting **anything else** — a fetch, a timer, a
 * `crypto.subtle` digest — lets the transaction close underneath the callback
 * and turns the remaining writes into failures or, worse, writes in a
 * different transaction.
 *
 * So: inside a `runInTransaction` callback, await `TransactionScope` methods
 * and nothing else. Validation, id generation and timestamping happen before
 * the transaction opens.
 */

import { PersistenceError, toPersistenceError } from './errors'
import type { StoreName } from './schema'

export type TransactionMode = 'readonly' | 'readwrite'

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Resolves when the transaction commits, rejects when it aborts or errors.
 *
 * This — not the individual request promises — is what "the write landed"
 * means. A resolved `put` only says the request was accepted; the data is not
 * durable until the transaction completes, which is why no caller is told
 * "saved" before this settles.
 */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (action: () => void) => {
      if (settled) return
      settled = true
      action()
    }
    transaction.oncomplete = () => settle(resolve)
    transaction.onerror = () => settle(() => reject(transaction.error))
    transaction.onabort = () => settle(() => reject(transaction.error))
  })
}

function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort()
  } catch {
    // Already aborted or already finished; there is nothing left to undo.
  }
}

/**
 * The only way the layers above issue reads and writes. Scoped to one
 * transaction, so an operation cannot accidentally span two.
 */
export interface TransactionScope {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined>
  getAll<T>(store: StoreName, query?: IDBKeyRange | IDBValidKey | null, count?: number): Promise<T[]>
  getAllFromIndex<T>(
    store: StoreName,
    index: string,
    query?: IDBKeyRange | IDBValidKey | null,
    count?: number,
  ): Promise<T[]>
  getAllKeys(store: StoreName): Promise<IDBValidKey[]>
  count(store: StoreName, query?: IDBKeyRange | IDBValidKey | null): Promise<number>
  /** Insert or replace. */
  put(store: StoreName, value: unknown): Promise<void>
  /** Insert only — a key that already exists fails with `DUPLICATE_KEY`. */
  add(store: StoreName, value: unknown): Promise<void>
  delete(store: StoreName, key: IDBValidKey): Promise<void>
  clear(store: StoreName): Promise<void>
}

function createScope(transaction: IDBTransaction): TransactionScope {
  const objectStore = (store: StoreName): IDBObjectStore => transaction.objectStore(store)

  return {
    get: <T>(store: StoreName, key: IDBValidKey) =>
      promisifyRequest<T | undefined>(objectStore(store).get(key) as IDBRequest<T | undefined>),
    getAll: <T>(store: StoreName, query?: IDBKeyRange | IDBValidKey | null, count?: number) =>
      promisifyRequest<T[]>(objectStore(store).getAll(query ?? undefined, count) as IDBRequest<T[]>),
    getAllFromIndex: <T>(
      store: StoreName,
      index: string,
      query?: IDBKeyRange | IDBValidKey | null,
      count?: number,
    ) =>
      promisifyRequest<T[]>(
        objectStore(store).index(index).getAll(query ?? undefined, count) as IDBRequest<T[]>,
      ),
    getAllKeys: (store: StoreName) => promisifyRequest(objectStore(store).getAllKeys()),
    count: (store: StoreName, query?: IDBKeyRange | IDBValidKey | null) =>
      promisifyRequest(objectStore(store).count(query ?? undefined)),
    put: async (store: StoreName, value: unknown) => {
      await promisifyRequest(objectStore(store).put(value))
    },
    add: async (store: StoreName, value: unknown) => {
      await promisifyRequest(objectStore(store).add(value))
    },
    delete: async (store: StoreName, key: IDBValidKey) => {
      await promisifyRequest(objectStore(store).delete(key))
    },
    clear: async (store: StoreName) => {
      await promisifyRequest(objectStore(store).clear())
    },
  }
}

/**
 * Runs `work` inside a single transaction over `stores` and resolves only once
 * that transaction has committed.
 *
 * Atomicity is the whole point: anything thrown by `work` — including a
 * validation failure raised between two writes — aborts the transaction, so no
 * partial state survives. The thrown error keeps its own identity; a
 * `PersistenceError` is re-thrown unchanged rather than being flattened into a
 * generic abort, because "the record was invalid" and "the browser aborted the
 * transaction" are different problems with different fixes.
 */
export async function runInTransaction<T>(
  database: IDBDatabase,
  stores: readonly StoreName[],
  mode: TransactionMode,
  work: (scope: TransactionScope) => Promise<T> | T,
): Promise<T> {
  if (stores.length === 0) {
    throw new PersistenceError('TRANSACTION_ABORTED', 'A transaction must name at least one store')
  }

  let transaction: IDBTransaction
  try {
    transaction = database.transaction(stores as unknown as string[], mode)
  } catch (cause) {
    throw toPersistenceError(cause, { stores: stores.join(','), mode })
  }

  const done = transactionDone(transaction)
  // Attach a handler immediately so a rejection between here and the awaits
  // below is never reported as unhandled. `done` itself is still awaited.
  void done.catch(() => {})

  let result: T
  try {
    result = await work(createScope(transaction))
  } catch (cause) {
    abortQuietly(transaction)
    await done.catch(() => {})
    throw toPersistenceError(cause, { stores: stores.join(','), mode })
  }

  try {
    await done
  } catch (cause) {
    throw toPersistenceError(cause, { stores: stores.join(','), mode })
  }

  return result
}
