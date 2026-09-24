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
  type CloudErrorCode,
  type DataGateway,
  type LegacyCatalogInspection,
  type LegacyMigrationOptions,
} from '../cloud'
import type { AppRuntime } from './runtime'

export interface ApplicationBootOptions {
  /** A deterministic gateway for tests. Production constructs one from Vite's environment. */
  readonly gateway?: DataGateway
  /** Tests that do not exercise cutover can keep IndexedDB completely out of the run. */
  readonly inspectLegacy?: boolean
  readonly migration?: LegacyMigrationOptions
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

      const boot = await bootstrapCloudSession(gateway)
      if (cancelled) return
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

      const runtime: AppRuntime = {
        gateway: guardRuntimeGateway(gateway, boot.userId, () => invalidate()),
        userId: boot.userId,
        profile: boot.profile,
        organization: boot.organization,
        membership: boot.membership,
        role: boot.role,
        organizationLocked: boot.organizationLocked,
      }

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
  }, [attempt, configured.error, gateway, inspectLegacy, invalidate, migration])

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

  return { state, retry, signIn, signOut, changePassword, migrate, retireLocal }
}
