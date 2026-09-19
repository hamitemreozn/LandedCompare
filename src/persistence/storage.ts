/**
 * `navigator.storage` wiring: durability and headroom.
 *
 * Two realistic pilot failures this addresses, from
 * `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §2:
 *
 * - **Eviction.** Without a persistence grant, a browser may discard origin
 *   data under storage pressure. `requestPersistentStorage()` asks for the
 *   grant on first run.
 * - **Quota exhaustion.** It should be visible as a number before it becomes a
 *   failed write, which is what `estimateStorage()` is for.
 *
 * Both are feature-detected and both report "unsupported" honestly rather than
 * pretending success. A granted persistence request is **not** a durability
 * guarantee either: it stops automatic eviction, and stops nothing a user or
 * an operating system does deliberately. The disaster-recovery answer is still
 * an external backup file, which is Phase 8.
 */

export type PersistenceGrant = 'PERSISTED' | 'NOT_PERSISTED' | 'UNSUPPORTED'

interface StorageManagerLike {
  persist?: () => Promise<boolean>
  persisted?: () => Promise<boolean>
  estimate?: () => Promise<{ usage?: number; quota?: number }>
}

interface NavigatorLike {
  storage?: StorageManagerLike
}

function resolveStorage(navigatorLike?: NavigatorLike): StorageManagerLike | undefined {
  const candidate =
    navigatorLike ?? (globalThis as { navigator?: NavigatorLike }).navigator ?? undefined
  return candidate?.storage
}

export async function requestPersistentStorage(
  navigatorLike?: NavigatorLike,
): Promise<PersistenceGrant> {
  const storage = resolveStorage(navigatorLike)
  if (typeof storage?.persist !== 'function') {
    return 'UNSUPPORTED'
  }
  try {
    return (await storage.persist()) ? 'PERSISTED' : 'NOT_PERSISTED'
  } catch {
    // A refused or unavailable grant is a normal outcome, not an error to
    // propagate: the application works either way, it is simply more exposed.
    return 'NOT_PERSISTED'
  }
}

export async function isStoragePersisted(navigatorLike?: NavigatorLike): Promise<PersistenceGrant> {
  const storage = resolveStorage(navigatorLike)
  if (typeof storage?.persisted !== 'function') {
    return 'UNSUPPORTED'
  }
  try {
    return (await storage.persisted()) ? 'PERSISTED' : 'NOT_PERSISTED'
  } catch {
    return 'NOT_PERSISTED'
  }
}

export interface StorageUsage {
  readonly supported: boolean
  readonly usageBytes?: number
  readonly quotaBytes?: number
  /** `usage / quota`, when both are known. Never fabricated from one of them. */
  readonly usedFraction?: number
}

export async function estimateStorage(navigatorLike?: NavigatorLike): Promise<StorageUsage> {
  const storage = resolveStorage(navigatorLike)
  if (typeof storage?.estimate !== 'function') {
    return { supported: false }
  }
  try {
    const { usage, quota } = await storage.estimate()
    const usedFraction =
      typeof usage === 'number' && typeof quota === 'number' && quota > 0
        ? usage / quota
        : undefined
    return { supported: true, usageBytes: usage, quotaBytes: quota, usedFraction }
  } catch {
    return { supported: false }
  }
}
