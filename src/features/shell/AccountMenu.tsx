/**
 * The account control: identity, organisation, role, language and sign-out,
 * collapsed into one top-right trigger instead of a permanent sidebar block.
 *
 * Visual Polish Round 1 moved this out of the sidebar (§3/§4 of that pass):
 * the sidebar footer's full-width identity/locale/sign-out rows read as
 * navigation destinations, and the always-visible TR/EN switch was too loud
 * for a global preference. Everything it did still exists here, just behind
 * one disclosure button.
 *
 * Round 2, §7 removed the circular initial-letter avatar Round 1 added —
 * reads as consumer-app chrome, not this product's register. The trigger is
 * text-only on desktop (name, then organisation, smaller and subdued) with a
 * trailing chevron; below the width where that text doesn't fit, it falls
 * back to a plain `Icons.user` glyph rather than an initial.
 *
 * ## Why a hand-built disclosure, not `role="menu"`
 *
 * The panel mixes a real action list (switch company, sign out) with a
 * language *group* (`role="group"` of pressed toggles) — forcing all of that
 * into the ARIA "menu" pattern would mean roving `tabindex` and arrow-key
 * navigation for content that isn't a list of equivalent commands. A plain
 * disclosure — a button toggling a panel, closed by Escape/outside-click,
 * with focus managed on open/close — is the smaller, more honest fit, and is
 * the same shape `ConfirmDialog.tsx` already uses for its own Escape/focus
 * handling.
 *
 * ## Why the panel never unmounts
 *
 * It stays in the DOM with the native `hidden` attribute rather than being
 * conditionally rendered. `hidden` already removes it from the accessibility
 * tree and from tab order in every real browser — the same guarantee
 * conditional rendering would give — but keeps `shell-organization`/
 * `shell-user` (Audit A, A-M2: identity must be readable from every screen)
 * queryable by every existing test that asserts on them without needing the
 * menu open first.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setLocale, SUPPORTED_LOCALES, type SupportedLocale } from '../../i18n'
import { Icons } from '../../ui/icons'

export function AccountMenu({
  organizationName,
  userDisplayName,
  role,
  locale,
  onSignOut,
  onSwitchOrganization,
  canSwitchOrganization,
}: {
  readonly organizationName: string
  readonly userDisplayName: string
  readonly role: string
  readonly locale: SupportedLocale
  readonly onSignOut: () => Promise<void>
  readonly onSwitchOrganization?: () => void
  readonly canSwitchOrganization: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    triggerRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector('button')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  return (
    <div className="account-menu">
      <button
        ref={triggerRef}
        type="button"
        className="account-menu__trigger"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="account-menu-panel"
        aria-label={t('shell.accountMenu')}
        onClick={() => setOpen((previous) => !previous)}
      >
        <Icons.user size={18} aria-hidden="true" className="account-menu__icon" />
        <span className="account-menu__identity">
          <span className="account-menu__name">{userDisplayName}</span>
          <span className="account-menu__org" data-testid="shell-organization">{organizationName}</span>
        </span>
        {/*
          Visually hidden: the trigger shows name + company (§4), not the
          role, but the role is part of "who is signed in" (Audit A, A-M2)
          and every existing test that reads it does so through this testid.
        */}
        <span className="visually-hidden" data-testid="shell-user">{userDisplayName} · {role}</span>
        <Icons.chevron size={16} aria-hidden="true" className="account-menu__caret" />
      </button>

      {open ? <div className="account-menu__backdrop" onMouseDown={close} /> : null}
      <div id="account-menu-panel" className="account-menu__panel" ref={panelRef} hidden={!open}>
        <div className="account-menu__summary">
          <p className="account-menu__summary-name">{userDisplayName}</p>
          <p className="account-menu__summary-org">{organizationName}</p>
          <p className="account-menu__summary-role">{role}</p>
        </div>

        {canSwitchOrganization && onSwitchOrganization !== undefined ? (
          <>
            <div className="account-menu__separator" role="none" />
            <button
              type="button"
              className="account-menu__item"
              onClick={() => {
                close()
                onSwitchOrganization()
              }}
            >
              <Icons.switchOrganization size={16} aria-hidden="true" />
              {t('shell.switchOrganization')}
            </button>
          </>
        ) : null}

        <div className="account-menu__separator" role="none" />
        <div className="account-menu__section">
          <span className="account-menu__section-label" id="account-menu-locale-label">{t('common.language')}</span>
          <div className="locale-switch" role="group" aria-labelledby="account-menu-locale-label">
            {SUPPORTED_LOCALES.map((option) => (
              <button
                key={option}
                type="button"
                className="locale-switch__option"
                aria-pressed={locale === option}
                onClick={() => void setLocale(option)}
              >
                {t(`language.${option}`)}
              </button>
            ))}
          </div>
        </div>

        <div className="account-menu__separator" role="none" />
        <button
          type="button"
          className="account-menu__item account-menu__item--signout"
          onClick={() => {
            close()
            void onSignOut()
          }}
        >
          <Icons.logout size={16} aria-hidden="true" />
          {t('cloudAuth.signOut')}
        </button>
      </div>
    </div>
  )
}
