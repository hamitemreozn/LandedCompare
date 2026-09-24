/**
 * A field-level validation failure, raised by the feature services.
 *
 * The forms validate before they submit, so in normal use nothing here is
 * reached. It exists because "the form checked it" is not a guarantee a
 * service may rely on — the service is the layer that actually builds the
 * record, and a value it cannot turn into one has to fail by name rather than
 * as whatever `Quantity.fromString` happens to throw three calls down.
 *
 * Same rule as everywhere else in this codebase: `field` and `messageKey` are
 * machine-readable, `message` is developer-facing English, and the user sees
 * whatever `src/i18n` resolves `messageKey` to.
 */
import { hasVisibleText } from '../../cloud/catalogRules'

export class FormValidationError extends Error {
  readonly field: string
  readonly messageKey: string

  constructor(field: string, messageKey: string) {
    super(`Field "${field}" is invalid (${messageKey})`)
    this.name = 'FormValidationError'
    this.field = field
    this.messageKey = messageKey
  }
}

export function isFormValidationError(value: unknown): value is FormValidationError {
  return value instanceof FormValidationError
}

/**
 * A required text field, trimmed. Empty is a failure, not an empty string —
 * and so is text made only of invisible characters (a zero-width space
 * survives `trim()`), which the server refuses for every required identifier.
 */
export function requiredText(value: string, field: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || !hasVisibleText(trimmed)) {
    throw new FormValidationError(field, 'form.requiredField')
  }
  return trimmed
}
