/**
 * The migration and retire ACTIONS against a change of identity while they
 * run (Audit A source review, R-4).
 *
 * The boot sequence has always been cancelled by its effect cleanup; the two
 * actions on the migration screen were not. Each test below pauses an action
 * at a real asynchronous boundary — the backup delivery, which in a browser
 * waits for as long as the user takes — changes the session, and then lets
 * the old action finish. The previous user's migration screen must never come
 * back, and the local database must never be deleted on the previous user's
 * authority.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { setLocale } from '../i18n'
import { CATALOG_CUTOVER_MARKER_KEY, type AuthChange } from '../cloud'
import { deleteDatabase, openDatabase, saveProduct, type ProductRecord as LegacyProduct } from '../persistence'
import { createTestDatabaseName, TEST_INSTANT } from '../persistence/testSupport'
import { createMemoryCloudGateway, TEST_ORGANIZATION_ID, TEST_USER_ID } from '../test/memoryCloud'

const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

const LEGACY: LegacyProduct = {
  id: 'd1000000-0000-4000-8000-0000000000aa',
  sku: 'RACE-1',
  name: 'Legacy product',
  stockUnit: 'PIECE',
  active: true,
  createdAt: TEST_INSTANT,
  updatedAt: TEST_INSTANT,
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length() { return this.map.size }
  clear() { this.map.clear() }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number) { return [...this.map.keys()][index] ?? null }
  removeItem(key: string) { this.map.delete(key) }
  setItem(key: string, value: string) { this.map.set(key, String(value)) }
}

/** A memory cloud whose session can be replaced — with or without an event reaching this tab. */
function switchableCloud() {
  const cloud = createMemoryCloudGateway()
  let current: string | null = TEST_USER_ID
  const listeners = new Set<(change: AuthChange) => void>()
  cloud.currentUserId = async () => current
  cloud.onAuthChange = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return {
    cloud,
    /** Replaces the session; `event` is what this tab hears, if anything. */
    become(userId: string | null, event?: AuthChange['event']) {
      current = userId
      if (event) for (const listener of listeners) listener({ event, userId })
    },
  }
}

/** A backup delivery that waits until the test lets it finish — or fail. */
function pausableDelivery() {
  let calls = 0
  let pauseAt = Number.POSITIVE_INFINITY
  let release: (() => void) | undefined
  let fail: ((cause: Error) => void) | undefined
  let reached: (() => void) | undefined
  const arrived = new Promise<void>((resolve) => { reached = resolve })
  return {
    deliverBackup: () => {
      calls += 1
      if (calls !== pauseAt) return
      reached?.()
      return new Promise<void>((resolve, reject) => { release = resolve; fail = reject })
    },
    pauseOnCall(call: number) { pauseAt = call },
    arrived,
    release: () => release?.(),
    fail: (cause: Error) => fail?.(cause),
  }
}

let databaseName: string
let storage: MemoryStorage

beforeEach(async () => {
  await setLocale('tr')
  storage = new MemoryStorage()
  databaseName = createTestDatabaseName('auth-race')
  const database = await openDatabase({ name: databaseName })
  await saveProduct(database, LEGACY)
  database.close()
})

afterEach(async () => {
  await deleteDatabase(databaseName)
})

async function exists(name: string): Promise<boolean> {
  return (await indexedDB.databases()).some((entry) => entry.name === name)
}

/** Brings the app to MIGRATION_FAILED with the OWNER's retire button: the cloud is already in use. */
async function toRetirableFailure(cloud: ReturnType<typeof switchableCloud>['cloud']) {
  await cloud.catalog.createProduct(TEST_ORGANIZATION_ID, { id: crypto.randomUUID(), sku: 'CLOUD-ONLY', name: 'Cloud', stockUnit: 'PIECE' })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Yedekle ve taşı' }))
  await user.click(await screen.findByRole('button', { name: 'Yerel kataloğu yedekle ve kaldır' }))
  return user
}

describe('an action started for user A, finishing after the session changed', () => {
  it('migrate: signed out mid-action, the old failure does not bring A\'s migration screen back', async () => {
    const { cloud, become } = switchableCloud()
    const delivery = pausableDelivery()
    delivery.pauseOnCall(1)
    render(<App options={{ gateway: cloud, migration: { databaseName, storage, deliverBackup: delivery.deliverBackup } }} />)

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Yedekle ve taşı' }))
    await delivery.arrived

    become(null, 'SIGNED_OUT')
    expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument()

    delivery.fail(new Error('the download was interrupted'))
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(screen.getByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument()
    expect(screen.queryByText('Bu kataloğu buluta taşıyın')).not.toBeInTheDocument()
    expect(screen.queryByText('Taşıma güvenle durduruldu')).not.toBeInTheDocument()
    expect(await exists(databaseName)).toBe(true)
  })

  it('retire: another user signs in mid-action — nothing is deleted, nothing is marked, A\'s screen does not return', async () => {
    const { cloud, become } = switchableCloud()
    const delivery = pausableDelivery()
    render(<App options={{ gateway: cloud, migration: { databaseName, storage, deliverBackup: delivery.deliverBackup } }} />)
    const user = await toRetirableFailure(cloud)
    // Call 1 was the migrate attempt's backup; call 2 is the retire's.
    delivery.pauseOnCall(2)
    await user.click(await screen.findByRole('button', { name: 'Yedekle ve kaldır' }))
    await delivery.arrived

    become(USER_B, 'SIGNED_IN')
    // B boots; the legacy database is still there, so B is offered the migration afresh.
    await waitFor(() => expect(screen.queryByText('Taşıma güvenle durduruldu')).not.toBeInTheDocument())

    delivery.release()
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(await exists(databaseName)).toBe(true)
    expect(storage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
    expect(screen.queryByText('Taşıma güvenle durduruldu')).not.toBeInTheDocument()
  })

  it('retire: the session changed with NO event reaching this tab — the check before deletion still refuses', async () => {
    const { cloud, become } = switchableCloud()
    const delivery = pausableDelivery()
    render(<App options={{ gateway: cloud, migration: { databaseName, storage, deliverBackup: delivery.deliverBackup } }} />)
    const user = await toRetirableFailure(cloud)
    delivery.pauseOnCall(2)
    await user.click(await screen.findByRole('button', { name: 'Yedekle ve kaldır' }))
    await delivery.arrived

    // Nothing is announced: only the identity check right before the
    // deletion can notice. It must refuse, and reboot the application.
    become(USER_B)
    delivery.release()

    await waitFor(() => expect(screen.queryByText('Taşıma güvenle durduruldu')).not.toBeInTheDocument())
    expect(await exists(databaseName)).toBe(true)
    expect(storage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
  })

  it('control: with the session unchanged, the same paused retire does delete and mark complete', async () => {
    const { cloud } = switchableCloud()
    const delivery = pausableDelivery()
    render(<App options={{ gateway: cloud, migration: { databaseName, storage, deliverBackup: delivery.deliverBackup } }} />)
    const user = await toRetirableFailure(cloud)
    delivery.pauseOnCall(2)
    await user.click(await screen.findByRole('button', { name: 'Yedekle ve kaldır' }))
    await delivery.arrived
    delivery.release()

    await waitFor(async () => expect(await exists(databaseName)).toBe(false))
    await waitFor(() => expect(JSON.parse(storage.getItem(CATALOG_CUTOVER_MARKER_KEY) ?? '{}')).toMatchObject({ resolution: 'RETIRED_WITH_BACKUP' }))
  })
})

describe('live authority, not the role the boot cached (pass 3)', () => {
  it('retire: OWNER downgraded to MEMBER while the backup is delivered — nothing deleted, nothing marked', async () => {
    const { cloud } = switchableCloud()
    let role: 'OWNER' | 'MEMBER' = 'OWNER'
    cloud.identity.listOwnMemberships = async () => [{ organizationId: TEST_ORGANIZATION_ID, userId: TEST_USER_ID, role, status: 'ACTIVE' }]
    const delivery = pausableDelivery()
    render(<App options={{ gateway: cloud, migration: { databaseName, storage, deliverBackup: delivery.deliverBackup } }} />)
    const user = await toRetirableFailure(cloud)
    delivery.pauseOnCall(2)
    await user.click(await screen.findByRole('button', { name: 'Yedekle ve kaldır' }))
    await delivery.arrived

    role = 'MEMBER'
    delivery.release()

    // The application reboots from live state: a MEMBER is offered no retire action.
    await waitFor(() => expect(screen.queryByText('Taşıma güvenle durduruldu')).not.toBeInTheDocument())
    expect(await screen.findByText('Bu kataloğu buluta taşıyın')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Yerel kataloğu yedekle ve kaldır' })).not.toBeInTheDocument()
    expect(await exists(databaseName)).toBe(true)
    expect(storage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
  })
})

describe('the automatic retirement of an EMPTY legacy database (pass 3)', () => {
  it('is not performed for a boot whose user no longer holds the session', async () => {
    // A database that exists and holds nothing.
    const empty = createTestDatabaseName('auth-race-empty')
    ;(await openDatabase({ name: empty })).close()
    const cloud = createMemoryCloudGateway()
    // The boot reads A at its start and at its end; by the time the empty
    // database would be deleted, the session is gone.
    let reads = 0
    cloud.currentUserId = async () => (++reads <= 2 ? TEST_USER_ID : null)
    try {
      render(<App options={{ gateway: cloud, migration: { databaseName: empty, storage } }} />)
      expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument()
      expect(await exists(empty)).toBe(true)
      expect(storage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
    } finally {
      await deleteDatabase(empty)
    }
  })

  it('control: for the current user it is still retired, with no role required', async () => {
    const empty = createTestDatabaseName('auth-race-empty')
    ;(await openDatabase({ name: empty })).close()
    const cloud = createMemoryCloudGateway()
    cloud.identity.listOwnMemberships = async () => [{ organizationId: TEST_ORGANIZATION_ID, userId: TEST_USER_ID, role: 'MEMBER', status: 'ACTIVE' }]
    render(<App options={{ gateway: cloud, migration: { databaseName: empty, storage } }} />)
    await waitFor(async () => expect(await exists(empty)).toBe(false))
    await waitFor(() => expect(JSON.parse(storage.getItem(CATALOG_CUTOVER_MARKER_KEY) ?? '{}')).toMatchObject({ resolution: 'EMPTY_DATABASE' }))
  })
})
