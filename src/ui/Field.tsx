/**
 * Form fields, with the accessibility wiring done once instead of per screen.
 *
 * Every field here produces a real `<label for>` bound to a real control, and
 * a hint or an error is announced through `aria-describedby` rather than
 * sitting next to the input as decoration a screen reader never reaches. An
 * invalid field gets `aria-invalid` as well as a red border, because a border
 * colour is not a message.
 *
 * The ids are generated with React's `useId`, so two of the same field on one
 * screen cannot collide — which is exactly what happens the first time a hand
 * written `id="name"` meets a second form.
 *
 * ## Required, not "(optional)" forty times
 *
 * These forms are mostly optional fields, so marking every one of them said
 * almost nothing and said it constantly. The marker is on the **required**
 * fields instead, and it is carried three ways: `aria-required` on the control
 * (which is what a screen reader actually uses), a CSS `::after` asterisk for
 * sighted users, and one sentence at the top of the form stating that unmarked
 * fields are optional. The asterisk is generated content on purpose — it is
 * decoration for a fact `aria-required` already states, so it stays out of the
 * accessible name.
 */

import { useId, useState, type ChangeEvent, type ReactNode } from 'react'
import { Select, type SelectOption } from './Select'

interface FieldShellProps {
  readonly label: string
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
  readonly wide?: boolean
  readonly children: (ids: { id: string; describedBy: string | undefined }) => ReactNode
  /** Rendered between the control and its error/hint. Used by the unit field. */
  readonly extra?: ReactNode
}

function FieldShell({ label, hint, error, required, wide, children, extra }: FieldShellProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [error !== undefined ? errorId : undefined, hint !== undefined ? hintId : undefined]
      .filter((value): value is string => value !== undefined)
      .join(' ') || undefined

  return (
    <div className={wide === true ? 'field form-grid__wide' : 'field'}>
      <label
        className={required === true ? 'field__label field__label--required' : 'field__label'}
        htmlFor={id}
      >
        {label}
      </label>
      {children({ id, describedBy })}
      {extra}
      {error !== undefined ? (
        <p className="field__error" id={errorId}>
          {error}
        </p>
      ) : null}
      {hint !== undefined ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
  readonly wide?: boolean
  readonly placeholder?: string
  readonly autoFocus?: boolean
  readonly inputMode?: 'text' | 'decimal'
  readonly type?: 'text' | 'email' | 'password'
  /** Rendered between the control and its error/hint. */
  readonly extra?: ReactNode
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide,
  placeholder,
  autoFocus,
  inputMode,
  type = 'text',
  extra,
}: TextFieldProps) {
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={required}
      wide={wide}
      extra={extra}
    >
      {({ id, describedBy }) => (
        <input
          className="input"
          id={id}
          type={type}
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the form replaces
          // the list entirely, so focus has to be moved into it; leaving it on
          // a button that no longer exists strands a keyboard user.
          autoFocus={autoFocus}
          aria-required={required === true ? true : undefined}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  )
}

interface TextAreaFieldProps {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
  readonly wide?: boolean
  readonly rows?: number
}

export function TextAreaField({
  label,
  value,
  onChange,
  hint,
  error,
  required,
  wide,
  rows,
}: TextAreaFieldProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} wide={wide}>
      {({ id, describedBy }) => (
        <textarea
          className="textarea"
          id={id}
          value={value}
          rows={rows}
          aria-required={required === true ? true : undefined}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        />
      )}
    </FieldShell>
  )
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  hint,
  error,
  required,
}: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly SelectOption[]
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
}) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required}>
      {({ id, describedBy }) => (
        <Select
          id={id}
          value={value}
          onChange={onChange}
          options={options}
          required={required}
          invalid={error !== undefined}
          describedBy={describedBy}
        />
      )}
    </FieldShell>
  )
}

/**
 * A unit picker: a dropdown of the units a warehouse actually counts in, plus
 * a way to type one that is not on the list.
 *
 * ## Why a dropdown at all
 *
 * "Stok Birimi" as a bare text box asks a question the label does not answer,
 * and a non-technical user can reasonably read "birim" as a place rather than
 * a counting unit. A list of concrete values — Adet, Kutu, Koli, Metre —
 * answers it by example before the hint is read.
 *
 * ## Why the stored value is still free text
 *
 * `Product.stockUnit` is a `string` and stays one. The dropdown offers
 * suggestions; it does not introduce an enum, a code table, or a second
 * representation of the same fact. A company that counts in "Rulo" types it,
 * and what is stored is exactly "Rulo".
 *
 * Each option carries a **stored value** and a **displayed label**, and they
 * are not the same thing: the predefined units are stored as locale
 * independent codes (`PIECE`, `BOX`, …) and labelled in the current language,
 * so switching languages changes what is shown and never what is stored. See
 * `features/shared/units.ts`. A value this list does not contain — a unit the
 * company typed itself — is shown as its own option, selected, exactly as
 * stored, and is never translated or rewritten.
 *
 * ## Why this one stays a native `<select>` (Round 3, §10)
 *
 * Every other select in the app migrated to `Select.tsx`
 * (`@radix-ui/react-select`); this is the one documented exception. It isn't
 * really a plain select — it's a picker that turns into a free-text field
 * (`typingCustom`, below) and, mid-flight, can show an option that isn't in
 * `options` at all (`showsStoredValueAsOption`, for a value the company typed
 * that the current language's list doesn't contain). Reproducing that in
 * `Select.tsx` would mean inventing new behaviour there for one caller, not
 * migrating existing behaviour — exactly what this round asked not to do.
 */
export interface UnitOption {
  /** What gets persisted. A canonical code, for the predefined units. */
  readonly value: string
  /** What the user reads. Translated for the predefined units. */
  readonly label: string
}

interface UnitSelectFieldProps {
  readonly label: string
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly UnitOption[]
  readonly chooseLabel: string
  readonly otherLabel: string
  readonly customLabel: string
  readonly customPlaceholder?: string
}

/**
 * The `<option>` value that means "let me type my own", as opposed to a unit.
 *
 * It only ever exists inside this component: it is written onto one option and
 * compared against the select's own value, and it is never stored, never
 * passed to `onChange`, and never reaches a record. The underscores make it
 * something no canonical code (which are plain uppercase words) and no unit a
 * person would type can collide with.
 */
const OTHER_SENTINEL = '__OTHER__'

export function UnitSelectField({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  options,
  chooseLabel,
  otherLabel,
  customLabel,
  customPlaceholder,
}: UnitSelectFieldProps) {
  const [typingCustom, setTypingCustom] = useState(false)
  const customId = useId()

  const isKnown = options.some((option) => option.value === value)
  // A stored value the current language's list does not contain is not an
  // error and not "Other": it is this product's unit. It gets its own option
  // so it displays and round-trips exactly as stored.
  const showsStoredValueAsOption = value !== '' && !isKnown && !typingCustom

  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      required={required}
      extra={
        typingCustom ? (
          <div className="field__nested">
            <label className="field__label" htmlFor={customId}>
              {customLabel}
            </label>
            <input
              className="input"
              id={customId}
              type="text"
              value={value}
              placeholder={customPlaceholder}
              aria-required={required === true ? true : undefined}
              onChange={(event) => onChange(event.target.value)}
            />
          </div>
        ) : undefined
      }
    >
      {({ id, describedBy }) => (
        <select
          className="select"
          id={id}
          value={typingCustom ? OTHER_SENTINEL : value}
          aria-required={required === true ? true : undefined}
          aria-invalid={error !== undefined ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (event.target.value === OTHER_SENTINEL) {
              // The current value stays, so the text box opens prefilled and an
              // existing custom unit can be corrected rather than retyped.
              setTypingCustom(true)
              return
            }
            setTypingCustom(false)
            onChange(event.target.value)
          }}
        >
          {value === '' ? <option value="">{chooseLabel}</option> : null}
          {showsStoredValueAsOption ? <option value={value}>{value}</option> : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          <option value={OTHER_SENTINEL}>{otherLabel}</option>
        </select>
      )}
    </FieldShell>
  )
}

interface CheckboxFieldProps {
  readonly label: string
  readonly hint?: string
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
}

export function CheckboxField({ label, hint, checked, onChange }: CheckboxFieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  return (
    <div className="checkbox form-grid__wide">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        aria-describedby={hint !== undefined ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox__text">
        <label className="checkbox__label" htmlFor={id}>
          {label}
        </label>
        {hint !== undefined ? (
          <span className="field__hint" id={hintId}>
            {hint}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/**
 * A titled group of fields.
 *
 * A `<fieldset>` with a `<legend>`, because that is the element that tells
 * assistive technology "these controls belong together" — and styled flat, not
 * as a card, so the form does not become a stack of boxes inside a box.
 */
export function FormSection({
  title,
  children,
}: {
  readonly title: string
  readonly children: ReactNode
}) {
  return (
    <fieldset className="form-section">
      <legend className="form-section__title">{title}</legend>
      <div className="form-grid">{children}</div>
    </fieldset>
  )
}
