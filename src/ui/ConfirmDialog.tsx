/**
 * A confirmation dialog, hand-built and deliberately small.
 *
 * ## Why not `<dialog>`
 *
 * `showModal()` gives focus trapping and Escape handling for free, which is a
 * real argument for it. It also has to be driven imperatively through a ref
 * and is unevenly implemented in the test environment, and the behaviour it
 * provides is about thirty lines here. For one dialog with two buttons, a
 * component whose behaviour is visible in the file beats one whose behaviour
 * depends on the browser.
 *
 * ## What it actually does
 *
 * - `role="dialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`, so
 *   it is announced as a dialog with its own title and body.
 * - Moves focus to the confirming button on open, and back to whatever was
 *   focused before on close. A dialog that opens without moving focus leaves a
 *   keyboard user tabbing through the page behind it.
 * - Escape cancels. A modal a keyboard user cannot dismiss is a trap.
 * - The backdrop cancels on click, but a click *inside* the panel does not
 *   bubble out to it.
 *
 * There is no focus **trap**: Tab can still leave the panel. Adding one costs
 * a sentinel pair and a keydown handler, and for a two-button confirmation
 * over a non-destructive action (deactivation is reversible; nothing here
 * deletes) the honest trade is to keep the component readable.
 */

import { useEffect, useRef } from 'react'

export function ConfirmDialog({
  title,
  body,
  note,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  readonly title: string
  readonly body: string
  readonly note?: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
  readonly busy?: boolean
}) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus?.()
    }
  }, [onCancel])

  return (
    <div
      className="modal-backdrop"
      // Presentational: the backdrop is a click target, not a control. The
      // dialog inside it is what carries the semantics.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-body"
      >
        <h2 className="modal__title" id="confirm-dialog-title">
          {title}
        </h2>
        <p className="modal__body" id="confirm-dialog-body">
          {body}
        </p>
        {note !== undefined ? <p className="modal__note">{note}</p> : null}
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel} disabled={busy === true}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="button button--primary"
            ref={confirmRef}
            onClick={onConfirm}
            disabled={busy === true}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
