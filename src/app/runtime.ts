/**
 * The authenticated cloud runtime available below the boot gate.
 *
 * No IndexedDB handle crosses this boundary. Business screens receive one
 * DataGateway, bound to the signed-in user AND to the one organisation this
 * runtime was built for; PostgreSQL is therefore the only canonical source
 * they can address, and only for the company the shell names.
 */
import { createContext, useContext } from 'react'
import type {
  DataGateway,
  Membership,
  MembershipRole,
  Organization,
  OrganizationChoice,
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
  /** Every organisation the user may enter right now; more than one enables "switch company". */
  readonly choices: readonly OrganizationChoice[]
  /** The remembered company is no longer available and this one was entered instead. */
  readonly previousSelectionUnavailable: boolean
  /**
   * Drops this runtime and boots again from live state. Used when the server
   * refuses something the screen believed it was allowed to do, so the
   * screen's idea of the user's authority is rebuilt rather than trusted.
   */
  readonly revalidate: () => void
  /** The signed-in account's own e-mail address — shown only to that person. */
  readonly accountEmail: string | null
}

export const AppRuntimeContext = createContext<AppRuntime | null>(null)

export function useAppRuntime(): AppRuntime {
  const runtime = useContext(AppRuntimeContext)
  if (runtime === null) {
    throw new Error('useAppRuntime was called outside AppRuntimeProvider')
  }
  return runtime
}
