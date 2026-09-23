/**
 * Owns the Phase 11 startup gate: configuration -> session -> membership ->
 * one-time legacy catalogue cutover. Business screens are mounted only after
 * every step has produced an authoritative cloud runtime.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CloudConfigError,
  bootstrapCloudSession,
  createCloudClientFromEnvironment,
  createDataGateway,
  inspectLegacyCatalog,
  migrateLegacyCatalog,
  retireEmptyLegacyDatabase,
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
  | { readonly phase: 'UNAVAILABLE' | 'NO_MEMBERSHIP'; readonly code: CloudErrorCode }
  | ({ readonly phase: 'MIGRATION_REQUIRED' } & MigrationState)
  | ({ readonly phase: 'MIGRATION_FAILED'; readonly failure: unknown } & MigrationState)
  | { readonly phase: 'READY'; readonly runtime: AppRuntime }

function runtimeOf(gateway: DataGateway, ready: CloudBootReady): AppRuntime {
  return {
    gateway,
    userId: ready.userId,
    profile: ready.profile,
    organization: ready.organization,
    membership: ready.membership,
    role: ready.role,
    organizationLocked: ready.organizationLocked,
  }
}

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

export function useApplicationBoot(options: ApplicationBootOptions = {}) {
  const configured = useMemo(
    () => (options.gateway ? { gateway: options.gateway } : getProductionConfiguredGateway()),
    [options.gateway],
  )
  const gateway = configured.gateway
  const [state, setState] = useState<BootState>({ phase: 'INITIALIZING' })
  const [attempt, setAttempt] = useState(0)
  const inspectLegacy = options.inspectLegacy ?? true
  const migration = options.migration

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'INITIALIZING' })

    void (async () => {
      if (!gateway) {
        if (!cancelled) setState({ phase: 'UNAVAILABLE', code: configured.error ?? 'NOT_CONFIGURED' })
        return
      }

      const boot = await bootstrapCloudSession(gateway)
      if (cancelled) return
      if (boot.phase !== 'READY') {
        setState(boot)
        return
      }

      if (!inspectLegacy) {
        setState({ phase: 'READY', runtime: runtimeOf(gateway, boot) })
        return
      }

      try {
        const inspection = await inspectLegacyCatalog(boot.organization.id, migration)
        if (cancelled) return
        if (inspection.state === 'EMPTY_DATABASE') {
          await retireEmptyLegacyDatabase(boot.organization.id, migration)
          if (cancelled) return
        } else if (inspection.state === 'MIGRATION_REQUIRED') {
          setState({ phase: 'MIGRATION_REQUIRED', ready: boot, inspection })
          return
        }
        setState({ phase: 'READY', runtime: runtimeOf(gateway, boot) })
      } catch (failure) {
        if (!cancelled) {
          setState({
            phase: 'MIGRATION_FAILED',
            ready: boot,
            inspection: {
              state: 'MIGRATION_REQUIRED',
              counts: { products: 0, suppliers: 0, customers: 0, otherBusinessRecords: 0 },
            },
            failure,
          })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [attempt, configured.error, gateway, inspectLegacy, migration])

  const retry = useCallback(() => setAttempt((value) => value + 1), [])
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
    await gateway.signOut()
    retry()
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
    if (state.ready.role !== 'OWNER') return
    try {
      await migrateLegacyCatalog(gateway, state.ready.organization.id, migration)
      retry()
    } catch (failure) {
      setState({ ...state, phase: 'MIGRATION_FAILED', failure })
    }
  }, [gateway, migration, retry, state])

  return { state, retry, signIn, signOut, changePassword, migrate }
}
