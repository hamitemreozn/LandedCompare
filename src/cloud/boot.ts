/**
 * The cloud boot gate: session → reachability → membership.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §13 and §17.
 *
 * ## The idea this inherits, unchanged
 *
 * `src/app/bootstrap.ts` refuses to render business data until it knows it has
 * a working data source. Locally that meant "the database opened". Against
 * shared data it means "there is a valid session, the server answered, and the
 * caller has an ACTIVE membership" — and the principle matters MORE, not less:
 *
 * > An application that shows an empty product table because the server is
 * > unreachable has told the user their catalogue is gone, and the natural
 * > response is to start re-entering it.
 *
 * So none of the failure states below renders an empty list. Each one is a
 * named state with its own sentence, because treating them alike is how a user
 * is told the wrong thing — "no internet" and "the project is paused" have
 * different remedies, and "your account is not attached to a company" is not a
 * fault at all.
 *
 * ## Phase 11 runtime boundary
 *
 * The running application now passes this gate before rendering catalogue
 * screens. A failed reachability, session, membership or write-lock check is an
 * explicit state; it never falls back to legacy IndexedDB business data.
 */

import { CloudError, isCloudError } from './errors'
import type { DataGateway, Membership, MembershipRole, Organization, Profile } from './gateway'

export type CloudBootPhase =
  /** The sequence is running. Nothing business-related may be rendered. */
  | 'INITIALIZING'
  /** Session, server and membership all resolved. */
  | 'READY'
  /** No session, or one that could not be refreshed. Show the sign-in screen. */
  | 'SIGNED_OUT'
  /** The server did not answer. Reading and writing are both unavailable. */
  | 'UNAVAILABLE'
  /**
   * Authenticated, and a member of nothing ACTIVE. A distinct state because the
   * user has done nothing wrong and the remedy is an administrator.
   */
  | 'NO_MEMBERSHIP'

export interface CloudBootReady {
  readonly phase: 'READY'
  readonly userId: string
  readonly profile: Profile
  readonly organization: Organization
  readonly membership: Membership
  readonly role: MembershipRole
  /**
   * True when the administrator issued this password and the user has not yet
   * replaced it (§4 step 5). The shell routes to the change-password screen and
   * nowhere else while this holds.
   */
  readonly mustChangePassword: boolean
  /** Set while the organisation is write-locked for a restore (§16). */
  readonly organizationLocked: boolean
}

export interface CloudBootStopped {
  readonly phase: 'SIGNED_OUT' | 'UNAVAILABLE' | 'NO_MEMBERSHIP'
  /** The code the shell maps to a sentence. Never a raw server message. */
  readonly code: CloudError['code']
  /**
   * Set only for NO_MEMBERSHIP, and only when the user HAS a membership that
   * has been deactivated. "You were removed from this company" and "your
   * account was never attached to one" are different sentences, and the
   * difference is visible because a DISABLED membership row stays readable by
   * its owner.
   */
  readonly deactivatedOrganizationIds?: readonly string[]
}

export type CloudBootResult = CloudBootReady | CloudBootStopped

/**
 * Runs the cloud boot sequence and reports where it got to.
 *
 * Never throws for an expected failure, for the same reason
 * `bootstrapApplication` does not: the caller is a React tree that has to
 * render something, and an exception would make "the project is paused"
 * indistinguishable from a bug in this function. Unexpected throwables still
 * propagate — they are bugs, and swallowing them into a generic error screen is
 * how a bug becomes a support ticket about Supabase.
 */
export async function bootstrapCloudSession(gateway: DataGateway): Promise<CloudBootResult> {
  // ── 1. Session ─────────────────────────────────────────────────────────
  let userId: string | null
  try {
    userId = await gateway.currentUserId()
  } catch (cause) {
    return stopped(cause)
  }

  if (userId === null) {
    return { phase: 'SIGNED_OUT', code: 'SESSION_EXPIRED' }
  }

  // ── 2. Reachability and membership, in one round trip each ─────────────
  //
  // The profile read is what proves the server answered AND that the session's
  // token is accepted by it. A session that exists in `localStorage` is not a
  // session the server agrees with — a revoked refresh token looks identical
  // until something is asked of it.
  let profile: Profile | null
  let memberships: readonly Membership[]
  let organizations: readonly Organization[]
  try {
    profile = await gateway.identity.readOwnProfile()
    memberships = await gateway.identity.listOwnMemberships()
    organizations = await gateway.identity.listOrganizations()
  } catch (cause) {
    return stopped(cause)
  }

  const active = memberships.filter((membership) => membership.status === 'ACTIVE')

  if (profile === null || active.length === 0) {
    const deactivated = memberships
      .filter((membership) => membership.status === 'DISABLED')
      .map((membership) => membership.organizationId)

    return {
      phase: 'NO_MEMBERSHIP',
      code: 'NO_MEMBERSHIP',
      ...(deactivated.length > 0 ? { deactivatedOrganizationIds: deactivated } : {}),
    }
  }

  // The MVP interface assumes exactly one active membership and selects it
  // without an organisation picker (§5). The DATA MODEL permits several,
  // deliberately — a join table costs nothing today where a single column would
  // cost a migration the first time it is wrong — so the selection is made here
  // rather than by pretending the second row cannot exist. Ordering by
  // organisation id makes the choice deterministic across devices instead of
  // dependent on whatever order the server returned.
  const membership = [...active].sort((left, right) =>
    left.organizationId.localeCompare(right.organizationId),
  )[0]

  const organization = organizations.find((candidate) => candidate.id === membership.organizationId)

  if (!organization) {
    // An ACTIVE membership whose organisation is invisible means the two
    // policies disagree, which is a server-side fault rather than a user state.
    // Reporting it as "unavailable" is honest; rendering an empty product would
    // not be.
    return { phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE' }
  }

  return {
    phase: 'READY',
    userId,
    profile,
    organization,
    membership,
    role: membership.role,
    mustChangePassword: profile.mustChangePassword,
    organizationLocked: organization.writeLocked,
  }
}

function stopped(cause: unknown): CloudBootStopped {
  if (!isCloudError(cause)) {
    throw cause
  }
  switch (cause.code) {
    case 'SESSION_EXPIRED':
      return { phase: 'SIGNED_OUT', code: 'SESSION_EXPIRED' }
    case 'FORBIDDEN':
    case 'NO_MEMBERSHIP':
      return { phase: 'NO_MEMBERSHIP', code: cause.code }
    case 'OFFLINE':
      return { phase: 'UNAVAILABLE', code: 'OFFLINE' }
    default:
      return { phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE' }
  }
}
