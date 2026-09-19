import { describe, expect, it } from 'vitest'
import {
  estimateStorage,
  isStoragePersisted,
  requestPersistentStorage,
} from './storage'
import { createTabAdvisory, type TabAdvisoryMessage } from './tabAdvisory'

describe('storage durability', () => {
  it('reports UNSUPPORTED rather than pretending a grant was obtained', async () => {
    expect(await requestPersistentStorage({})).toBe('UNSUPPORTED')
    expect(await isStoragePersisted({})).toBe('UNSUPPORTED')
  })

  it('distinguishes a granted from a refused persistence request', async () => {
    expect(await requestPersistentStorage({ storage: { persist: async () => true } })).toBe(
      'PERSISTED',
    )
    expect(await requestPersistentStorage({ storage: { persist: async () => false } })).toBe(
      'NOT_PERSISTED',
    )
  })

  it('treats a thrown persistence request as not persisted, not as a crash', async () => {
    const grant = await requestPersistentStorage({
      storage: {
        persist: () => Promise.reject(new Error('permission policy')),
      },
    })
    expect(grant).toBe('NOT_PERSISTED')
  })
})

describe('storage estimate', () => {
  it('reports usage, quota and the fraction used', async () => {
    const usage = await estimateStorage({
      storage: { estimate: async () => ({ usage: 250, quota: 1000 }) },
    })
    expect(usage).toEqual({
      supported: true,
      usageBytes: 250,
      quotaBytes: 1000,
      usedFraction: 0.25,
    })
  })

  it('does not fabricate a fraction when only one figure is known', async () => {
    const usage = await estimateStorage({ storage: { estimate: async () => ({ usage: 250 }) } })
    expect(usage.usedFraction).toBeUndefined()
    expect(usage.supported).toBe(true)
  })

  it('reports unsupported where the API is missing', async () => {
    expect(await estimateStorage({})).toEqual({ supported: false })
  })
})

describe('multi-tab advisory', () => {
  function createChannelPair() {
    const listeners: Array<(event: { data: unknown }) => void> = []
    const create = () => {
      const channel = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage(message: unknown) {
          for (const listener of listeners) {
            if (listener !== channel.onmessage) {
              listener({ data: message })
            }
          }
        },
        close() {
          const index = listeners.indexOf(channel.onmessage!)
          if (index >= 0) listeners.splice(index, 1)
        },
      }
      // Registered lazily: `onmessage` is assigned after construction.
      queueMicrotask(() => {
        if (channel.onmessage !== null) listeners.push(channel.onmessage)
      })
      return channel
    }
    return { create }
  }

  it('degrades to an inert advisory where BroadcastChannel is missing', () => {
    const advisory = createTabAdvisory({
      onOtherTab: () => {
        throw new Error('should not be called')
      },
      createChannel: undefined,
      channelName: 'test',
      tabId: 'tab-a',
    })
    // jsdom/Node may or may not provide BroadcastChannel; either way the
    // advisory must be usable and must never throw.
    expect(typeof advisory.supported).toBe('boolean')
    expect(() => advisory.announce()).not.toThrow()
    expect(() => advisory.close()).not.toThrow()
  })

  it('tells an existing tab that another one opened', async () => {
    const { create } = createChannelPair()
    const seenByFirst: TabAdvisoryMessage[] = []
    const seenBySecond: TabAdvisoryMessage[] = []

    const first = createTabAdvisory({
      onOtherTab: (message) => seenByFirst.push(message),
      createChannel: create,
      tabId: 'tab-a',
    })
    const second = createTabAdvisory({
      onOtherTab: (message) => seenBySecond.push(message),
      createChannel: create,
      tabId: 'tab-b',
    })
    await Promise.resolve()

    second.announce()

    expect(seenByFirst).toEqual([{ type: 'TAB_OPENED', tabId: 'tab-b' }])
    // The reply is how the newcomer learns the older tab is there.
    expect(seenBySecond).toEqual([{ type: 'TAB_PRESENT', tabId: 'tab-a' }])

    first.close()
    second.close()
  })

  it('ignores its own announcement', async () => {
    const { create } = createChannelPair()
    const seen: TabAdvisoryMessage[] = []
    const only = createTabAdvisory({
      onOtherTab: (message) => seen.push(message),
      createChannel: create,
      tabId: 'tab-a',
    })
    await Promise.resolve()

    only.announce()
    expect(seen).toEqual([])
    only.close()
  })
})
