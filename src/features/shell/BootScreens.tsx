/**
 * What the user sees before the application exists, and what they see when it
 * cannot.
 *
 * ## The rule these screens enforce
 *
 * **No business data is rendered until the database is open.** Not an empty
 * product list, not a dashboard showing three zeros, not a disabled shell with
 * a spinner in the content area. Every one of those tells the user something
 * false — that their catalogue is empty — at exactly the moment the truth is
 * that it has not been read yet. A startup failure that drops the user into an
 * empty-looking application is how someone concludes their data is gone and
 * starts re-entering it.
 *
 * ## No "reset the database" button
 *
 * The failure screen offers exactly one action: try again. Deleting the local
 * database would make most of these errors disappear, which is precisely why
 * it is not offered — the thing it deletes is the only copy of the pilot's
 * data, and a button that fixes an error by destroying the data has no place
 * one click away from an error message. `deleteDatabase()` already refuses the
 * production name without an explicit token for the same reason.
 */

import { useTranslation } from 'react-i18next'
import type { BootFailure } from '../../app/bootstrap'
import {
  BOOT_FAILURE_TRANSLATION_KEY,
  PERSISTENCE_ERROR_TRANSLATION_KEY,
} from '../../i18n/persistenceText'
import type { PersistenceErrorCode } from '../../persistence'

function BootPanel({ children }: { readonly children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="boot">
      <div className="boot__panel">
        <div className="boot__brand">
          <span className="brand__mark" aria-hidden="true">
            LC
          </span>
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
        <p className="boot__title" role="status" aria-live="polite">
          {t('boot.initializing')}
        </p>
      </div>
      <p className="boot__text">{t('boot.initializingHint')}</p>
    </BootPanel>
  )
}

function isPersistenceCode(code: string | undefined): code is PersistenceErrorCode {
  return code !== undefined && code in PERSISTENCE_ERROR_TRANSLATION_KEY
}

export function BootFailureScreen({
  phase,
  failure,
  onRetry,
}: {
  readonly phase: 'FAILED' | 'MIGRATION_BLOCKED'
  readonly failure: BootFailure
  readonly onRetry: () => void
}) {
  const { t } = useTranslation()

  // Two sentences, and they say different things. The first names the stage
  // that stopped — "the upgrade was not protected", "the database would not
  // open". The second, when there is one, is the specific reason the layer
  // below reported, which is what actually tells the user what to do.
  const stage = t(BOOT_FAILURE_TRANSLATION_KEY[failure.reason])
  const detail = isPersistenceCode(failure.code)
    ? t(PERSISTENCE_ERROR_TRANSLATION_KEY[failure.code])
    : undefined

  return (
    <BootPanel>
      <h1 className="boot__title" role="alert">
        {phase === 'MIGRATION_BLOCKED' ? t('boot.migrationBlockedTitle') : t('boot.failureTitle')}
      </h1>
      <p className="boot__text">{stage}</p>
      {detail !== undefined ? <p className="boot__text">{detail}</p> : null}
      {failure.code !== undefined ? (
        <p className="boot__code">
          {t('boot.errorCode')}: {failure.code}
        </p>
      ) : null}
      <div className="row">
        <button type="button" className="button button--primary" onClick={onRetry}>
          {t('common.retry')}
        </button>
      </div>
    </BootPanel>
  )
}
