/**
 * A minimal, locally-owned Tooltip — the first of the "own the source, style
 * with tokens" shadcn/ui-style primitives (docs/DESIGN_SYSTEM.md). There was
 * no existing tooltip in the codebase to adapt, unlike Button/Input/Label,
 * which already have robust equivalents and are deliberately left alone this
 * phase.
 *
 * Follows the WAI-ARIA "hover or focus" tooltip pattern (WCAG 1.4.13):
 * - Shows on hover AND on keyboard focus (never hover-only).
 * - **Dismissible**: Escape hides it without moving focus, and it can appear
 *   again on the next fresh hover/focus interaction.
 * - **Hoverable**: the pointer can move from the trigger onto the tooltip
 *   content itself without it disappearing — a short hide delay bridges the
 *   visual gap between them.
 * - **Persistent**: stays open for as long as the trigger is hovered/focused,
 *   or the pointer is over the tooltip content.
 *
 * It connects to the trigger via `aria-describedby`, merging with (not
 * replacing) any `aria-describedby` the trigger already carries. It does
 * not, by itself, make an icon-only button accessible — that still needs its
 * own `aria-label`; the tooltip supplements it with the visible hint.
 */
import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement } from 'react'

const HIDE_DELAY_MS = 150

export function Tooltip({
  content,
  children,
}: {
  readonly content: string
  readonly children: ReactElement<{
    'aria-describedby'?: string
    onFocus?: (e: React.FocusEvent) => void
    onBlur?: (e: React.FocusEvent) => void
    onMouseEnter?: (e: React.MouseEvent) => void
    onMouseLeave?: (e: React.MouseEvent) => void
  }>
}) {
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const id = useId()

  const visible = !dismissed && (hovering || focused)

  // Escape dismisses regardless of whether the trigger itself has keyboard
  // focus (a hover-only interaction never puts focus there) — and never
  // moves focus itself.
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible])

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  if (!isValidElement(children)) return children

  const enter = () => {
    clearTimeout(hideTimer.current)
    setDismissed(false)
    setHovering(true)
  }
  const leave = () => {
    hideTimer.current = setTimeout(() => setHovering(false), HIDE_DELAY_MS)
  }

  const existingDescribedBy = children.props['aria-describedby']
  const describedBy = existingDescribedBy !== undefined ? `${existingDescribedBy} ${id}` : id

  const trigger = cloneElement(children, {
    'aria-describedby': describedBy,
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e)
      setDismissed(false)
      setFocused(true)
    },
    onBlur: (e: React.FocusEvent) => {
      children.props.onBlur?.(e)
      setFocused(false)
    },
    onMouseEnter: (e: React.MouseEvent) => {
      children.props.onMouseEnter?.(e)
      enter()
    },
    onMouseLeave: (e: React.MouseEvent) => {
      children.props.onMouseLeave?.(e)
      leave()
    },
  })

  return (
    <span className="tooltip-anchor">
      {trigger}
      <span
        id={id}
        role="tooltip"
        className="tooltip"
        data-visible={visible ? 'true' : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        {content}
      </span>
    </span>
  )
}
