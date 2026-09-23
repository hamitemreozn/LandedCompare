/** Phase 11 cloud boot gate and route composition. */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApplicationBoot, type ApplicationBootOptions } from './app/useApplicationBoot'
import { useRoute } from './app/useRoute'
import { AppRuntimeContext } from './app/runtime'
import { ProductsScreen } from './features/catalog/ProductsScreen'
import { DashboardScreen } from './features/dashboard/DashboardScreen'
import { CustomersScreen } from './features/parties/CustomersScreen'
import { CustomerStatusesScreen } from './features/parties/CustomerStatusesScreen'
import { SuppliersScreen } from './features/parties/SuppliersScreen'
import {
  BootLoadingScreen,
  CatalogMigrationScreen,
  CloudFailureScreen,
  PasswordChangeScreen,
  SignInScreen,
} from './features/shell/BootScreens'
import { AppShell } from './features/shell/AppShell'
import { getLocale } from './i18n'

export default function App({ options }: { readonly options?: ApplicationBootOptions } = {}) {
  const { i18n } = useTranslation()
  const { state, retry, signIn, signOut, changePassword, migrate } = useApplicationBoot(options)
  const { route } = useRoute()

  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  if (state.phase === 'INITIALIZING') return <BootLoadingScreen />
  if (state.phase === 'SIGNED_OUT') return <SignInScreen onSignIn={signIn} />
  if (state.phase === 'UNAVAILABLE' || state.phase === 'NO_MEMBERSHIP') {
    return <CloudFailureScreen code={state.code} onRetry={retry} />
  }
  if (state.phase === 'MIGRATION_REQUIRED' || state.phase === 'MIGRATION_FAILED') {
    return (
      <CatalogMigrationScreen
        counts={state.inspection.counts}
        canMigrate={state.ready.role === 'OWNER'}
        failure={state.phase === 'MIGRATION_FAILED' ? state.failure : undefined}
        onMigrate={migrate}
      />
    )
  }
  if (state.phase !== 'READY') return null
  if (state.runtime.profile.mustChangePassword) {
    return <PasswordChangeScreen onChange={changePassword} />
  }

  void i18n.language
  const locale = getLocale()
  return (
    <AppRuntimeContext.Provider value={state.runtime}>
      <AppShell route={route} locale={locale} onSignOut={signOut}>
        {route === 'products' ? (
          <ProductsScreen locale={locale} />
        ) : route === 'suppliers' ? (
          <SuppliersScreen locale={locale} />
        ) : route === 'customers' ? (
          <CustomersScreen locale={locale} />
        ) : route === 'customer-statuses' ? (
          <CustomerStatusesScreen locale={locale} />
        ) : (
          <DashboardScreen locale={locale} />
        )}
      </AppShell>
    </AppRuntimeContext.Provider>
  )
}
