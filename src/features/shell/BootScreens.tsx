import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { isCloudError, type CloudErrorCode, type LegacyCatalogCounts } from '../../cloud'
import { TextField } from '../../ui/Field'
import { Banner } from '../../ui/Feedback'

const CLOUD_ERROR_KEYS: Record<CloudErrorCode, string> = {
  OFFLINE: 'cloudError.offline',
  SERVER_UNAVAILABLE: 'cloudError.serverUnavailable',
  SESSION_EXPIRED: 'cloudError.sessionExpired',
  FORBIDDEN: 'cloudError.forbidden',
  NO_MEMBERSHIP: 'cloudError.noMembership',
  ORGANIZATION_LOCKED: 'cloudError.organizationLocked',
  NOT_CONFIGURED: 'cloudError.notConfigured',
  STALE_WRITE: 'dataError.staleWrite',
  DUPLICATE_KEY: 'dataError.duplicateKey',
  RECORD_NOT_FOUND: 'dataError.recordNotFound',
  RECORD_INVALID: 'dataError.recordInvalid',
  UNEXPECTED: 'cloudError.unexpected',
}

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
  onRetry,
}: {
  readonly code: CloudErrorCode
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <BootPanel>
      <h1 className="boot__title" role="alert">{t('boot.failureTitle')}</h1>
      <p className="boot__text">{t(CLOUD_ERROR_KEYS[code])}</p>
      <p className="boot__code">{t('boot.errorCode')}: {code}</p>
      <button type="button" className="button button--primary" onClick={onRetry}>{t('common.retry')}</button>
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
}: {
  readonly onChange: (password: string) => Promise<void>
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
      <p className="boot__text">{t('cloudAuth.mustChangePasswordHint')}</p>
      {failure !== undefined ? <Banner tone="danger" label={t('common.error')}>{t('cloudError.unexpected')}</Banner> : null}
      <form onSubmit={(event) => void submit(event)}>
        <TextField label={t('cloudAuth.newPasswordLabel')} value={password} onChange={setPassword} required autoFocus type="password" />
        <div className="form-actions">
          <span className="form-actions__spacer" />
          <button type="submit" className="button button--primary" disabled={busy || password.length < 8}>
            {busy ? t('common.saving') : t('cloudAuth.changePassword')}
          </button>
        </div>
      </form>
    </BootPanel>
  )
}

export function CatalogMigrationScreen({
  counts,
  canMigrate,
  failure,
  onMigrate,
}: {
  readonly counts: LegacyCatalogCounts
  readonly canMigrate: boolean
  readonly failure?: unknown
  readonly onMigrate: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const start = async () => {
    setBusy(true)
    try {
      await onMigrate()
    } finally {
      setBusy(false)
    }
  }
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
      {counts.otherBusinessRecords > 0 ? <Banner tone="danger" label={t('common.error')}>{t('catalogMigration.unsupportedRecords')}</Banner> : null}
      {failure !== undefined ? <Banner tone="danger" label={t('catalogMigration.failed')}>{t('catalogMigration.failedHint')}</Banner> : null}
      {!canMigrate ? <Banner tone="warning" label={t('common.warning')}>{t('catalogMigration.ownerRequired')}</Banner> : null}
      <p className="field__hint">{t('catalogMigration.backupNotice')}</p>
      <button
        type="button"
        className="button button--primary"
        disabled={busy || !canMigrate || counts.otherBusinessRecords > 0}
        onClick={() => void start()}
      >
        {busy ? t('catalogMigration.migrating') : t('catalogMigration.start')}
      </button>
    </BootPanel>
  )
}
