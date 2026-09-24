// @vitest-environment jsdom
/**
 * Audit A, correction pass 3 — retiring the local legacy catalogue needs the
 * OWNER role the server holds NOW, not the one the boot cached.
 *
 * The real App, the real gateway, the real local GoTrue + PostgREST, and a
 * legacy IndexedDB built by the real persistence layer (fake-indexeddb
 * supplies the browser API). The OWNER starts "back up and remove"; the
 * action is paused inside the backup delivery — the last step before the
 * deletion; the membership is changed IN THE DATABASE; the action resumes.
 * The local database must survive, no completion marker may be written, and
 * the stale OWNER screen must not come back.
 */
import 'fake-indexeddb/auto'
import { createElement, type FunctionComponent } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import App from '../App'
import type { ApplicationBootOptions } from './useApplicationBoot'
import { setLocale } from '../i18n'
import { createCloudClient } from '../cloud/client'
import { createDataGateway, type DataGateway } from '../cloud/gateway'
import { CATALOG_CUTOVER_MARKER_KEY } from '../cloud/legacyMigration'
import { deleteDatabase, openDatabase, saveProduct } from '../persistence'
import { freshUser, MemoryStorage } from '../cloud/security/fixtures'
import { localStack, SEED, sql } from '../cloud/security/localStack'

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
}

const INSTANT = '2026-09-01T10:00:00.000Z'
const DEACTIVATED = 'Hesabınızın bu şirketteki erişimi pasife alınmış. Yöneticinize başvurun.'
const AppWithOptions = App as unknown as FunctionComponent<{ options: ApplicationBootOptions }>
const databases: string[] = []

beforeAll(async () => {
  await setLocale('tr')
})

afterEach(async () => {
  cleanup()
  for (const name of databases.splice(0)) await deleteDatabase(name)
})

function gatewayFor(storage: Storage): DataGateway {
  const { apiUrl, publishableKey } = localStack()
  return createDataGateway(createCloudClient({ url: apiUrl, publishableKey }, { storage }), { storage })
}

async function exists(name: string): Promise<boolean> {
  return (await indexedDB.databases()).some((entry) => entry.name === name)
}

/** An OWNER at MIGRATION_FAILED with the retire button, the retire action paused inside the backup delivery. */
async function pausedRetire(label: string) {
  const owner = await freshUser(label, 'OWNER')
  // The cloud catalogue is already in use, so the migration stops with CLOUD_NOT_EMPTY — a retirable reason.
  await sql(`insert into app_data.products (organization_id, sku, name, stock_unit) values ('${owner.organizationId}', 'CLOUD-1', 'Cloud product', 'PIECE');`)

  const databaseName = `retire-authority-${crypto.randomUUID()}`
  databases.push(databaseName)
  const database = await openDatabase({ name: databaseName })
  await saveProduct(database, { id: crypto.randomUUID(), sku: 'LEGACY-1', name: 'Legacy', stockUnit: 'PIECE', active: true, createdAt: INSTANT, updatedAt: INSTANT })
  database.close()

  const session = new MemoryStorage()
  const gateway = gatewayFor(session)
  await gateway.signInWithPassword(owner.email, SEED.password)

  const migrationStorage = new MemoryStorage()
  let deliveries = 0
  let release: () => void = () => {}
  let reached: () => void = () => {}
  const arrived = new Promise<void>((resolve) => { reached = resolve })
  const deliverBackup = () => {
    deliveries += 1
    if (deliveries !== 2) return undefined
    reached()
    return new Promise<void>((resolve) => { release = resolve })
  }

  render(createElement(AppWithOptions, { options: { gateway, migration: { databaseName, storage: migrationStorage, deliverBackup } } }))
  fireEvent.click(await screen.findByRole('button', { name: 'Yedekle ve taşı' }, { timeout: 20_000 }))
  fireEvent.click(await screen.findByRole('button', { name: 'Yerel kataloğu yedekle ve kaldır' }, { timeout: 20_000 }))
  fireEvent.click(await screen.findByRole('button', { name: 'Yedekle ve kaldır' }))
  await arrived

  return { owner, databaseName, migrationStorage, resume: () => release() }
}

describe('the OWNER authority is re-read from the server right before the local catalogue is removed', () => {
  it('OWNER → MEMBER while paused: nothing deleted, nothing marked, no retire action offered afterwards', async () => {
    const { owner, databaseName, migrationStorage, resume } = await pausedRetire('RetireDowngraded')

    await sql(`update app_data.memberships set role = 'MEMBER' where user_id = '${owner.userId}' and organization_id = '${owner.organizationId}';`)
    resume()

    // The application reboots from live state: a MEMBER on the migration screen, with no retire action.
    await waitFor(() => expect(screen.queryByText('Taşıma güvenle durduruldu')).toBeNull(), { timeout: 20_000 })
    expect(await screen.findByText('Bu kataloğu buluta taşıyın', undefined, { timeout: 20_000 })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Yerel kataloğu yedekle ve kaldır' })).toBeNull()
    expect(await exists(databaseName)).toBe(true)
    expect(migrationStorage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
  }, 90_000)

  it('ACTIVE → DISABLED while paused: nothing deleted, nothing marked, the deactivated screen instead', async () => {
    const { owner, databaseName, migrationStorage, resume } = await pausedRetire('RetireDisabled')

    await sql(`update app_data.memberships set status = 'DISABLED' where user_id = '${owner.userId}' and organization_id = '${owner.organizationId}';`)
    resume()

    expect(await screen.findByText(DEACTIVATED, undefined, { timeout: 20_000 })).toBeTruthy()
    expect(screen.queryByText('Bu kataloğu buluta taşıyın')).toBeNull()
    expect(await exists(databaseName)).toBe(true)
    expect(migrationStorage.getItem(CATALOG_CUTOVER_MARKER_KEY)).toBeNull()
  }, 90_000)

  it('control: with the membership unchanged, the same paused retire does remove the local copy', async () => {
    const { databaseName, migrationStorage, resume } = await pausedRetire('RetireUnchanged')
    resume()

    await waitFor(async () => expect(await exists(databaseName)).toBe(false), { timeout: 20_000 })
    await waitFor(() => expect(JSON.parse(migrationStorage.getItem(CATALOG_CUTOVER_MARKER_KEY) ?? '{}')).toMatchObject({ resolution: 'RETIRED_WITH_BACKUP' }))
  }, 90_000)
})
