/**
 * The LandedCompare select — a real accessible listbox rendered in
 * LandedCompare's own visual language, not the browser's OS-native option
 * popup a plain `<select>` opens.
 *
 * ## Why Radix, and why only here
 *
 * A closed `<select>` can be restyled with CSS alone (`.select` in
 * `components.css`, still used by `UnitSelectField` — see its own file for
 * why that one stays native). Its *open* popup cannot: that surface is drawn
 * by the OS/browser, not the page, so it was the one part of the design
 * system a plain `<select>` could never actually join. `@radix-ui/react-select`
 * is a headless behaviour layer — keyboard navigation, focus management,
 * positioning/collision, `aria-*` wiring — with no visual opinion of its own;
 * every class name below is this project's own token-driven CSS
 * (`components.css`, "Select"), not a Radix theme. It is the only new
 * dependency this round, and the only place in the codebase that imports it.
 *
 * ## The empty-string sentinel
 *
 * Radix reserves `value=""` on `Select.Root` to mean "nothing selected, show
 * the placeholder" (`shouldShowPlaceholder` in its own source) — so an
 * `Item` cannot itself carry `value=""`, which `customer.customerStatusId`'s
 * "no status" option legitimately does (a real, persisted, selectable value,
 * not a placeholder). The substitution only ever activates when the option
 * list actually contains a `value: ''` entry — an ordinary placeholder-only
 * select (no such option, `value` simply starts `''`) is left untouched, so
 * Radix's own placeholder handling still applies to it unchanged. `onChange`
 * and the rendered `value` always use the caller's real value — no domain
 * value is converted, this is purely an implementation detail of talking to
 * Radix.
 */
import * as RadixSelect from '@radix-ui/react-select'
import { Icons } from './icons'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

const EMPTY_VALUE_SENTINEL = '__lc-select-empty__'

export function Select({
  id,
  ariaLabel,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  required,
  invalid,
  describedBy,
}: {
  /** Binds to a `<label htmlFor>` elsewhere — mutually exclusive in practice with `ariaLabel`. */
  readonly id?: string
  /** For contexts with no visible label (a table cell's per-row control). */
  readonly ariaLabel?: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly SelectOption[]
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly required?: boolean
  readonly invalid?: boolean
  readonly describedBy?: string
}) {
  // Only substitute when '' is genuinely one of the offered options — an
  // ordinary "nothing chosen yet" placeholder select never needs it, and
  // forcing the sentinel on it would defeat Radix's own placeholder display.
  const hasEmptyOption = options.some((option) => option.value === '')
  const toRadixValue = (raw: string): string => (hasEmptyOption && raw === '' ? EMPTY_VALUE_SENTINEL : raw)
  const fromRadixValue = (raw: string): string => (raw === EMPTY_VALUE_SENTINEL ? '' : raw)

  return (
    <RadixSelect.Root
      value={toRadixValue(value)}
      onValueChange={(next) => onChange(fromRadixValue(next))}
      disabled={disabled}
    >
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-required={required === true ? true : undefined}
        aria-invalid={invalid === true ? true : undefined}
        aria-describedby={describedBy}
        className="select-trigger"
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon className="select-trigger__icon">
          <Icons.chevron size={16} aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          className="select-content"
          position="popper"
          sideOffset={4}
          collisionPadding={8}
        >
          <RadixSelect.Viewport className="select-content__viewport">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={toRadixValue(option.value)}
                disabled={option.disabled}
                className="select-item"
              >
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator className="select-item__indicator">
                  <Icons.check size={14} aria-hidden="true" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
