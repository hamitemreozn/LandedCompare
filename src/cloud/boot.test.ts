import { describe, expect, it } from 'vitest'
import { bootstrapCloudSession } from './boot'
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
    changeOwnPassword: async () => {},
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
    expect(result).toEqual({ phase: 'NO_MEMBERSHIP', code: 'NO_MEMBERSHIP' })
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

  it('selects one organisation deterministically when a user belongs to several', async () => {
    // The MVP interface assumes one active membership and selects it without a
    // picker. The DATA MODEL permits several — a join table costs nothing today
    // where a single column would cost a migration the first time it is wrong —
    // so the choice is made explicitly here rather than by pretending the
    // second row cannot exist, and it does not depend on server row order.
    const second: Membership = {
      organizationId: ORG_B,
      userId: USER,
      role: 'MEMBER',
      status: 'ACTIVE',
    }
    const organizationB: Organization = { ...ORGANIZATION, id: ORG_B, name: 'Deneme Şirketi B' }

    const forward = await bootstrapCloudSession(
      fakeGateway({ memberships: [MEMBERSHIP, second], organizations: [ORGANIZATION, organizationB] }),
    )
    const reversed = await bootstrapCloudSession(
      fakeGateway({ memberships: [second, MEMBERSHIP], organizations: [organizationB, ORGANIZATION] }),
    )

    expect(forward).toEqual(reversed)
    expect(forward).toMatchObject({ phase: 'READY', role: 'OWNER' })
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
    expect(result).toEqual({ phase: 'UNAVAILABLE', code: 'SERVER_UNAVAILABLE' })
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
