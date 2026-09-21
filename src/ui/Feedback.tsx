/**
 * The small set of things that tell the user something: a status badge, a
 * banner, an empty state.
 *
 * The rule they all follow is the accessibility one that is easiest to break
 * and hardest to notice: **colour never carries meaning on its own.** A badge
 * is not "active" because it is green, it is active because it says "Aktif";
 * a banner is not a warning because it is amber, it carries the word
 * "Warning" as its label. Someone reading in greyscale, or through a screen
 * reader, gets the same information as someone looking at the colour.
 */

import type { ReactNode } from 'react'

export function StatusBadge({ active, activeLabel, inactiveLabel }: {
  readonly active: boolean
  readonly activeLabel: string
  readonly inactiveLabel: string
}) {
  return (
    <span className={active ? 'badge badge--active' : 'badge badge--inactive'}>
      {active ? activeLabel : inactiveLabel}
    </span>
  )
}

export type BannerTone = 'info' | 'warning' | 'danger'

export function Banner({
  tone,
  label,
  children,
  note,
  actions,
}: {
  readonly tone: BannerTone
  readonly label: string
  readonly children: ReactNode
  readonly note?: ReactNode
  readonly actions?: ReactNode
}) {
  return (
    <div
      className={`banner banner--${tone}`}
      // A warning the user must not miss is announced; an informational one is
      // not, because interrupting a screen-reader user to say "everything is
      // fine" is worse than saying nothing.
      role={tone === 'info' ? undefined : 'alert'}
    >
      <div className="banner__body">
        <span className="banner__label">{label}</span>
        <span className="banner__text">{children}</span>
        {note !== undefined ? <span className="banner__note">{note}</span> : null}
        {actions !== undefined ? <span className="row">{actions}</span> : null}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
}: {
  readonly title: string
  readonly body: string
  readonly action?: ReactNode
}) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      <p className="empty__body">{body}</p>
      {action !== undefined ? <div className="empty__action">{action}</div> : null}
    </div>
  )
}
