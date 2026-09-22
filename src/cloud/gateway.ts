/**
 * The data gateway — the one module that names the `api` schema, and the one
 * place a PostgREST failure becomes an application error code.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §24.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a single type with a method per operation the features actually call.
 * There is no repository interface per entity, no unit of work, no DTO layer
 * and no factory — the same explicit-functions philosophy
 * `src/persistence/index.ts` already follows, for the same reason: an
 * abstraction that exists to be abstract adds a file to read and removes
 * nothing.
 *
 * It exists rather than having services call `supabase` directly because it has
 * three concrete jobs:
 *
 * 1. **Boundary conversions.** `timestamptz` arrives already normalised by the
 *    `api` views (§10), and from Phase 11 decimals arrive as canonical strings
 *    that go straight to `Quantity.fromJSON` / `Money.fromJSON` without ever
 *    becoming a JavaScript `number`. One place, tested once.
 * 2. **Hiding the read/write asymmetry.** A read is a `select` on a view; every
 *    write is an `rpc()` with a typed parameter list. Two shapes, one module
 *    that knows which is which, and a service that still just asks for what it
 *    wants.
 * 3. **Error vocabulary.** PostgREST and PostgreSQL failures become
 *    `CloudErrorCode`s, so `src/i18n/persistenceText.ts` EXTENDS rather than
 *    being replaced and no raw Postgres message ever reaches a screen.
 *
 * ## Scope in Phase 10
 *
 * Identity only: organisations, memberships and the caller's own profile. The
 * catalog — products, suppliers, customers — stays on IndexedDB until Phase 11
 * migrates it, and NOTHING in this module is wired into the running
 * application. That is deliberate: a half-migration where some entities are
 * local and some are remote is two sources of truth, which is the single thing
 * this architecture exists to prevent. Phase 11 switches the whole catalog at
 * once, or it does not switch.
 */

import type { CloudClient } from './client'
import {
  CloudError,
  cloudErrorFromPostgrest,
  cloudErrorFromTransport,
  type PostgrestFailure,
} from './errors'

export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER'
export type MembershipStatus = 'ACTIVE' | 'DISABLED'

export interface Organization {
  readonly id: string
  readonly name: string
  /** True while a restore holds the write gate (§16). Reads keep working. */
  readonly writeLocked: boolean
  readonly writeLockReason: string | null
  readonly version: number
  readonly updatedAt: string
}

export interface Membership {
  readonly organizationId: string
  readonly userId: string
  readonly role: MembershipRole
  readonly status: MembershipStatus
}

export interface Profile {
  readonly userId: string
  readonly displayName: string
  /** The forced first-password-change flag of §4. A UX gate, not a control. */
  readonly mustChangePassword: boolean
  readonly version: number
}

export interface IdentityGateway {
  /** The organisations the caller is an ACTIVE member of. */
  listOrganizations(): Promise<readonly Organization[]>
  /**
   * The caller's own membership rows — including DISABLED ones, which is what
   * lets the boot sequence say "your access has been deactivated" instead of
   * rendering an empty product (§17).
   */
  listOwnMemberships(): Promise<readonly Membership[]>
  /** The caller's own profile, or null if provisioning never created one. */
  readOwnProfile(): Promise<Profile | null>
  /** Renames the caller. `expectedVersion` is required, never defaulted. */
  updateOwnProfile(displayName: string, expectedVersion: number): Promise<Profile>
  /** Clears the forced-change flag after the Auth password was changed. */
  acknowledgePasswordChange(expectedVersion: number): Promise<Profile>
}

export interface DataGateway {
  readonly identity: IdentityGateway
  /** The signed-in user's id, or null. */
  currentUserId(): Promise<string | null>
  signInWithPassword(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  /** Changes the caller's own Auth password. Does not clear the forced flag. */
  changeOwnPassword(newPassword: string): Promise<void>
}

/** Row shapes exactly as the `api` views project them. */
interface OrganizationRow {
  id: string
  name: string
  write_locked: boolean
  write_lock_reason: string | null
  version: number
  updated_at: string
}

interface MembershipRow {
  organization_id: string
  user_id: string
  role: MembershipRole
  status: MembershipStatus
}

interface ProfileRow {
  user_id: string
  display_name: string
  must_change_password: boolean
  version: number
}

function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    writeLocked: row.write_locked,
    writeLockReason: row.write_lock_reason,
    version: row.version,
    updatedAt: row.updated_at,
  }
}

function toProfile(row: ProfileRow): Profile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    mustChangePassword: row.must_change_password,
    version: row.version,
  }
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

/**
 * Runs a Supabase call and converts both failure shapes into one.
 *
 * `supabase-js` reports a PostgREST error as a value on the result and a
 * network failure as a thrown `TypeError`, so a caller that only checked
 * `result.error` would treat "the server is unreachable" as success with no
 * data — which is the empty-screen failure §13 refuses. Both paths land here.
 */
async function run<T>(
  operation: () => PromiseLike<{ data: T | null; error: PostgrestFailure | null }>,
): Promise<T> {
  let result: { data: T | null; error: PostgrestFailure | null }
  try {
    result = await operation()
  } catch (cause) {
    throw cloudErrorFromTransport(cause, isOnline())
  }

  if (result.error) {
    throw cloudErrorFromPostgrest(result.error)
  }
  if (result.data === null) {
    throw new CloudError('RECORD_NOT_FOUND', 'the server returned no row')
  }
  return result.data
}

export function createDataGateway(client: CloudClient): DataGateway {
  const identity: IdentityGateway = {
    async listOrganizations() {
      const rows = await run<OrganizationRow[]>(() =>
        client.from('organizations').select('id,name,write_locked,write_lock_reason,version,updated_at'),
      )
      return rows.map(toOrganization)
    },

    async listOwnMemberships() {
      const rows = await run<MembershipRow[]>(() =>
        client.from('memberships').select('organization_id,user_id,role,status'),
      )
      return rows.map((row) => ({
        organizationId: row.organization_id,
        userId: row.user_id,
        role: row.role,
        status: row.status,
      }))
    },

    async readOwnProfile() {
      const userId = await currentUserId()
      if (userId === null) {
        throw new CloudError('SESSION_EXPIRED', 'there is no signed-in user')
      }
      const rows = await run<ProfileRow[]>(() =>
        client
          .from('profiles')
          .select('user_id,display_name,must_change_password,version')
          .eq('user_id', userId),
      )
      // Zero rows is a real state, not an error: an auth account can exist
      // without a profile if provisioning failed between the two, and §4 case A
      // is specifically about converging from there.
      return rows.length === 0 ? null : toProfile(rows[0])
    },

    async updateOwnProfile(displayName, expectedVersion) {
      const rows = await run<ProfileRow[]>(() =>
        client.rpc('update_own_profile', {
          p_display_name: displayName,
          p_expected_version: expectedVersion,
        }),
      )
      return toProfile(rows[0])
    },

    async acknowledgePasswordChange(expectedVersion) {
      const rows = await run<ProfileRow[]>(() =>
        client.rpc('acknowledge_password_change', { p_expected_version: expectedVersion }),
      )
      return toProfile(rows[0])
    },
  }

  async function currentUserId(): Promise<string | null> {
    try {
      const { data, error } = await client.auth.getSession()
      if (error) {
        throw new CloudError('SESSION_EXPIRED', 'the session could not be read')
      }
      return data.session?.user.id ?? null
    } catch (cause) {
      throw cloudErrorFromTransport(cause, isOnline())
    }
  }

  return {
    identity,
    currentUserId,

    async signInWithPassword(email, password) {
      let result: Awaited<ReturnType<typeof client.auth.signInWithPassword>>
      try {
        result = await client.auth.signInWithPassword({ email, password })
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
      if (result.error) {
        // Wrong credentials and a disabled account are deliberately the same
        // answer. Distinguishing them would turn the sign-in form into an
        // oracle for which addresses have accounts, which is the enumeration
        // problem §7 closes everywhere else.
        throw new CloudError('SESSION_EXPIRED', 'the e-mail address or password is not correct')
      }
    },

    async signOut() {
      try {
        await client.auth.signOut()
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
    },

    async changeOwnPassword(newPassword) {
      let result: Awaited<ReturnType<typeof client.auth.updateUser>>
      try {
        result = await client.auth.updateUser({ password: newPassword })
      } catch (cause) {
        throw cloudErrorFromTransport(cause, isOnline())
      }
      if (result.error) {
        throw new CloudError('RECORD_INVALID', 'the password was refused')
      }
    },
  }
}
