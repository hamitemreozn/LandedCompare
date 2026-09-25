/**
 * Owns the Phase 11 startup gate: configuration -> session -> membership ->
 * one-time legacy catalogue cutover. Business screens are mounted only after
 * every step has produced an authoritative cloud runtime.
 *
 * ## The runtime is bound to one identity (Audit A, A-M2)
 *
 * READY is not a state the application may stay in once the identity it was
 * built for is gone. Three mechanisms end it, each covering what the others
 * cannot:
 *
 * - **Authentication events.** Supabase relays sign-in, sign-out, token
 *   refresh and session replacement — including those made in ANOTHER TAB,
 *   over a BroadcastChannel. A sign-out, or a session that now belongs to a
 *   different user, invalidates the runtime at once: business screens unmount
 *   (their state goes with them) and the boot sequence runs again.
 * - **The runtime gateway guard** (`guardRuntimeGateway`). Every business call
 *   checks the signed-in user before and after the request, so a change the
 *   event has not reported yet can never be rendered as the old identity.
 * - **Live membership.** A membership disabled on the server produces no auth
 *   event. The gateway reports `NO_MEMBERSHIP` when an RLS-empty answer comes
 *   from a lost membership, and the guard reboots into the NO_MEMBERSHIP
 *   screen instead of a list that says "your catalogue is empty".
 *
 * ## Actions are bound to the generation that started them (source review, R-4)
 *
 * The boot run is cancelled by its effect cleanup. The migration and retire
 * ACTIONS outlive the render that started them, so they carry a generation
 * instead: a counter advanced by every invalidation, retry, boot run and
 * sign-out. An action whose generation is no longer current writes no state,
 * and — checked again right before the local database is deleted and before
 * the cutover is marked complete — neither deletes nor marks anything unless
 * the signed-in user is still the one the migration screen was built for.
 *
 * ## One organisation at a time (Phase 12, Audit A A-L7)
 *
 * The boot sequence decides which organisation to enter from LIVE
 * memberships (`bootstrapCloudSession`): exactly one ACTIVE membership is
 * entered, several ask the user unless a remembered choice is still ACTIVE.
 * The remembered choice (`organizationPreference.ts`) is a preference the
 * boot re-checks every time, never authority. Switching company writes the
 * preference and invalidates the runtime exactly like an identity change:
 * business screens unmount with their state, the boot runs again, and the
 * new runtime's gateway refuses any call naming another organisation. A
 * switch made in another tab arrives as a `storage` event and does the same
 * here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CloudConfigError,
  CloudError,
  bootstrapCloudSession,
  createCloudClientFromEnvironment,
  createDataGateway,
  guardRuntimeGateway,
  inspectLegacyCatalog,
  migrateLegacyCatalog,
  retireEmptyLegacyDatabase,
  retireLegacyCatalogWithBackup,
  type CloudBootReady,
  type CloudBootSelection,
  type CloudErrorCode,
  type DataGateway,
  type LegacyCatalogInspection,
  type LegacyMigrationOptions,
} from '../cloud'
import {
  ORGANIZATION_PREFERENCE_KEY,
  parseOrganizationPreference,
  readOrganizationPreference,
  writeOrganizationPreference,
} from './organizationPreference'
import { takeInvitationTokens, type InvitationLinkType, type InvitationTokens } from './invitationLink'
import type { AppRuntime } from './runtime'

export interface ApplicationBootOptions {
  /** A deterministic gateway for tests. Production constructs one from Vite's environment. */
  readonly gateway?: DataGateway
  /** Tests that do not exercise cutover can keep IndexedDB completely out of the run. */
  readonly inspectLegacy?: boolean
  readonly migration?: LegacyMigrationOptions
  /** Where the organisation preference lives. Defaults to `localStorage`. */
  readonly preferenceStorage?: Storage
}

interface MigrationState {
  readonly ready: CloudBootReady
  readonly inspection: Extract<LegacyCatalogInspection, { state: 'MIGRATION_REQUIRED' }>
}

export type BootState =
  | { readonly phase: 'INITIALIZING' }
  | { readonly phase: 'SIGNED_OUT'; readonly code: CloudErrorCode }
  | {
      readonly phase: 'UNAVAILABLE' | 'NO_MEMBERSHIP'
      readonly code: CloudErrorCode
      /** True when a membership exists and was deactivated, rather than never existing. */
      readonly deactivated?: boolean
    }
  /**
   * The legacy database could not be inspected. No counts are known, so none
   * are invented: the screen offers a retry and nothing that writes or deletes
   * (Audit A, A-L2).
   */
  | { readonly phase: 'LEGACY_INSPECTION_FAILED'; readonly failure: unknown }
  /** Several ACTIVE memberships and no valid choice: the user picks (A-L7). */
  | { readonly phase: 'ORGANIZATION_SELECTION'; readonly selection: CloudBootSelection }
  /**
   * An invitation or recovery link arrived while an account is ALREADY signed
   * in on this device — any account, including one the link claims to be
   * for. Nothing is replaced until the person says so (login-CSRF hardening,
   * Phase 12). `invitedEmailHint` is decoded from the link WITHOUT
   * verification: display only.
   */
  | {
      readonly phase: 'INVITATION_CONFIRMATION'
      readonly linkType: InvitationLinkType
      readonly invitedEmailHint: string | null
      readonly currentEmail: string | null
    }
  /**
   * An invitation or recovery link arrived, and whether an account is already
   * signed in on this device could not be established. The link is held, not
   * used: "try again" asks Auth again, "ignore" drops it. Nothing is replaced.
   */
  | { readonly phase: 'INVITATION_CHECK_FAILED'; readonly code: CloudErrorCode }
  | ({ readonly phase: 'MIGRATION_REQUIRED' } & MigrationState)
  | ({ readonly phase: 'MIGRATION_FAILED'; readonly failure: unknown } & MigrationState)
  | { readonly phase: 'READY'; readonly runtime: AppRuntime }

function configuredGateway(): { gateway?: DataGateway; error?: CloudErrorCode } {
  try {
    return {
      gateway: createDataGateway(
        createCloudClientFromEnvironment({
          VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
          VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        }),
      ),
    }
  } catch (cause) {
    if (cause instanceof CloudConfigError) return { error: 'NOT_CONFIGURED' }
    throw cause
  }
}

// React deliberately evaluates memo initialisers twice in development
// StrictMode. A Supabase auth client owns timers and one localStorage key, so
// constructing a throwaway second instance is not a harmless purity probe.
// Production configuration is immutable for the lifetime of a loaded bundle;
// cache the result at the module boundary and keep exactly one auth client.
let productionConfiguredGateway: ReturnType<typeof configuredGateway> | undefined

function getProductionConfiguredGateway(): ReturnType<typeof configuredGateway> {
  productionConfiguredGateway ??= configuredGateway()
  return productionConfiguredGateway
}

/**
 * Who the current state was built for: a user id, `null` for "nobody signed
 * in", or `undefined` while a boot is still running.
 */
type BootedIdentity = string | null | undefined

export function useApplicationBoot(options: ApplicationBootOptions = {}) {
  const configured = useMemo(
    () => (options.gateway ? { gateway: options.gateway } : getProductionConfiguredGateway()),
    [options.gateway],
  )
  const gateway = configured.gateway
  const [state, setState] = useState<BootState>({ phase: 'INITIALIZING' })
  const [attempt, setAttempt] = useState(0)
  const bootedIdentity = useRef<BootedIdentity>(undefined)
  const inspectLegacy = options.inspectLegacy ?? true
  const migration = options.migration
  const preferenceStorage = options.preferenceStorage
  /** Set by "switch company": the next boot shows the selector even if a choice is remembered. */
  const forceSelection = useRef(false)
  /**
   * An invitation link's session, adopted once per page load before the first
   * boot (`invitationLink.ts`). Kept as a promise so a StrictMode re-run of the
   * boot effect waits for the same adoption instead of racing it.
   */
  const invitationTaken = useRef(false)
  const invitation = useRef<Promise<void> | undefined>(undefined)
  /** A link read from the URL and not yet adopted or declined. */
  const pendingInvitation = useRef<InvitationTokens | undefined>(undefined)
  /** The latest state, for the cross-tab listener, which must not re-subscribe on every render. */
  const latest = useRef<BootState>(state)
  latest.current = state

  /** Monotonic. See "Actions are bound to the generation that started them". */
  const generation = useRef(0)

  const retry = useCallback(() => {
    generation.current += 1
    setAttempt((value) => value + 1)
  }, [])

  /**
   * Drops the runtime immediately — business screens unmount before anything
   * else can render — and runs the boot sequence again.
   */
  const invalidate = useCallback(() => {
    generation.current += 1
    bootedIdentity.current = undefined
    setState({ phase: 'INITIALIZING' })
    setAttempt((value) => value + 1)
  }, [])

  /**
   * The check a destructive migration step runs right before it acts, never
   * trusting what the boot cached:
   *
   * 1. the action's generation is still current;
   * 2. the session still belongs to the user the migration screen was built for;
   * 3. that user's LIVE membership in the organisation, re-read from the
   *    server, is ACTIVE — and, when `requireOwner`, has the OWNER role
   *    (source review, pass 3: a role downgraded or a membership disabled
   *    while the backup was being delivered must stop the deletion);
   * 4. after that read, generation and identity are checked once more.
   *
   * Any failure refuses the step and, where the application's state no
   * longer matches the server's, invalidates it so the boot sequence decides
   * again from live state.
   */
  const authorityCheck = useCallback(
    (userId: string, organizationId: string, started: number, requireOwner: boolean) => async () => {
      const stale = () => new CloudError('SESSION_EXPIRED', 'the application state changed while the action was running')
      if (generation.current !== started || !gateway) throw stale()
      const assertSameUser = async () => {
        if ((await gateway.currentUserId()) !== userId) {
          invalidate()
          throw new CloudError('SESSION_EXPIRED', 'a different user is now signed in on this device')
        }
        if (generation.current !== started) throw stale()
      }
      await assertSameUser()

      const memberships = await gateway.identity.listOwnMemberships()
      if (generation.current !== started) throw stale()
      const live = memberships.find(
        (membership) => membership.organizationId === organizationId && membership.userId === userId,
      )
      if (!live || live.status !== 'ACTIVE') {
        invalidate()
        throw new CloudError('NO_MEMBERSHIP', 'the membership is no longer active')
      }
      if (requireOwner && live.role !== 'OWNER') {
        invalidate()
        throw new CloudError('FORBIDDEN', 'only an OWNER may retire the local catalogue')
      }

      await assertSameUser()
    },
    [gateway, invalidate],
  )

  useEffect(() => {
    if (!gateway) return undefined
    return gateway.onAuthChange(({ event, userId }) => {
      if (event === 'INITIAL_SESSION') return
      const booted = bootedIdentity.current
      if (event === 'SIGNED_OUT') {
        if (booted !== null) invalidate()
        return
      }
      if (booted === undefined) {
        // A boot is running. A new sign-in must restart it so the result is
        // built for the session that now exists; a token refresh the boot
        // itself caused must not.
        if (event === 'SIGNED_IN') invalidate()
        return
      }
      if (userId !== booted) invalidate()
    })
  }, [gateway, invalidate])

  useEffect(() => {
    let cancelled = false
    generation.current += 1
    const bootGeneration = generation.current
    bootedIdentity.current = undefined
    setState({ phase: 'INITIALIZING' })

    void (async () => {
      if (!gateway) {
        if (!cancelled) setState({ phase: 'UNAVAILABLE', code: configured.error ?? 'NOT_CONFIGURED' })
        return
      }

      if (!invitationTaken.current) {
        invitationTaken.current = true
        pendingInvitation.current = typeof window === 'undefined' ? undefined : takeInvitationTokens()
      }
      const pending = pendingInvitation.current
      if (pending) {
        // FINAL SESSION ADOPTION RULE (login CSRF):
        //   · Auth confirms NO session on this device → the link is adopted.
        //   · Auth reports ANY session → the person is asked, always. Claims
        //     decoded from the link are unverified — a forged token can name
        //     anyone — so they never decide that the question can be skipped.
        //   · Auth cannot be asked → fail closed: the link is held, not used,
        //     and nothing is treated as "nobody is signed in".
        let current: string | null
        try {
          current = await gateway.currentUserId()
        } catch (cause) {
          if (cancelled) return
          setState({ phase: 'INVITATION_CHECK_FAILED', code: cause instanceof CloudError ? cause.code : 'UNEXPECTED' })
          return
        }
        if (cancelled) return
        if (current !== null) {
          let currentEmail: string | null = null
          try {
            currentEmail = await gateway.currentUserEmail()
          } catch {
            currentEmail = null
          }
          if (cancelled) return
          setState({ phase: 'INVITATION_CONFIRMATION', linkType: pending.type, invitedEmailHint: pending.unverifiedEmailHint ?? null, currentEmail })
          return
        }
        pendingInvitation.current = undefined
        // A link that no longer works leaves the person at the sign-in
        // screen; nothing else depends on it.
        invitation.current = gateway.adoptInvitationSession(pending.accessToken, pending.refreshToken).catch(() => undefined)
      }
      if (invitation.current) await invitation.current
      if (cancelled) return

      const forced = forceSelection.current
      const boot = await bootstrapCloudSession(gateway, {
        preferredOrganizationId: (userId) => readOrganizationPreference(userId, preferenceStorage),
        forceSelection: forced,
      })
      if (cancelled) return
      if (boot.phase === 'ORGANIZATION_SELECTION') {
        bootedIdentity.current = boot.userId
        setState({ phase: 'ORGANIZATION_SELECTION', selection: boot })
        return
      }
      forceSelection.current = false
      if (boot.phase !== 'READY') {
        bootedIdentity.current = boot.phase === 'SIGNED_OUT' ? null : boot.userId ?? null
        setState(
          boot.phase === 'SIGNED_OUT'
            ? { phase: 'SIGNED_OUT', code: boot.code }
            : {
                phase: boot.phase,
                code: boot.code,
                deactivated: (boot.deactivatedOrganizationIds?.length ?? 0) > 0,
              },
        )
        return
      }
      bootedIdentity.current = boot.userId
      // Remembered only after the server confirmed it is an ACTIVE membership.
      writeOrganizationPreference(boot.userId, boot.organization.id, preferenceStorage)

      const runtime: AppRuntime = {
        gateway: guardRuntimeGateway(gateway, boot.userId, () => invalidate(), boot.organization.id),
        userId: boot.userId,
        profile: boot.profile,
        organization: boot.organization,
        membership: boot.membership,
        role: boot.role,
        organizationLocked: boot.organizationLocked,
        choices: boot.choices,
        previousSelectionUnavailable: boot.previousSelectionUnavailable,
        revalidate: invalidate,
        accountEmail: boot.mustChangePassword ? await gateway.currentUserEmail().catch(() => null) : null,
      }
      if (cancelled) return

      if (!inspectLegacy) {
        setState({ phase: 'READY', runtime })
        return
      }

      let inspection: LegacyCatalogInspection
      try {
        inspection = await inspectLegacyCatalog(boot.organization.id, migration)
      } catch (failure) {
        // Fail closed with NO invented counts: nothing here may enable an
        // action that writes to the server or deletes the local database.
        if (!cancelled) setState({ phase: 'LEGACY_INSPECTION_FAILED', failure })
        return
      }
      if (cancelled) return
      if (inspection.state === 'MIGRATION_REQUIRED') {
        setState({ phase: 'MIGRATION_REQUIRED', ready: boot, inspection })
        return
      }
      if (inspection.state === 'EMPTY_DATABASE') {
        try {
          // Deleting an EMPTY database needs no role — only that this boot is
          // still the current one and its user still holds the session.
          await retireEmptyLegacyDatabase(boot.organization.id, {
            ...migration,
            confirmAuthority: async () => {
              const stale = () => new CloudError('SESSION_EXPIRED', 'the boot was superseded')
              if (cancelled || generation.current !== bootGeneration) throw stale()
              if ((await gateway.currentUserId()) !== boot.userId) {
                invalidate()
                throw new CloudError('SESSION_EXPIRED', 'a different user is now signed in on this device')
              }
              if (cancelled || generation.current !== bootGeneration) throw stale()
            },
          })
        } catch (failure) {
          if (!cancelled && generation.current === bootGeneration) setState({ phase: 'LEGACY_INSPECTION_FAILED', failure })
          return
        }
        if (cancelled) return
      }
      setState({ phase: 'READY', runtime })
    })()

    return () => {
      cancelled = true
    }
  }, [attempt, configured.error, gateway, inspectLegacy, invalidate, migration, preferenceStorage])

  // Another tab switched company. The key is shared by every tab of this
  // origin; the event fires in the OTHER tabs only. A READY tab showing a
  // different company for the same user reboots into the new choice; a tab
  // waiting on the selector re-runs its boot, which re-validates the choice
  // against live membership like any other.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onStorage = (event: StorageEvent) => {
      if (event.key !== ORGANIZATION_PREFERENCE_KEY) return
      const preference = parseOrganizationPreference(event.newValue)
      if (preference === undefined) return
      const current = latest.current
      if (current.phase === 'READY') {
        if (preference.userId === current.runtime.userId && preference.organizationId !== current.runtime.organization.id) {
          invalidate()
        }
        return
      }
      if (current.phase === 'ORGANIZATION_SELECTION' && preference.userId === current.selection.userId) {
        // The other tab's choice answers this tab's selector too.
        forceSelection.current = false
        invalidate()
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [invalidate])

  const signIn = useCallback(
    async (email: string, password: string) => {
      if (!gateway) return
      await gateway.signInWithPassword(email, password)
      retry()
    },
    [gateway, retry],
  )
  const signOut = useCallback(async () => {
    if (!gateway) return
    // Business screens unmount first, before the network is involved at all.
    generation.current += 1
    setState({ phase: 'INITIALIZING' })
    try {
      await gateway.signOut()
    } finally {
      // Whatever happened, the next state is decided from what is actually
      // stored: signed out if the session is gone, the same user if it is not.
      retry()
    }
  }, [gateway, retry])
  const changePassword = useCallback(
    async (password: string) => {
      if (!gateway || state.phase !== 'READY') return
      await gateway.changeOwnPassword(password)
      await gateway.identity.acknowledgePasswordChange(state.runtime.profile.version)
      retry()
    },
    [gateway, retry, state],
  )
  const migrate = useCallback(async () => {
    if (!gateway || (state.phase !== 'MIGRATION_REQUIRED' && state.phase !== 'MIGRATION_FAILED')) return
    const action = state
    const started = generation.current
    try {
      await migrateLegacyCatalog(guardRuntimeGateway(gateway, action.ready.userId, () => invalidate()), action.ready.organization.id, {
        ...migration,
        role: action.ready.role,
        // Converging needs an ACTIVE membership, any role; importing is
        // separately OWNER-only on the server.
        confirmAuthority: authorityCheck(action.ready.userId, action.ready.organization.id, started, false),
      })
      if (generation.current === started) retry()
    } catch (failure) {
      // A stale action reports nothing: the screen it would write to is gone,
      // and recreating it would bring back the previous user's company.
      if (generation.current !== started) return
      setState((latest) => (latest === action ? { ...action, phase: 'MIGRATION_FAILED', failure } : latest))
    }
  }, [authorityCheck, gateway, invalidate, migration, retry, state])
  const retireLocal = useCallback(async () => {
    if (!gateway || state.phase !== 'MIGRATION_FAILED' || state.ready.role !== 'OWNER') return
    const action = state
    const started = generation.current
    try {
      await retireLegacyCatalogWithBackup(action.ready.organization.id, {
        ...migration,
        role: action.ready.role,
        confirmAuthority: authorityCheck(action.ready.userId, action.ready.organization.id, started, true),
      })
      if (generation.current === started) retry()
    } catch (failure) {
      if (generation.current !== started) return
      setState((latest) => (latest === action ? { ...action, phase: 'MIGRATION_FAILED', failure } : latest))
    }
  }, [authorityCheck, gateway, migration, retry, state])

  /**
   * Enters one of the offered organisations. The choice is written as a
   * preference and the boot runs again, which enters it only if it is STILL
   * an ACTIVE membership when the server is asked.
   */
  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (state.phase !== 'ORGANIZATION_SELECTION') return
      if (!state.selection.choices.some((choice) => choice.organization.id === organizationId)) return
      writeOrganizationPreference(state.selection.userId, organizationId, preferenceStorage)
      // The user has now chosen; a pending "switch company" is satisfied.
      forceSelection.current = false
      invalidate()
    },
    [invalidate, preferenceStorage, state],
  )

  /** The person confirmed: sign this device in as the account the link belongs to. */
  const acceptInvitation = useCallback(() => {
    const pending = pendingInvitation.current
    if (!gateway || state.phase !== 'INVITATION_CONFIRMATION' || !pending) return
    pendingInvitation.current = undefined
    invitation.current = gateway.adoptInvitationSession(pending.accessToken, pending.refreshToken).catch(() => undefined)
    invalidate()
  }, [gateway, invalidate, state.phase])

  /**
   * The person declined — or chose to ignore a link that could not be
   * checked: the link is dropped and whatever session exists stays exactly as
   * it was.
   */
  const declineInvitation = useCallback(() => {
    if (state.phase !== 'INVITATION_CONFIRMATION' && state.phase !== 'INVITATION_CHECK_FAILED') return
    pendingInvitation.current = undefined
    invalidate()
  }, [invalidate, state.phase])

  /** Leaves the current company and shows the selector. */
  const switchOrganization = useCallback(() => {
    forceSelection.current = true
    invalidate()
  }, [invalidate])

  return {
    state, retry, signIn, signOut, changePassword, migrate, retireLocal, selectOrganization, switchOrganization,
    acceptInvitation, declineInvitation,
  }
}
