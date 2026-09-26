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
 *
 * ## Pointer focus does not count as "focused"
 *
 * A `<button>`/`<a>` receives DOM focus on click, not only on Tab — so
 * without this, clicking a trigger while hovering it left the tooltip
 * "stuck": the pointer would leave and clear `hovering`, but the click had
 * already set `focused`, and nothing after a click clears that. `onFocus`
 * only honours focus that wasn't immediately preceded by this trigger's own
 * `onMouseDown` in the same gesture — plain Tab focus still shows it, click
 * focus does not, and `onBlur` still always clears it. This is a same-gesture
 * timing check, not a dependency on `:focus-visible` matching (jsdom's
 * support for which is inconsistent), so it behaves the same in tests as in
 * a real browser.
 *
 * ## Placement
 *
 * Defaults to opening above the trigger (`side="top"`, unchanged since this
 * primitive was built) — the right fit for the ordinary case, a trigger
 * comfortably inside the viewport on every side. `side="right"` is the one
 * documented exception: the sidebar's edge-mounted collapse handle
 * (`src/features/shell/Sidebar.tsx`) sits flush against the top of the
 * shell, where a `top`-opening tooltip gets clipped by the viewport edge —
 * opening it into the content area instead (`.tooltip[data-side='right']`,
 * `components.css`) has nowhere to be clipped. No other trigger currently
 * needs this; the prop exists so the next one that does can ask for it
 * rather than a one-off CSS override on `.tooltip`.
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
} from 'react'

const HIDE_DELAY_MS = 150

export function Tooltip({
  content,
  side = 'top',
  children,
}: {
  readonly content: string
  /** Which side of the trigger the tooltip opens on. Defaults to `'top'`. */
  readonly side?: 'top' | 'right'
  readonly children: ReactElement<{
    'aria-describedby'?: string
    onFocus?: (e: React.FocusEvent) => void
    onBlur?: (e: React.FocusEvent) => void
    onMouseEnter?: (e: React.MouseEvent) => void
    onMouseLeave?: (e: React.MouseEvent) => void
    onMouseDown?: (e: React.MouseEvent) => void
  }>
}) {
  const [hovering, setHovering] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pointerDown = useRef(false)
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
    onMouseDown: (e: React.MouseEvent) => {
      children.props.onMouseDown?.(e)
      pointerDown.current = true
    },
    onFocus: (e: React.FocusEvent) => {
      children.props.onFocus?.(e)
      setDismissed(false)
      // A click focuses the trigger too; only genuine (keyboard) focus opens
      // the tooltip here — see this file's header comment.
      if (!pointerDown.current) setFocused(true)
      pointerDown.current = false
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
        data-side={side !== 'top' ? side : undefined}
        data-visible={visible ? 'true' : undefined}
        onMouseEnter={enter}
        onMouseLeave={leave}
      >
        {content}
      </span>
    </span>
  )
}
