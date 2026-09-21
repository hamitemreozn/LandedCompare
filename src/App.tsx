/**
 * The boot gate.
 *
 * This component has exactly one job, and it is a safety job: **nothing below
 * it renders until the persistence layer has initialised successfully.** There
 * is no path from `INITIALIZING` or `FAILED` to a product screen, which is
 * what makes "the catalogue is empty" impossible to confuse with "the
 * catalogue has not been read".
 *
 * `AppRuntimeProvider` is mounted only inside the `READY` branch, so
 * `useAppRuntime()` cannot be reached without an open database — a screen that
 * tried would be a wiring bug and throws as one, rather than quietly rendering
 * against `null`.
 */

import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApplicationBoot } from './app/useApplicationBoot'
import { useRoute } from './app/useRoute'
import { AppRuntimeContext } from './app/runtime'
import { DashboardScreen } from './features/dashboard/DashboardScreen'
import { ProductsScreen } from './features/catalog/ProductsScreen'
import { CustomersScreen } from './features/parties/CustomersScreen'
import { SuppliersScreen } from './features/parties/SuppliersScreen'
import { AppShell } from './features/shell/AppShell'
import { BootFailureScreen, BootLoadingScreen } from './features/shell/BootScreens'
import type { BootstrapOptions } from './app/bootstrap'
import { getLocale } from './i18n'

/** `options` exists so a test can point the boot sequence at its own database. */
export default function App({ options }: { readonly options?: BootstrapOptions } = {}) {
  const { i18n } = useTranslation()
  const { state, retry } = useApplicationBoot(options)
  const { route } = useRoute()

  // `lang` is not decoration. CSS `text-transform: uppercase` is
  // language-sensitive, so a Turkish heading rendered under `lang="en"` comes
  // out as "ANA VERILER" instead of "ANA VERİLER" — the dotted capital İ is a
  // different letter, and dropping it is a spelling mistake, not a style. It
  // also tells a screen reader which language to pronounce.
  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  if (state.phase === 'INITIALIZING') {
    return <BootLoadingScreen />
  }

  if (state.phase !== 'READY') {
    return <BootFailureScreen phase={state.phase} failure={state.failure} onRetry={retry} />
  }

  // Read through `getLocale()` rather than from `i18n.language` directly: the
  // latter can carry a region subtag the collator and the case folds have no
  // business guessing at. `i18n.language` is still the render trigger.
  void i18n.language
  const locale = getLocale()

  return (
    <AppRuntimeContext.Provider value={state.runtime}>
      <AppShell route={route} locale={locale}>
        {route === 'products' ? (
          <ProductsScreen locale={locale} />
        ) : route === 'suppliers' ? (
          <SuppliersScreen locale={locale} />
        ) : route === 'customers' ? (
          <CustomersScreen locale={locale} />
        ) : (
          <DashboardScreen locale={locale} />
        )}
      </AppShell>
    </AppRuntimeContext.Provider>
  )
}
