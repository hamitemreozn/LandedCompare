/**
 * Multi-tab advisory.
 *
 * The stale-write check in `staleWrite.ts` catches a second tab at the moment
 * it causes a conflict. This announces the second tab *before* that, so the
 * newly opened one can warn instead of waiting for the user to lose an edit.
 *
 * It is an advisory and nothing more: no locking, no leader election, no
 * merge. `docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §5 is explicit that detecting
 * the situation and refusing is the goal, and resolving it is the user's job.
 *
 * `BroadcastChannel` is feature-detected. Where it is missing the advisory
 * reports `supported: false` and the stale-write check — which does not depend
 * on it — remains the actual protection.
 */

export interface TabAdvisoryMessage {
  readonly type: 'TAB_OPENED' | 'TAB_PRESENT'
  readonly tabId: string
}

export interface TabAdvisory {
  readonly supported: boolean
  readonly tabId: string
  /** Announces this tab. Other tabs reply, which is how this one learns of them. */
  announce(): void
  close(): void
}

interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((event: { data: unknown }) => void) | null
}

export interface TabAdvisoryOptions {
  /** Called when another tab is known to be open on this database. */
  readonly onOtherTab: (message: TabAdvisoryMessage) => void
  readonly channelName?: string
  readonly tabId?: string
  readonly createChannel?: (name: string) => BroadcastChannelLike
}

const CHANNEL_NAME = 'landedcompare.tabs'

function isAdvisoryMessage(value: unknown): value is TabAdvisoryMessage {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    (message.type === 'TAB_OPENED' || message.type === 'TAB_PRESENT') &&
    typeof message.tabId === 'string'
  )
}

export function createTabAdvisory(options: TabAdvisoryOptions): TabAdvisory {
  const name = options.channelName ?? CHANNEL_NAME
  const tabId = options.tabId ?? crypto.randomUUID()

  const factory =
    options.createChannel ??
    (() => {
      const ctor = (globalThis as { BroadcastChannel?: new (name: string) => BroadcastChannelLike })
        .BroadcastChannel
      return ctor === undefined ? undefined : (channel: string) => new ctor(channel)
    })()

  if (factory === undefined) {
    return { supported: false, tabId, announce: () => {}, close: () => {} }
  }

  const channel = factory(name)

  channel.onmessage = (event) => {
    const message: unknown = event.data
    if (!isAdvisoryMessage(message) || message.tabId === tabId) {
      return
    }
    if (message.type === 'TAB_OPENED') {
      // Reply so the newcomer learns this tab exists; it announced, this one
      // answers. Without the reply only the older tab would ever know.
      channel.postMessage({ type: 'TAB_PRESENT', tabId } satisfies TabAdvisoryMessage)
    }
    options.onOtherTab(message)
  }

  return {
    supported: true,
    tabId,
    announce: () => channel.postMessage({ type: 'TAB_OPENED', tabId } satisfies TabAdvisoryMessage),
    close: () => {
      channel.onmessage = null
      channel.close()
    },
  }
}
