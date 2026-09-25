import { describe, expect, it } from 'vitest'
import { createMemoryCloudGateway, TEST_USER_ID } from '../test/memoryCloud'
import { guardRuntimeGateway, type IdentityLoss } from './guardedGateway'

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '22222222-2222-4222-8222-222222222222'

function twoCompanies() {
  return createMemoryCloudGateway({
    organizations: [
      { id: ORG_A, name: 'A', role: 'OWNER' },
      { id: ORG_B, name: 'B', role: 'OWNER' },
    ],
  })
}

describe('the runtime gateway is bound to one organisation (A-L7)', () => {
  it('passes calls for the organisation it was built for', async () => {
    const inner = twoCompanies()
    await inner.catalog.createSupplier(ORG_A, { id: '40000000-0000-4000-8000-000000000001', displayName: 'A supplier' })
    const losses: IdentityLoss[] = []
    const gateway = guardRuntimeGateway(inner, TEST_USER_ID, (loss) => losses.push(loss), ORG_A)
    expect((await gateway.catalog.listSuppliers(ORG_A)).map((record) => record.displayName)).toEqual(['A supplier'])
    expect(await gateway.admin.listMembers(ORG_A)).toHaveLength(1)
    expect(losses).toEqual([])
  })

  it('refuses — before sending — a call naming another organisation the user IS a member of, and reports the loss', async () => {
    const inner = twoCompanies()
    await inner.catalog.createSupplier(ORG_B, { id: '40000000-0000-4000-8000-000000000002', displayName: 'B supplier' })
    const losses: IdentityLoss[] = []
    const gateway = guardRuntimeGateway(inner, TEST_USER_ID, (loss) => losses.push(loss), ORG_A)

    await expect(gateway.catalog.listSuppliers(ORG_B)).rejects.toMatchObject({ code: 'UNEXPECTED' })
    await expect(gateway.admin.provisionMember({ requestId: 'r', organizationId: ORG_B, email: 'x@example.test', displayName: 'X', role: 'MEMBER' }))
      .rejects.toMatchObject({ code: 'UNEXPECTED' })
    expect(losses).toEqual(['ORGANIZATION_CHANGED', 'ORGANIZATION_CHANGED'])
    expect(inner.adminCalls).toEqual([])
  })

  it('without an organisation binding (the legacy migration path) behaves as before', async () => {
    const inner = twoCompanies()
    const gateway = guardRuntimeGateway(inner, TEST_USER_ID, () => undefined)
    await expect(gateway.catalog.listSuppliers(ORG_B)).resolves.toEqual([])
  })
})
