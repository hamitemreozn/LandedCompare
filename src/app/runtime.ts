/**
 * The authenticated cloud runtime available below the boot gate.
 *
 * No IndexedDB handle crosses this boundary. Business screens receive one
 * DataGateway and the deterministically selected organisation; PostgreSQL is
 * therefore the only canonical source they can address.
 */
import { createContext, useContext } from 'react'
import type {
  DataGateway,
  Membership,
  MembershipRole,
  Organization,
  Profile,
} from '../cloud'

export interface AppRuntime {
  readonly gateway: DataGateway
  readonly userId: string
  readonly profile: Profile
  readonly organization: Organization
  readonly membership: Membership
  readonly role: MembershipRole
  readonly organizationLocked: boolean
}

export const AppRuntimeContext = createContext<AppRuntime | null>(null)

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext)
  if (runtime === null) {
    throw new Error('useAppRuntime was called outside AppRuntimeProvider')
  }
  return runtime
}
