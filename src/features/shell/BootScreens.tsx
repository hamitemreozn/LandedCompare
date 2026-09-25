import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isCloudError,
  isLegacyMigrationError,
  type CloudErrorCode,
  type LegacyCatalogCounts,
  type LegacyMigrationError,
  type MembershipRole,
  type OrganizationChoice,
} from '../../cloud'
import { CLOUD_ERROR_TRANSLATION_KEY } from '../../i18n/persistenceText'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { TextField } from '../../ui/Field'
import { Banner } from '../../ui/Feedback'

const CLOUD_ERROR_KEYS: Record<CloudErrorCode, string> = CLOUD_ERROR_TRANSLATION_KEY

function BootPanel({ children }: { readonly children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="boot">
      <div className="boot__panel">
        <div className="boot__brand">
          <span className="brand__mark" aria-hidden="true">LC</span>
          <span className="brand__name">{t('common.appName')}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

export function BootLoadingScreen() {
  const { t } = useTranslation()
  return (
    <BootPanel>
      <div className="row">
        <span className="boot__spinner" aria-hidden="true" />
        <p className="boot__title" role="status" aria-live="polite">{t('boot.initializing')}</p>
      </div>
      <p className="boot__text">{t('boot.initializingHint')}</p>
    </BootPanel>
  )
}

export function CloudFailureScreen({
  code,
  deactivated,
  onRetry,
  onSignOut,
}: {
  readonly code: CloudErrorCode
  /** A membership exists and was switched off — a different sentence from "never attached". */
  readonly deactivated?: boolean
  readonly onRetry: () => void
  /**
   * NO_MEMBERSHIP has no membership to retry into — the account may simply be
   * the wrong one. Offered there so the person can sign out and sign in with
   * another account, rather than being stuck staring at a dead end.
   */
  readonly onSignOut?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const key = code === 'NO_MEMBERSHIP' && deactivated ? 'cloudError.membershipDeactivated' : CLOUD_ERROR_KEYS[code]
  return (
    <BootPanel>
      <h1 className="boot__title" role="alert">{t('boot.failureTitle')}</h1>
      <p className="boot__text">{t(key)}</p>
      <p className="boot__code">{t('boot.errorCode')}: {code}</p>
      <div className="form-actions">
        {code === 'NO_MEMBERSHIP' && onSignOut !== undefined ? (
          <button type="button" className="button" onClick={() => void onSignOut()}>{t('cloudAuth.signOut')}</button>
        ) : null}
        <span className="form-actions__spacer" />
        <button type="button" className="button button--primary" onClick={onRetry}>{t('common.retry')}</button>
      </div>
    </BootPanel>
  )
}

/**
 * The organisation selector (Audit A, A-L7): shown only when the user has
 * several ACTIVE memberships and no still-valid choice. Nothing business
 * related is mounted behind it; choosing one boots again, and the boot enters
 * the choice only if it is still an ACTIVE membership on the server.
 */
export function OrganizationSelectionScreen({
  choices,
  previousSelectionUnavailable,
  onSelect,
  onSignOut,
}: {
  readonly choices: readonly OrganizationChoice[]
  readonly previousSelectionUnavailable: boolean
  readonly onSelect: (organizationId: string) => void
  readonly onSignOut: () => Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <BootPanel>
      <h1 className="boot__title">{t('organizationSelection.title')}</h1>
      <p className="boot__text">{t('organizationSelection.body')}</p>
      {previousSelectionUnavailable ? (
        <Banner tone="warning" label={t('common.warning')}>{t('organizationSelection.previousUnavailable')}</Banner>
      ) : null}
      <ul className="choice-list" aria-label={t('organizationSelection.listLabel')}>
        {choices.map((choice) => (
          <li key={choice.organization.id}>
            <button
              type="button"
              className="choice-list__option"
              data-organization-id={choice.organization.id}
              onClick={() => onSelect(choice.organization.id)}
            >
              <span className="choice-list__name">{choice.organization.name}</span>
              <span className="choice-list__meta">
                {t('organizationSelection.roleLabel', { role: t(`organization.roles.${choice.role}`) })}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="form-actions">
        <span className="form-actions__spacer" />
        <button type="button" className="button" onClick={() => void onSignOut()}>{t('cloudAuth.signOut')}</button>
      </div>
    </BootPanel>
  )
}

/**
 * An invitation or recovery link arrived while an account is already signed
 * in on this device — always asked, whoever the link claims to be for.
 * Nothing changes until the person chooses; "stay" drops the link and keeps
 * the current session untouched. The account the link names is decoded
 * WITHOUT verification and is shown as what the link SAYS, nothing more.
 */
export function InvitationConfirmationScreen({
  linkType,
  invitedEmailHint,
  currentEmail,
  onAccept,
  onDecline,
}: {
  readonly linkType: 'invite' | 'recovery'
  /** Unverified display hint from the link. Never a security input. */
  readonly invitedEmailHint: string | null
  readonly currentEmail: string | null
  readonly onAccept: () => void
  readonly onDecline: () => void
}) {
  const { t } = useTranslation()
  const invited = invitedEmailHint ?? t('invitationConfirmation.unknownAccount')
  const current = currentEmail ?? t('invitationConfirmation.unknownAccount')
  return (
    <BootPanel>
      <h1 className="boot__title">{t('invitationConfirmation.title')}</h1>
      <p className="boot__text" data-testid="invitation-confirmation">
        {t(linkType === 'invite' ? 'invitationConfirmation.bodyInvite' : 'invitationConfirmation.bodyRecovery', { invited, current })}
      </p>
      <p className="field__hint">{t('invitationConfirmation.warning', { current })}</p>
      <div className="form-actions">
        <button type="button" className="button" onClick={onAccept}>{t('invitationConfirmation.accept')}</button>
        <span className="form-actions__spacer" />
        <button type="button" className="button button--primary" onClick={onDecline}>{t('invitationConfirmation.decline', { current })}</button>
      </div>
    </BootPanel>
  )
}

/**
 * An invitation or recovery link arrived and Auth could not say whether an
 * account is already signed in here. The link was NOT used and nothing was
 * replaced: the person can ask again, or drop the link.
 */
export function InvitationCheckFailedScreen({
  code,
  onRetry,
  onIgnore,
}: {
  readonly code: CloudErrorCode
  readonly onRetry: () => void
  readonly onIgnore: () => void
}) {
  const { t } = useTranslation()
  return (
    <BootPanel>
      <h1 className="boot__title" role="alert">{t('invitationConfirmation.checkFailedTitle')}</h1>
      <p className="boot__text" data-testid="invitation-check-failed">{t('invitationConfirmation.checkFailedBody')}</p>
      <p className="boot__code">{t('boot.errorCode')}: {code}</p>
      <div className="form-actions">
        <button type="button" className="button" onClick={onIgnore}>{t('invitationConfirmation.ignore')}</button>
        <span className="form-actions__spacer" />
        <button type="button" className="button button--primary" onClick={onRetry}>{t('common.retry')}</button>
      </div>
    </BootPanel>
  )
}

export function SignInScreen({
  onSignIn,
}: {
  readonly onSignIn: (email: string, password: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setFailure(undefined)
    try {
      await onSignIn(email, password)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }
  return (
    <BootPanel>
      <h1 className="boot__title">{t('cloudAuth.signInTitle')}</h1>
      {failure !== undefined ? (
        <Banner tone="danger" label={t('common.error')}>
          {t(isCloudError(failure) ? CLOUD_ERROR_KEYS[failure.code] : 'cloudError.unexpected')}
        </Banner>
      ) : null}
      <form onSubmit={(event) => void submit(event)}>
        <div className="form-grid">
          <TextField label={t('cloudAuth.emailLabel')} value={email} onChange={setEmail} required autoFocus />
          <TextField label={t('cloudAuth.passwordLabel')} value={password} onChange={setPassword} required type="password" />
        </div>
        <p className="field__hint">{t('cloudAuth.noSelfServiceReset')}</p>
        <div className="form-actions">
          <span className="form-actions__spacer" />
          <button type="submit" className="button button--primary" disabled={busy || !email || !password}>
            {busy ? t('common.loading') : t('cloudAuth.signIn')}
          </button>
        </div>
      </form>
    </BootPanel>
  )
}

export function PasswordChangeScreen({
  onChange,
  accountEmail,
  onSignOut,
}: {
  readonly onChange: (password: string) => Promise<void>
  /** Whose password this is — shown so a link to someone else's account is noticed. */
  readonly accountEmail?: string | null
  readonly onSignOut?: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setFailure(undefined)
    try {
      await onChange(password)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }
  return (
    <BootPanel>
      <h1 className="boot__title">{t('cloudAuth.mustChangePasswordTitle')}</h1>
      {accountEmail ? (
        <p className="boot__text" data-testid="password-account">{t('cloudAuth.passwordForAccount', { email: accountEmail })}</p>
      ) : null}
      <p className="boot__text">{t('cloudAuth.mustChangePasswordHint')}</p>
      {failure !== undefined ? <Banner tone="danger" label={t('common.error')}>{t('cloudError.unexpected')}</Banner> : null}
      <form onSubmit={(event) => void submit(event)}>
        <TextField label={t('cloudAuth.newPasswordLabel')} value={password} onChange={setPassword} required autoFocus type="password" />
        <div className="form-actions">
          {onSignOut ? (
            <button type="button" className="button" disabled={busy} onClick={() => void onSignOut()}>
              {t('cloudAuth.notMyAccount')}
            </button>
          ) : null}
          <span className="form-actions__spacer" />
          <button type="submit" className="button button--primary" disabled={busy || password.length < 8}>
            {busy ? t('common.saving') : t('cloudAuth.changePassword')}
          </button>
        </div>
      </form>
    </BootPanel>
  )
}

export function LegacyInspectionFailedScreen({
  failure,
  onRetry,
}: {
  readonly failure: unknown
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  const code = isCloudError(failure) ? failure.code : undefined
  return (
    <BootPanel>
      <h1 className="boot__title" role="alert">{t('catalogMigration.inspectionFailedTitle')}</h1>
      <p className="boot__text">{t('catalogMigration.inspectionFailedBody')}</p>
      {code ? <p className="boot__code">{t('boot.errorCode')}: {code}</p> : null}
      <button type="button" className="button button--primary" onClick={onRetry}>{t('common.retry')}</button>
    </BootPanel>
  )
}

const RETIRABLE_REASONS = new Set(['LEGACY_CONFLICT', 'CLOUD_NOT_EMPTY', 'LEGACY_RECORD_INVALID'])

function storeLabel(store: string | undefined, t: (key: string) => string): string {
  if (store === 'products') return t('catalogMigration.storeProducts')
  if (store === 'suppliers') return t('catalogMigration.storeSuppliers')
  if (store === 'customers') return t('catalogMigration.storeCustomers')
  return '—'
}

/** The named, actionable sentence for a stopped cutover — never a raw message. */
function MigrationFailure({ failure }: { readonly failure: unknown }) {
  const { t } = useTranslation()
  if (!isLegacyMigrationError(failure)) {
    const code = isCloudError(failure) ? failure.code : undefined
    return (
      <Banner tone="danger" label={t('catalogMigration.failed')}>
        {code ? t(CLOUD_ERROR_KEYS[code]) : t('catalogMigration.failedHint')}
        {code ? <span className="boot__code"> {t('boot.errorCode')}: {code}</span> : null}
      </Banner>
    )
  }
  const error: LegacyMigrationError = failure
  const values = {
    store: storeLabel(error.details.store, t),
    id: error.details.id ?? '—',
    field: error.details.field ?? '—',
    count: error.details.count ?? 0,
  }
  const key: Record<LegacyMigrationError['reason'], string> = {
    LEGACY_UNSUPPORTED_RECORDS: 'catalogMigration.reasonUnsupportedRecords',
    LEGACY_RECORD_INVALID: 'catalogMigration.reasonInvalidRecord',
    LEGACY_CONFLICT: 'catalogMigration.reasonConflict',
    CLOUD_NOT_EMPTY: 'catalogMigration.reasonCloudNotEmpty',
    IMPORT_REQUIRES_OWNER: 'catalogMigration.ownerRequired',
    VERIFICATION_FAILED: 'catalogMigration.reasonVerificationFailed',
  }
  return (
    <Banner tone="danger" label={t('catalogMigration.failed')}>
      <span data-migration-reason={error.reason}>{t(key[error.reason], values)}</span>
    </Banner>
  )
}

export function CatalogMigrationScreen({
  counts,
  role,
  failure,
  onMigrate,
  onRetire,
}: {
  readonly counts: LegacyCatalogCounts
  readonly role: MembershipRole
  readonly failure?: unknown
  readonly onMigrate: () => Promise<void>
  readonly onRetire: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  const unsupported = counts.otherBusinessRecords > 0
  // The explicit way past a named conflict: OWNER only, behind a confirmation,
  // and only for the reasons where keeping the cloud and backing up the local
  // copy is a meaningful choice.
  const canRetire =
    role === 'OWNER' && isLegacyMigrationError(failure) && RETIRABLE_REASONS.has(failure.reason)
  return (
    <BootPanel>
      <h1 className="boot__title">{t('catalogMigration.title')}</h1>
      <p className="boot__text">{t('catalogMigration.body')}</p>
      <p className="boot__text">
        {t('catalogMigration.counts', {
          products: counts.products,
          suppliers: counts.suppliers,
          customers: counts.customers,
        })}
      </p>
      {unsupported ? <Banner tone="danger" label={t('common.error')}>{t('catalogMigration.unsupportedRecords')}</Banner> : null}
      {failure !== undefined ? <MigrationFailure failure={failure} /> : null}
      <p className="field__hint">{t('catalogMigration.backupNotice')}</p>
      <div className="form-actions">
        {canRetire ? (
          <button type="button" className="button" disabled={busy} onClick={() => setConfirming(true)}>
            {t('catalogMigration.retireAction')}
          </button>
        ) : null}
        <span className="form-actions__spacer" />
        <button
          type="button"
          className="button button--primary"
          disabled={busy || unsupported}
          onClick={() => void run(onMigrate)}
        >
          {busy ? t('catalogMigration.migrating') : t('catalogMigration.start')}
        </button>
      </div>
      {confirming ? (
        <ConfirmDialog
          title={t('catalogMigration.retireTitle')}
          body={t('catalogMigration.retireBody')}
          note={t('catalogMigration.retireNote')}
          confirmLabel={t('catalogMigration.retireConfirm')}
          cancelLabel={t('common.cancel')}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            void run(onRetire)
          }}
        />
      ) : null}
    </BootPanel>
  )
}
