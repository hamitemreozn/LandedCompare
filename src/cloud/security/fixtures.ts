/**
 * Fixtures for the Audit A regression suites: fresh organisations, and the
 * REAL gateway — the production module, not a double — pointed at the local
 * stack with a session storage of its own.
 *
 * Each test creates its own organisation with random ids, so a file can run
 * again without a reset and no test depends on another's rows.
 */
import { createCloudClient } from '../client'
import { createDataGateway, type DataGateway } from '../gateway'
import { localStack, SEED, sql } from './localStack'

export class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length(): number { return this.map.size }
  clear(): void { this.map.clear() }
  getItem(key: string): string | null { return this.map.has(key) ? this.map.get(key)! : null }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null }
  removeItem(key: string): void { this.map.delete(key) }
  setItem(key: string, value: string): void { this.map.set(key, String(value)) }
}

export interface RealGateway {
  readonly gateway: DataGateway
  readonly storage: Storage
  /** While true, every request fails as a browser's `fetch` does with no network. */
  offline: boolean
  /**
   * Runs after a response has arrived and before the gateway sees it — the
   * moment to change the database "between two pages" deterministically.
   */
  afterResponse?: (url: URL) => void | Promise<void>
}

export function realGateway(options: { storage?: Storage; pageSize?: number } = {}): RealGateway {
  const { apiUrl, publishableKey } = localStack()
  const storage = options.storage ?? new MemoryStorage()
  const handle: RealGateway = {
    gateway: undefined as unknown as DataGateway,
    storage,
    offline: false,
  }
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (handle.offline) throw new TypeError('Failed to fetch')
    const response = await fetch(input, init)
    if (handle.afterResponse) {
      await handle.afterResponse(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
    }
    return response
  }) as typeof fetch
  const client = createCloudClient({ url: apiUrl, publishableKey }, { storage, fetch: transport })
  ;(handle as { gateway: DataGateway }).gateway = createDataGateway(client, { storage, pageSize: options.pageSize })
  return handle
}

export async function signedInGateway(email: string, options: { storage?: Storage; pageSize?: number } = {}): Promise<RealGateway> {
  const handle = realGateway(options)
  await handle.gateway.signInWithPassword(email, SEED.password)
  return handle
}

/**
 * A new, empty organisation owned by a new user, plus optional new members.
 *
 * Seed users are never given extra memberships here: other suites assert how
 * many organisations a seed user belongs to, and a fixture that quietly added
 * one would make them depend on the order the files run in.
 */
export async function freshOrganization(
  label: string,
  members: readonly ('OWNER' | 'ADMIN' | 'MEMBER')[] = [],
): Promise<{ organizationId: string; owner: FreshUser; members: FreshUser[] }> {
  const owner = await freshUser(label, 'OWNER')
  const added: FreshUser[] = []
  for (const role of members) {
    added.push(await addFreshUser(owner.organizationId, `${label}-${role.toLowerCase()}`, role))
  }
  return { organizationId: owner.organizationId, owner, members: added }
}

/** Inserts `count` catalogue rows into an organisation as the database owner. */
export async function seedRows(table: 'products' | 'suppliers' | 'customers' | 'customer_statuses', organizationId: string, count: number): Promise<void> {
  const columns: Record<typeof table, string> = {
    products: `(id, organization_id, sku, name, stock_unit) select gen_random_uuid(), '${organizationId}', 'BULK-' || g, 'Bulk ' || g, 'PIECE'`,
    suppliers: `(id, organization_id, display_name) select gen_random_uuid(), '${organizationId}', 'Supplier ' || g`,
    customers: `(id, organization_id, display_name) select gen_random_uuid(), '${organizationId}', 'Customer ' || g`,
    customer_statuses: `(id, organization_id, code, sort_order) select gen_random_uuid(), '${organizationId}', 'S-' || g, g % 7`,
  }
  await sql(`insert into app_data.${table} ${columns[table]} from generate_series(1, ${count}) g;`)
}

export async function countRows(table: string, organizationId: string): Promise<number> {
  return Number(await sql(`select count(*) from app_data.${table} where organization_id = '${organizationId}';`))
}

export interface FreshUser {
  readonly userId: string
  readonly email: string
  readonly organizationId: string
  readonly organizationName: string
  readonly displayName: string
}

function authUserStatements(userId: string, email: string): string {
  return (
    `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change) ` +
    `values ('00000000-0000-0000-0000-000000000000', '${userId}', 'authenticated', 'authenticated', '${email}', extensions.crypt('${SEED.password}', extensions.gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''); ` +
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) ` +
    `values ('${userId}', '${userId}', '{"sub":"${userId}","email":"${email}","email_verified":true}', 'email', now(), now(), now()); `
  )
}

/**
 * A new auth user who belongs to exactly one new organisation, so the boot
 * sequence has no other membership to choose (the MVP selects the lowest
 * organisation id when there are several). Shaped like `supabase/seed.sql`.
 */
export async function freshUser(label: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER'): Promise<FreshUser> {
  const userId = crypto.randomUUID()
  const organizationId = crypto.randomUUID()
  const email = `${label.toLowerCase()}-${userId.slice(0, 8)}@example.test`
  const organizationName = `${label} Org ${userId.slice(0, 4)}`
  const displayName = `${label} User`
  await sql(
    authUserStatements(userId, email) +
      `select set_config('app.actor_user_id', '${userId}', false); ` +
      `insert into app_data.organizations (id, name) values ('${organizationId}', '${organizationName}'); ` +
      `insert into app_data.profiles (user_id, display_name, must_change_password) values ('${userId}', '${displayName}', false); ` +
      `insert into app_data.memberships (organization_id, user_id, role, status) values ('${organizationId}', '${userId}', '${role}', 'ACTIVE');`,
  )
  return { userId, email, organizationId, organizationName, displayName }
}

/** A new auth user added to an EXISTING organisation, and to nothing else. */
export async function addFreshUser(
  organizationId: string,
  label: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
): Promise<FreshUser> {
  const userId = crypto.randomUUID()
  const email = `${label.toLowerCase()}-${userId.slice(0, 8)}@example.test`
  const displayName = `${label} User`
  await sql(
    authUserStatements(userId, email) +
      `select set_config('app.actor_user_id', '${userId}', false); ` +
      `insert into app_data.profiles (user_id, display_name, must_change_password) values ('${userId}', '${displayName}', false); ` +
      `insert into app_data.memberships (organization_id, user_id, role, status) values ('${organizationId}', '${userId}', '${role}', 'ACTIVE');`,
  )
  const organizationName = await sql(`select name from app_data.organizations where id = '${organizationId}';`)
  return { userId, email, organizationId, organizationName, displayName }
}
