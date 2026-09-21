/**
 * Turns anything a service can throw into a sentence a user can act on.
 *
 * This is the only place in the UI that inspects an error, and it inspects
 * exactly two things: the `code` of a typed error, and the `messageKey` of a
 * field validation failure. It never reads `error.message` — those are
 * developer-facing English by contract — and it never reaches into `cause`,
 * where the raw `DOMException` lives with its browser-dependent, separately
 * localised text.
 *
 * An unrecognised throwable resolves to a generic message rather than to
 * `String(error)`. Rendering an exception verbatim is how a user ends up
 * reading "NotFoundError: Failed to execute 'objectStore'", which tells them
 * nothing and looks like the application broke in a way nobody anticipated.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { isBackupError } from '../../backup'
import {
  BACKUP_ERROR_TRANSLATION_KEY,
  PERSISTENCE_ERROR_TRANSLATION_KEY,
} from '../../i18n/persistenceText'
import { isPersistenceError } from '../../persistence'
import { isFormValidationError } from './formError'

export function useDataErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation()

  return useCallback(
    (error: unknown): string => {
      if (isFormValidationError(error)) {
        return t(error.messageKey)
      }
      if (isPersistenceError(error)) {
        return t(PERSISTENCE_ERROR_TRANSLATION_KEY[error.code])
      }
      if (isBackupError(error)) {
        const key = BACKUP_ERROR_TRANSLATION_KEY[error.code]
        return key === undefined ? t('dataError.unexpected') : t(key)
      }
      return t('dataError.unexpected')
    },
    [t],
  )
}

/** The machine-readable code, shown alongside the message for support. */
export function errorCodeOf(error: unknown): string | undefined {
  if (isPersistenceError(error) || isBackupError(error)) {
    return error.code
  }
  return undefined
}

/** True when the failure is the concurrent-edit refusal, which has its own remedy. */
export function isStaleWrite(error: unknown): boolean {
  return isPersistenceError(error) && error.code === 'STALE_WRITE'
}

/** True when a unique-key constraint refused the write (a duplicate SKU). */
export function isDuplicateKey(error: unknown): boolean {
  return isPersistenceError(error) && error.code === 'DUPLICATE_KEY'
}
