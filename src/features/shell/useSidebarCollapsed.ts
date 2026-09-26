/**
 * The desktop sidebar's collapsed/expanded state.
 *
 * This is a local UI preference, not business data: it never touches the
 * cloud gateway and lives under its own namespaced `localStorage` key,
 * distinct from the business keys under `landedcompare.*` (see
 * `src/app/organizationPreference.ts`, `src/i18n/locale.ts`). A browser that
 * refuses storage (private mode, a full quota) must not break the shell, so
 * every access is wrapped and a failure is simply treated as "not collapsed".
 */
import { useCallback, useState } from 'react'

export const SIDEBAR_COLLAPSED_KEY = 'landedcompare.sidebarCollapsed'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

function writeStored(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // A local preference only; a failed write just means it resets next session.
  }
}

export function useSidebarCollapsed(): { readonly collapsed: boolean; readonly toggle: () => void } {
  const [collapsed, setCollapsed] = useState(readStored)

  const toggle = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous
      writeStored(next)
      return next
    })
  }, [])

  return { collapsed, toggle }
}
