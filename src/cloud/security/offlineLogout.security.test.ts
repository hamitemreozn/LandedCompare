/**
 * Audit A, A-M3 — sign-out ends the session on this device even offline.
 *
 * Audit A reproduced it against the real stack: with an expired access token
 * and no network, auth-js could not load (refresh) the session in order to
 * remove it, the gateway ignored the returned error, the screen said "signed
 * out" — and the moment the network returned, the previous user was back
 * without a password. On a shared office computer that is the next person
 * working as the last one.
 *
 * Real GoTrue, the real gateway; only the network is switched off, by making
 * the transport fail exactly as a browser's `fetch` does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootstrapCloudSession } from '../boot'
import { CLOUD_SESSION_STORAGE_KEY } from '../client'
import { freshUser, MemoryStorage, realGateway, signedInGateway } from './fixtures'
import { localStack, SEED } from './localStack'

afterEach(() => {
  vi.useRealTimers()
})

function expire(storage: Storage): void {
  const stored = JSON.parse(storage.getItem(CLOUD_SESSION_STORAGE_KEY) ?? '{}') as { expires_at?: number }
  stored.expires_at = Math.floor(Date.now() / 1000) - 60
  storage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(stored))
}

describe('sign-out with an expired access token and no network', () => {
  it('clears the local session, and restoring the network does not sign the user back in', async () => {
    const user = await freshUser('OfflineLogout', 'OWNER')
    const storage = new MemoryStorage()
    const device = await signedInGateway(user.email, { storage })
    expect(await device.gateway.currentUserId()).toBe(user.userId)

    expire(storage)
    device.offline = true

    // auth-js retries a failed refresh with back-off for up to 30 seconds; the
    // clock is advanced rather than waited out.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const signedOut = device.gateway.signOut()
    await vi.advanceTimersByTimeAsync(120_000)
    await signedOut
    vi.useRealTimers()

    for (const key of [CLOUD_SESSION_STORAGE_KEY, `${CLOUD_SESSION_STORAGE_KEY}-user`, `${CLOUD_SESSION_STORAGE_KEY}-code-verifier`]) {
      expect(storage.getItem(key), key).toBeNull()
    }

    // The network is back. A fresh start on this device must find nobody.
    device.offline = false
    const nextMorning = realGateway({ storage })
    expect(await nextMorning.gateway.currentUserId()).toBeNull()
    expect(await bootstrapCloudSession(nextMorning.gateway)).toMatchObject({ phase: 'SIGNED_OUT' })
  }, 60_000)

  it('online, sign-out also revokes the session on the server', async () => {
    const storage = new MemoryStorage()
    const device = await signedInGateway(SEED.memberB.email, { storage })
    const stolen = JSON.parse(storage.getItem(CLOUD_SESSION_STORAGE_KEY) ?? '{}') as { refresh_token?: string }
    expect(stolen.refresh_token).toBeTruthy()

    await device.gateway.signOut()
    expect(storage.getItem(CLOUD_SESSION_STORAGE_KEY)).toBeNull()

    // A copy of the refresh token taken before sign-out no longer works: the
    // Auth service itself refuses it.
    const { apiUrl, publishableKey } = localStack()
    const replay = await fetch(`${apiUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: stolen.refresh_token }),
    })
    expect(replay.status).toBe(400)
    expect(((await replay.json()) as { error_code?: string }).error_code).toMatch(/refresh_token/)
  }, 60_000)
})
