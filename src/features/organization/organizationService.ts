/**
 * Organisation administration, as the screen uses it (Phase 12).
 *
 * The screen's idea of what the user may do is read from LIVE membership on
 * every load, not from the role the boot cached: a user demoted in another
 * tab or by another administrator sees the member-only view on the next load
 * rather than buttons the server will refuse. The server refuses them anyway
 * — every mutation re-proves OWNER/ADMIN inside the RPC or Edge Function —
 * so this is presentation, never the control.
 */
import type {
  DataGateway,
  MembershipRole,
  MembershipStatus,
  OrganizationMember,
  ProvisionMemberResult,
  ProvisioningAttemptList,
} from '../../cloud'
import { FormValidationError, requiredText } from '../shared/formError'

export interface OrganizationAdministration {
  /** The caller's role here right now, or null when the membership is no longer ACTIVE. */
  readonly liveRole: MembershipRole | null
  /** Present only for an OWNER/ADMIN. */
  readonly members?: readonly OrganizationMember[]
  readonly attempts?: ProvisioningAttemptList
}

export function isAdministrator(role: MembershipRole | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

export async function loadOrganizationAdministration(
  gateway: DataGateway,
  organizationId: string,
  userId: string,
): Promise<OrganizationAdministration> {
  const own = (await gateway.identity.listOwnMemberships()).find(
    (membership) => membership.organizationId === organizationId && membership.userId === userId && membership.status === 'ACTIVE',
  )
  const liveRole = own?.role ?? null
  if (!isAdministrator(liveRole)) {
    return { liveRole }
  }
  const members = await gateway.admin.listMembers(organizationId)
  const attempts = await gateway.admin.listInFlightProvisioningAttempts(organizationId)
  return { liveRole, members, attempts }
}

/**
 * The roles a caller may assign. An ADMIN never offers OWNER; the server
 * refuses it regardless.
 */
export function assignableRoles(actor: MembershipRole | null): readonly MembershipRole[] {
  if (actor === 'OWNER') return ['OWNER', 'ADMIN', 'MEMBER']
  if (actor === 'ADMIN') return ['ADMIN', 'MEMBER']
  return []
}

/**
 * Whether the screen offers changes on this row. Mirrors the server rule —
 * nobody edits their own membership; an ADMIN does not touch an OWNER's — so
 * the screen does not offer what will be refused.
 */
export function canManage(actor: MembershipRole | null, actorUserId: string, member: OrganizationMember): boolean {
  if (!isAdministrator(actor) || member.userId === actorUserId) return false
  return actor === 'OWNER' || member.role !== 'OWNER'
}

export function changeMemberRole(
  gateway: DataGateway,
  organizationId: string,
  member: OrganizationMember,
  role: MembershipRole,
): Promise<OrganizationMember> {
  return gateway.admin.setMemberRole(organizationId, member.userId, member.version, role)
}

export function changeMemberStatus(
  gateway: DataGateway,
  organizationId: string,
  member: OrganizationMember,
  status: MembershipStatus,
): Promise<OrganizationMember> {
  return gateway.admin.setMemberStatus(organizationId, member.userId, member.version, status)
}

export function clearProvisioningAttempt(gateway: DataGateway, organizationId: string, requestId: string): Promise<void> {
  return gateway.admin.clearProvisioningAttempt(organizationId, requestId)
}

export interface InvitationDraft {
  readonly email: string
  readonly displayName: string
  readonly role: MembershipRole
}

export const EMPTY_INVITATION: InvitationDraft = { email: '', displayName: '', role: 'MEMBER' }

/** The shape `api.begin_provisioning` accepts; checked here only to name the field. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Gives an address access to the organisation: Auth invites a new address by
 * e-mail, and an existing account is linked. The answer is the same either
 * way and carries no credential. `requestId` is the caller's: the screen
 * generates it once per invitation and reuses it on a retry of the same
 * invitation, which is what lets the server converge instead of creating a
 * second account (§4 case B).
 */
export async function inviteMember(
  gateway: DataGateway,
  organizationId: string,
  requestId: string,
  draft: InvitationDraft,
): Promise<ProvisionMemberResult> {
  const email = draft.email.trim().toLowerCase()
  if (!EMAIL_SHAPE.test(email)) {
    throw new FormValidationError('email', 'organization.invite.invalidEmail')
  }
  return gateway.admin.provisionMember({
    requestId,
    organizationId,
    email,
    displayName: requiredText(draft.displayName, 'displayName'),
    role: draft.role,
  })
}
