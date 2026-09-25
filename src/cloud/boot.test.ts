import { describe, expect, it } from 'vitest'
import { BOOT_IDENTITY_ATTEMPTS, bootstrapCloudSession } from './boot'
import { CloudError } from './errors'
import type { DataGateway, Membership, Organization, Profile } from './gateway'

const USER = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'

const PROFILE: Profile = {
  userId: USER,
  displayName: 'Ayşe Yılmaz',
  mustChangePassword: false,
  version: 1,
}

const ORGANIZATION: Organization = {
  id: ORG_A,
  name: 'Deneme Şirketi A',
  writeLocked: false,
  writeLockReason: null,
  version: 1,
  updatedAt: '2026-09-22T20:12:07.000Z',
}

const MEMBERSHIP: Membership = {
  organizationId: ORG_A,
  userId: USER,
  role: 'OWNER',
  status: 'ACTIVE',
}

interface FakeState {
  userId?: string | null
  profile?: Profile | null
  memberships?: readonly Membership[]
  organizations?: readonly Organization[]
  failWith?: CloudError
}

function fakeGateway(state: FakeState = {}): DataGateway {
  const reject = <T>(): Promise<T> =>
    state.failWith ? Promise.reject(state.failWith) : Promise.reject(new Error('unexpected call'))

  return {
    catalog: {} as DataGateway['catalog'],
    admin: {} as DataGateway['admin'],
    currentUserId: async () => {
      if (state.failWith) {
        throw state.failWith
      }
      return state.userId === undefined ? USER : state.userId
    },
    identity: {
      listOrganizations: async () =>
        state.failWith ? reject<readonly Organization[]>() : (state.organizations ?? [ORGANIZATION]),
      listOwnMemberships: async () =>
        state.failWith ? reject<readonly Membership[]>() : (state.memberships ?? [MEMBERSHIP]),
      readOwnProfile: async () =>
        state.failWith ? reject<Profile | null>() : (state.profile === undefined ? PROFILE : state.profile),
      updateOwnProfile: async () => PROFILE,
      acknowledgePasswordChange: async () => PROFILE,
    },
    signInWithPassword: async () => {},
    signOut: async () => {},
    onAuthChange: () => () => {},
    changeOwnPassword: async () => {},
    adoptInvitationSession: async () => {},
    currentUserEmail: async () => null,
  }
}

describe('bootstrapCloudSession', () => {
  it('reaches READY with the resolved organisation, role and profile', async () => {
    const result = await bootstrapCloudSession(fakeGateway())

    expect(result).toMatchObject({
      phase: 'READY',
      userId: USER,
      role: 'OWNER',
      mustChangePassword: false,
      organizationLocked: false,
    })
  })

  it('reports SIGNED_OUT when there is no session', async () => {
    const result = await bootstrapCloudSession(fakeGateway({ userId: null }))
    expect(result).toEqual({ phase: 'SIGNED_OUT', code: 'SESSION_EXPIRED' })
  })

  it('reports UNAVAILABLE rather than an empty product when the server does not answer', async () => {
    // The reason this is a named state and not an empty list: an application
    // that shows an empty catalogue because the server is unreachable has told
    // the user their data is gone, and the natural response is to start
    // re-entering it.
    const result = await bootstrapCloudSession(
      fakeGateway({ failWith: new CloudError('SERVER_UNAVAILABLE', 'unreachable') }),
    )
    expect(result).toEqual({ phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE' })
  })

  it('keeps OFFLINE distinct from SERVER_UNAVAILABLE', async () => {
    // Different remedies. "Check your internet" and "ask your administrator to
    // resume the project" are not interchangeable sentences.
    const result = await bootstrapCloudSession(
      fakeGateway({ failWith: new CloudError('OFFLINE', 'no network') }),
    )
    expect(result).toEqual({ phase: 'UNAVAILABLE', code: 'OFFLINE' })
  })

  it('reports NO_MEMBERSHIP for an account attached to nothing', async () => {
    const result = await bootstrapCloudSession(fakeGateway({ memberships: [], organizations: [] }))
    expect(result).toEqual({ phase: 'NO_MEMBERSHIP', code: 'NO_MEMBERSHIP', userId: USER })
  })

  it('distinguishes "deactivated here" from "never attached to anything"', async () => {
    // A DISABLED membership row stays readable by its owner precisely so the
    // interface can say WHY. Both cases stop the boot; only one of them can
    // honestly say "talk to the administrator of this company".
    const result = await bootstrapCloudSession(
      fakeGateway({
        memberships: [{ ...MEMBERSHIP, status: 'DISABLED' }],
        organizations: [],
      }),
    )

    expect(result).toEqual({
      phase: 'NO_MEMBERSHIP',
      code: 'NO_MEMBERSHIP',
      userId: USER,
      deactivatedOrganizationIds: [ORG_A],
    })
  })

  it('reports NO_MEMBERSHIP when provisioning left an account without a profile', async () => {
    // §4 case A: the auth user exists and the linking transaction failed. The
    // account is real and belongs to nobody, which is a state the boot has to
    // name rather than crash on.
    const result = await bootstrapCloudSession(fakeGateway({ profile: null }))
    expect(result.phase).toBe('NO_MEMBERSHIP')
  })

  it('ignores DISABLED memberships when choosing', async () => {
    const disabledFirst: Membership = {
      organizationId: '00000000-0000-4000-8000-000000000000',
      userId: USER,
      role: 'OWNER',
      status: 'DISABLED',
    }

    const result = await bootstrapCloudSession(
      fakeGateway({ memberships: [disabledFirst, MEMBERSHIP] }),
    )
    expect(result).toMatchObject({ phase: 'READY', organization: { id: ORG_A } })
  })

  it('surfaces a held write gate as state rather than as a failure', async () => {
    // ORGANIZATION_LOCKED is the one degraded state in which READING still
    // works, so the boot completes and the shell renders with saving disabled.
    // Refusing to start would be both wrong and more alarming than the truth.
    const result = await bootstrapCloudSession(
      fakeGateway({
        organizations: [{ ...ORGANIZATION, writeLocked: true, writeLockReason: 'RESTORE' }],
      }),
    )

    expect(result).toMatchObject({ phase: 'READY', organizationLocked: true })
  })

  it('carries the forced password change into the boot result', async () => {
    const result = await bootstrapCloudSession(
      fakeGateway({ profile: { ...PROFILE, mustChangePassword: true } }),
    )
    expect(result).toMatchObject({ phase: 'READY', mustChangePassword: true })
  })

  it('reports UNAVAILABLE when an ACTIVE membership names an invisible organisation', async () => {
    // Two policies disagreeing is a server-side fault, not a user state.
    // Reporting it as unavailable is honest; rendering an empty product is not.
    const result = await bootstrapCloudSession(fakeGateway({ organizations: [] }))
    expect(result).toEqual({ phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE', userId: USER })
  })

  it('lets a genuine bug propagate instead of disguising it as a boot state', async () => {
    const broken = fakeGateway()
    const gateway: DataGateway = {
      ...broken,
      currentUserId: async () => {
        throw new TypeError('a real bug')
      },
    }

    await expect(bootstrapCloudSession(gateway)).rejects.toThrow('a real bug')
  })
})

describe('organisation selection (Audit A, A-L7)', () => {
  const ORG_C = '33333333-3333-4333-8333-333333333333'
  const organizationB: Organization = { ...ORGANIZATION, id: ORG_B, name: 'Deneme Şirketi B' }
  const organizationC: Organization = { ...ORGANIZATION, id: ORG_C, name: 'Alfa Ltd' }
  const inB: Membership = { organizationId: ORG_B, userId: USER, role: 'MEMBER', status: 'ACTIVE' }
  const inC: Membership = { organizationId: ORG_C, userId: USER, role: 'ADMIN', status: 'ACTIVE' }
  const two = { memberships: [MEMBERSHIP, inB], organizations: [ORGANIZATION, organizationB] }

  it('zero ACTIVE memberships: NO_MEMBERSHIP, whatever was remembered', async () => {
    const result = await bootstrapCloudSession(
      fakeGateway({ memberships: [{ ...MEMBERSHIP, status: 'DISABLED' }], organizations: [] }),
      { preferredOrganizationId: () => ORG_A },
    )
    expect(result).toMatchObject({ phase: 'NO_MEMBERSHIP', deactivatedOrganizationIds: [ORG_A] })
  })

  it('exactly one ACTIVE membership: entered automatically, with no selector', async () => {
    const result = await bootstrapCloudSession(fakeGateway(), {})
    expect(result).toMatchObject({ phase: 'READY', organization: { id: ORG_A }, previousSelectionUnavailable: false })
    expect(result.phase === 'READY' && result.choices.map((choice) => choice.organization.id)).toEqual([ORG_A])
  })

  it('several ACTIVE memberships and nothing remembered: the user chooses, and nothing is entered', async () => {
    const result = await bootstrapCloudSession(fakeGateway(two), {})
    expect(result).toMatchObject({ phase: 'ORGANIZATION_SELECTION', userId: USER, previousSelectionUnavailable: false })
    expect(result).not.toHaveProperty('organization')
  })

  it('lists the choices by name, then id, whatever order the server returned', async () => {
    const forward = await bootstrapCloudSession(
      fakeGateway({ memberships: [MEMBERSHIP, inB, inC], organizations: [ORGANIZATION, organizationB, organizationC] }),
    )
    const reversed = await bootstrapCloudSession(
      fakeGateway({ memberships: [inC, inB, MEMBERSHIP], organizations: [organizationC, organizationB, ORGANIZATION] }),
    )
    expect(forward).toEqual(reversed)
    expect(forward.phase === 'ORGANIZATION_SELECTION' && forward.choices.map((choice) => [choice.organization.name, choice.role])).toEqual([
      ['Alfa Ltd', 'ADMIN'],
      ['Deneme Şirketi A', 'OWNER'],
      ['Deneme Şirketi B', 'MEMBER'],
    ])
  })

  it('a remembered choice that is still ACTIVE is entered, with its own role', async () => {
    const result = await bootstrapCloudSession(fakeGateway(two), { preferredOrganizationId: () => ORG_B })
    expect(result).toMatchObject({ phase: 'READY', organization: { id: ORG_B }, role: 'MEMBER', previousSelectionUnavailable: false })
  })

  it('the preference is asked for THIS user only', async () => {
    const asked: string[] = []
    await bootstrapCloudSession(fakeGateway(two), { preferredOrganizationId: (userId) => { asked.push(userId); return undefined } })
    expect(asked).toEqual([USER])
  })

  it('a stale choice (an organisation the user was never, or is no longer, in) fails closed to the selector', async () => {
    const result = await bootstrapCloudSession(fakeGateway(two), {
      preferredOrganizationId: () => '99999999-9999-4999-8999-999999999999',
    })
    expect(result).toMatchObject({ phase: 'ORGANIZATION_SELECTION', previousSelectionUnavailable: true })
  })

  it('a remembered choice whose membership was DISABLED is not entered', async () => {
    const result = await bootstrapCloudSession(
      fakeGateway({ memberships: [MEMBERSHIP, { ...inB, status: 'DISABLED' }, inC], organizations: [ORGANIZATION, organizationC] }),
      { preferredOrganizationId: () => ORG_B },
    )
    expect(result).toMatchObject({ phase: 'ORGANIZATION_SELECTION', previousSelectionUnavailable: true })
    expect(result.phase === 'ORGANIZATION_SELECTION' && result.choices.map((choice) => choice.organization.id)).toEqual([ORG_C, ORG_A])
  })

  it('the remembered choice was removed and ONE membership remains: entered, and the change is reported', async () => {
    const result = await bootstrapCloudSession(fakeGateway(), { preferredOrganizationId: () => ORG_B })
    expect(result).toMatchObject({ phase: 'READY', organization: { id: ORG_A }, previousSelectionUnavailable: true })
  })

  it('"switch company" shows the selector even though the remembered choice is valid', async () => {
    const result = await bootstrapCloudSession(fakeGateway(two), { preferredOrganizationId: () => ORG_A, forceSelection: true })
    expect(result).toMatchObject({ phase: 'ORGANIZATION_SELECTION', previousSelectionUnavailable: false })
  })

  it('"switch company" with only one membership left simply enters it', async () => {
    const result = await bootstrapCloudSession(fakeGateway(), { forceSelection: true })
    expect(result).toMatchObject({ phase: 'READY', organization: { id: ORG_A } })
  })

  it('an ACTIVE membership among several whose organisation is invisible is a server fault, not a smaller list', async () => {
    const result = await bootstrapCloudSession(fakeGateway({ memberships: [MEMBERSHIP, inB], organizations: [ORGANIZATION] }))
    expect(result).toEqual({ phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE', userId: USER })
  })
})

/**
 * A session that belongs to user A when the boot starts and to user B from
 * the moment the profile has been read — another tab signing in as B, while
 * this tab's boot is between two requests (source review, N-1). Every read
 * answers for whoever holds the session at that moment, as PostgREST does.
 */
function replacedMidBoot(switches: number): { gateway: DataGateway; identityReads: () => number } {
  const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
  const users = [USER, USER_B, 'cccccccc-0000-4000-8000-00000000000c', 'dddddddd-0000-4000-8000-00000000000d']
  let holder = 0
  let reads = 0
  const who = () => users[holder]
  const orgOf = (user: string) => (user === USER ? ORGANIZATION : { ...ORGANIZATION, id: ORG_B, name: `Company of ${user.slice(0, 4)}` })
  return {
    identityReads: () => reads,
    gateway: {
      catalog: {} as DataGateway['catalog'],
      admin: {} as DataGateway['admin'],
      currentUserId: async () => { reads += 1; return who() },
      identity: {
        readOwnProfile: async () => {
          const profile = { ...PROFILE, userId: who(), displayName: `Profile of ${who().slice(0, 4)}` }
          if (holder < switches) holder += 1
          return profile
        },
        listOwnMemberships: async () => [{ ...MEMBERSHIP, userId: who(), organizationId: orgOf(who()).id }],
        listOrganizations: async () => [orgOf(who())],
        updateOwnProfile: async () => PROFILE,
        acknowledgePasswordChange: async () => PROFILE,
      },
      signInWithPassword: async () => {},
      signOut: async () => {},
      changeOwnPassword: async () => {},
      adoptInvitationSession: async () => {},
      currentUserEmail: async () => null,
      onAuthChange: () => () => {},
    },
  }
}

describe('the identity at the end of the boot is the identity it started with (source review, N-1)', () => {
  it('A → B between two reads: A\'s id is never published beside B\'s profile or company; the boot restarts as B', async () => {
    const { gateway } = replacedMidBoot(1)
    const result = await bootstrapCloudSession(gateway)
    expect(result.phase).toBe('READY')
    if (result.phase !== 'READY') return
    expect(result.userId).toBe('bbbbbbbb-0000-4000-8000-00000000000b')
    expect(result.profile.userId).toBe(result.userId)
    expect(result.membership.userId).toBe(result.userId)
    expect(result.organization.id).toBe(ORG_B)
  })

  it('a session that changes under every attempt is not chased forever and is never published', async () => {
    const { gateway, identityReads } = replacedMidBoot(BOOT_IDENTITY_ATTEMPTS)
    await expect(bootstrapCloudSession(gateway)).resolves.toEqual({ phase: 'UNAVAILABLE', code: 'UNEXPECTED' })
    // One read at the start and one at the end of each attempt.
    expect(identityReads()).toBe(2 * BOOT_IDENTITY_ATTEMPTS)
  })
})
