/** The cloud boot gate (Phase 11), organisation selection (Phase 12) and route composition. */
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
import { OrganizationScreen } from './features/organization/OrganizationScreen'
import {
  BootLoadingScreen,
  CatalogMigrationScreen,
  CloudFailureScreen,
  InvitationCheckFailedScreen,
  InvitationConfirmationScreen,
  LegacyInspectionFailedScreen,
  OrganizationSelectionScreen,
  PasswordChangeScreen,
  SignInScreen,
} from './features/shell/BootScreens'
import { AppShell } from './features/shell/AppShell'
import { getLocale } from './i18n'

export default function App({ options }: { readonly options?: ApplicationBootOptions } = {}) {
  const { i18n } = useTranslation()
  const {
    state, retry, signIn, signOut, changePassword, migrate, retireLocal, selectOrganization, switchOrganization,
    acceptInvitation, declineInvitation,
  } = useApplicationBoot(options)
  const { route } = useRoute()

  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  if (state.phase === 'INITIALIZING') return <BootLoadingScreen />
  if (state.phase === 'SIGNED_OUT') return <SignInScreen onSignIn={signIn} />
  if (state.phase === 'UNAVAILABLE' || state.phase === 'NO_MEMBERSHIP') {
    return <CloudFailureScreen code={state.code} deactivated={state.deactivated} onRetry={retry} onSignOut={signOut} />
  }
  if (state.phase === 'INVITATION_CONFIRMATION') {
    return (
      <InvitationConfirmationScreen
        linkType={state.linkType}
        invitedEmailHint={state.invitedEmailHint}
        currentEmail={state.currentEmail}
        onAccept={acceptInvitation}
        onDecline={declineInvitation}
      />
    )
  }
  if (state.phase === 'INVITATION_CHECK_FAILED') {
    return <InvitationCheckFailedScreen code={state.code} onRetry={retry} onIgnore={declineInvitation} />
  }
  if (state.phase === 'ORGANIZATION_SELECTION') {
    return (
      <OrganizationSelectionScreen
        choices={state.selection.choices}
        previousSelectionUnavailable={state.selection.previousSelectionUnavailable}
        onSelect={selectOrganization}
        onSignOut={signOut}
      />
    )
  }
  if (state.phase === 'LEGACY_INSPECTION_FAILED') {
    return <LegacyInspectionFailedScreen failure={state.failure} onRetry={retry} />
  }
  if (state.phase === 'MIGRATION_REQUIRED' || state.phase === 'MIGRATION_FAILED') {
    return (
      <CatalogMigrationScreen
        counts={state.inspection.counts}
        role={state.ready.role}
        failure={state.phase === 'MIGRATION_FAILED' ? state.failure : undefined}
        onMigrate={migrate}
        onRetire={retireLocal}
      />
    )
  }
  if (state.phase !== 'READY') return null
  if (state.runtime.profile.mustChangePassword) {
    return <PasswordChangeScreen onChange={changePassword} accountEmail={state.runtime.accountEmail} onSignOut={signOut} />
  }

  void i18n.language
  const locale = getLocale()
  return (
    <AppRuntimeContext.Provider value={state.runtime}>
      {/*
        Keyed by organisation: a switch of company unmounts every business
        screen, and the state it held, even if a future change stopped the
        boot from passing through INITIALIZING.
      */}
      <AppShell
        key={state.runtime.organization.id}
        route={route}
        locale={locale}
        onSignOut={signOut}
        onSwitchOrganization={state.runtime.choices.length > 1 ? switchOrganization : undefined}
      >
        {route === 'products' ? (
          <ProductsScreen locale={locale} />
        ) : route === 'suppliers' ? (
          <SuppliersScreen locale={locale} />
        ) : route === 'customers' ? (
          <CustomersScreen locale={locale} />
        ) : route === 'customer-statuses' ? (
          <CustomerStatusesScreen locale={locale} />
        ) : route === 'organization' ? (
          <OrganizationScreen locale={locale} />
        ) : (
          <DashboardScreen locale={locale} />
        )}
      </AppShell>
    </AppRuntimeContext.Provider>
  )
}
