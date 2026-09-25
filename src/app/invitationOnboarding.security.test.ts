// @vitest-environment jsdom
/**
 * Phase 12 — final onboarding correction, against the real local stack and
 * the REAL App: GoTrue, PostgREST, the Edge runtime, and the local mail
 * capture playing the invited person's mailbox.
 *
 *   A  failed-link orphan retry: X invites U → the link step fails → the
 *      identity is kept, no membership → a NEW request re-invites U → the link
 *      succeeds → U opens the latest invitation in the application → U is
 *      asked to CHOOSE a password → sets it → signs in with it. X receives no
 *      credential or bearer material at any stage.
 *   B  an established account — linked, or created outside an invitation —
 *      is never sent through onboarding.
 *   C  retry / idempotency across a failed link.
 *   D  login CSRF: signed in as A, a link for B does not replace A without an
 *      explicit choice; "stay" keeps A.
 *   E  forged claims: signed in as A, a link whose access token is a FORGED,
 *      expired JWT claiming `sub = A` / A's e-mail, paired with B's GENUINE
 *      refresh token. Unverified claims must not skip the question: A stays
 *      A, Auth is not even asked to refresh B's token, and only an explicit
 *      "continue" lets Auth resolve the pair — to B, visibly.
 */
import { createElement, type FunctionComponent } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import App from '../App'
import type { ApplicationBootOptions } from './useApplicationBoot'
import { setLocale } from '../i18n'
import { createCloudClient } from '../cloud/client'
import { createDataGateway, type DataGateway } from '../cloud/gateway'
import { freshOrganization, MemoryStorage, type FreshUser } from '../cloud/security/fixtures'
import {
  auth,
  invitationFragment,
  invitationLinkFor,
  invokeFunction,
  localStack,
  mailTo,
  SEED,
  signIn,
  sql,
  testHook,
  type RawResponse,
} from '../cloud/security/localStack'

if (typeof globalThis.localStorage?.getItem !== 'function') {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
}

const AppWithOptions = App as unknown as FunctionComponent<{ options: ApplicationBootOptions }>
type Org = { organizationId: string; owner: FreshUser; members: FreshUser[] }

function tab(storage: Storage): DataGateway {
  const { apiUrl, publishableKey } = localStack()
  return createDataGateway(createCloudClient({ url: apiUrl, publishableKey }, { storage }), { storage })
}

function renderApp(gateway: DataGateway) {
  return render(createElement(AppWithOptions, { options: { gateway, inspectLegacy: false, preferenceStorage: new MemoryStorage() } }))
}

function provision(token: string, organizationId: string, email: string, requestId: string = crypto.randomUUID()) {
  return invokeFunction('admin-provision-user', {
    token, body: { request_id: requestId, organization_id: organizationId, email, display_name: 'Onboarding Person', role: 'MEMBER' },
  })
}

const invitations = async (email: string) => (await mailTo(email)).filter((message) => /invited/i.test(message.Subject)).length

function expectNoCredential(response: RawResponse): void {
  if (response.status === 200) {
    expect(Object.keys(response.json as object).sort()).toEqual(['request_id', 'status'])
  }
  expect(response.text).not.toMatch(/password|access_token|refresh_token|action_link|verify\?|token=/i)
}

let x: Org
let xOwner: string

beforeAll(async () => {
  await setLocale('tr')
  x = await freshOrganization('ONB')
  xOwner = await signIn(x.owner.email, SEED.password)
})

afterEach(() => {
  cleanup()
  window.location.hash = '#/dashboard'
})

describe('A — failed-link orphan → new request → re-invitation → password setup', () => {
  it('the re-invited orphan is asked to choose a password, and then signs in with it', async () => {
    const email = `onb-${crypto.randomUUID().slice(0, 8)}@example.test`
    const received: RawResponse[] = []

    // 1–3. The invitation succeeds; the link step is forced to fail.
    const removeHook = await testHook('memberships', `new.organization_id = '${x.organizationId}'`, `raise exception 'injected link failure';`)
    const failed = await provision(xOwner, x.organizationId, email)
    await removeHook()
    received.push(failed)
    expect(failed.status).toBe(500)

    // 4. The identity stays — no membership, no profile, a purgeable orphan.
    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    expect(userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(await sql(`select count(*) from app_data.memberships where user_id = '${userId}'`)).toBe('0')
    expect(await sql(`select count(*) from app_data.profiles where user_id = '${userId}'`)).toBe('0')
    expect(await sql(`select eligible_for_purge from app_private.orphaned_auth_identities() where user_id = '${userId}'`)).toBe('t')
    expect(await invitations(email)).toBe(1)

    // 5–7. A NEW request: the still-unaccepted identity is re-invited and linked.
    const retried = await provision(xOwner, x.organizationId, email)
    received.push(retried)
    expect(retried.status).toBe(200)
    expect(await invitations(email)).toBe(2)
    expect(await sql(`select status from app_data.memberships where organization_id = '${x.organizationId}' and user_id = '${userId}'`)).toBe('ACTIVE')
    expect(await sql(`select must_change_password from app_data.profiles where user_id = '${userId}'`)).toBe('t')
    expect(await sql(`select created_here::text from app_data.provisioning_attempts where organization_id = '${x.organizationId}' and email = '${email}' and status = 'SUCCEEDED'`)).toBe('false')

    // 8–10. U opens the LATEST invitation in the application.
    window.location.hash = await invitationFragment(await invitationLinkFor(email))
    const storage = new MemoryStorage()
    renderApp(tab(storage))
    await waitFor(() => expect(screen.getByTestId('password-account').textContent).toContain(email), { timeout: 20_000 })
    expect(screen.getByRole('heading', { name: 'Parolanızı belirleyin' })).toBeTruthy()
    expect(window.location.hash).toBe('#/dashboard')
    fireEvent.change(screen.getByLabelText('Yeni parola'), { target: { value: 'onboarded-own-password-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Parolayı kaydet' }))
    await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(x.owner.organizationName), { timeout: 20_000 })

    // 11. U signs in with the password U chose.
    await expect(signIn(email, 'onboarded-own-password-1')).resolves.toMatch(/^ey/)
    expect(await sql(`select must_change_password from app_data.profiles where user_id = '${userId}'`)).toBe('f')

    // 12. Nothing X received was a credential.
    for (const response of received) expectNoCredential(response)
  }, 90_000)
})

describe('B — an established account is never sent through onboarding', () => {
  it('a confirmed account created outside an invitation, with no profile yet, is linked with no password setup, and signs straight in', async () => {
    const userId = crypto.randomUUID()
    const email = `onb-established-${userId.slice(0, 8)}@example.test`
    await sql(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data, confirmation_token, recovery_token, email_change_token_new, email_change) ` +
        `values ('00000000-0000-0000-0000-000000000000', '${userId}', 'authenticated', 'authenticated', '${email}', extensions.crypt('${SEED.password}', extensions.gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}', '', '', '', ''); ` +
        `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at) ` +
        `values ('${userId}', '${userId}', '{"sub":"${userId}","email":"${email}","email_verified":true}', 'email', now(), now(), now());`,
    )
    const mailBefore = (await mailTo(email)).length
    const response = await provision(xOwner, x.organizationId, email)
    expect(response.status).toBe(200)
    expectNoCredential(response)
    expect(await sql(`select must_change_password from app_data.profiles where user_id = '${userId}'`)).toBe('f')
    expect((await mailTo(email)).length).toBe(mailBefore)

    const storage = new MemoryStorage()
    const gateway = tab(storage)
    await gateway.signInWithPassword(email, SEED.password)
    window.location.hash = '#/dashboard'
    renderApp(gateway)
    await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(x.owner.organizationName), { timeout: 20_000 })
    expect(screen.queryByRole('heading', { name: 'Parolanızı belirleyin' })).toBeNull()
  }, 60_000)
})

describe('C — retry and idempotency across a failed link', () => {
  it('the SAME request id after a failed link converges once; repeating it is idempotent; a new id adds nothing', async () => {
    const email = `onb-retry-${crypto.randomUUID().slice(0, 8)}@example.test`
    const requestId = crypto.randomUUID()
    const removeHook = await testHook('memberships', `new.organization_id = '${x.organizationId}'`, `raise exception 'injected link failure';`)
    const failed = await provision(xOwner, x.organizationId, email, requestId)
    await removeHook()
    expect(failed.status).toBe(500)
    expect(await sql(`select status || ':' || failure_reason from app_data.provisioning_attempts where request_id = '${requestId}'`)).toBe('FAILED:LINK_FAILED')

    const again = await provision(xOwner, x.organizationId, email, requestId)
    expect(again.json).toEqual({ status: 'SUCCEEDED', request_id: requestId })
    const repeat = await provision(xOwner, x.organizationId, email, requestId)
    expect(repeat.json).toEqual({ status: 'ALREADY_SUCCEEDED', request_id: requestId })
    const fresh = await provision(xOwner, x.organizationId, email)
    expect(fresh.status).toBe(200)
    for (const response of [failed, again, repeat, fresh]) expectNoCredential(response)

    const userId = await sql(`select id::text from auth.users where email = '${email}'`)
    expect(await sql(`select count(*) from auth.users where email = '${email}'`)).toBe('1')
    expect(await sql(`select count(*) from app_data.memberships where user_id = '${userId}'`)).toBe('1')
    expect(await sql(`select count(*) from app_data.profiles where user_id = '${userId}'`)).toBe('1')
    expect(await sql(`select must_change_password from app_data.profiles where user_id = '${userId}'`)).toBe('t')
    expect(await sql(`select count(*) from app_data.provisioning_attempts where request_id = '${requestId}'`)).toBe('1')
  }, 60_000)
})

describe('D — login CSRF: a link for someone else does not silently replace the signed-in account', () => {
  it('signed in as A, a real invitation for B asks first; "stay" keeps A; continuing is explicit', async () => {
    const a = x.owner
    const bEmail = `onb-csrf-${crypto.randomUUID().slice(0, 8)}@example.test`
    expect((await provision(xOwner, x.organizationId, bEmail)).status).toBe(200)
    const fragment = await invitationFragment(await invitationLinkFor(bEmail))

    const storage = new MemoryStorage()
    const gateway = tab(storage)
    await gateway.signInWithPassword(a.email, SEED.password)

    // Stay.
    window.location.hash = fragment
    renderApp(gateway)
    const notice = await screen.findByTestId('invitation-confirmation', undefined, { timeout: 20_000 })
    expect(notice.textContent).toContain(a.email)
    expect(notice.textContent).toContain(bEmail)
    expect(window.location.hash).toBe('#/dashboard')
    fireEvent.click(screen.getByRole('button', { name: `${a.email} olarak kalmaya devam et` }))
    await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(x.owner.organizationName), { timeout: 20_000 })
    expect(await gateway.currentUserId()).toBe(a.userId)
    cleanup()

    // Continue — only by choice.
    window.location.hash = fragment
    renderApp(gateway)
    fireEvent.click(await screen.findByRole('button', { name: 'Bağlantıyla devam et' }, { timeout: 20_000 }))
    await waitFor(() => expect(screen.getByTestId('password-account').textContent).toContain(bEmail), { timeout: 20_000 })
    expect(await gateway.currentUserId()).not.toBe(a.userId)
  }, 90_000)
})

/** An access-token-shaped JWT nobody signed: any claims, a meaningless signature. */
function forgedAccessToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.${Buffer.from('not-a-signature').toString('base64url')}`
}

/** A genuine password session for `email`, straight from Auth. */
async function genuineSession(email: string): Promise<{ refreshToken: string; userId: string }> {
  const response = await auth('token?grant_type=password', { body: { email, password: SEED.password } })
  const session = response.json as { refresh_token?: string; user?: { id?: string } }
  if (response.status !== 200 || !session.refresh_token || !session.user?.id) throw new Error(`no session for ${email}`)
  return { refreshToken: session.refresh_token, userId: session.user.id }
}

/** Whether Auth has ever been asked to refresh this refresh token (rotation leaves a child row). */
const rotations = (refreshToken: string) => sql(`select count(*) from auth.refresh_tokens where parent = '${refreshToken}'`)

describe('E — forged link claims never authorise a silent session swap', () => {
  let y: Org
  beforeAll(async () => {
    y = await freshOrganization('FORGE')
  })

  for (const type of ['invite', 'recovery'] as const) {
    it(`${type}: signed in as A, a forged sub=A token + B's genuine refresh token asks first; "stay" keeps A; only "continue" moves to B`, async () => {
      const a = x.owner
      const b = y.owner
      const genuineB = await genuineSession(b.email)
      expect(genuineB.userId).toBe(b.userId)
      const now = Math.floor(Date.now() / 1000)
      const forged = forgedAccessToken({
        sub: a.userId, email: a.email, aud: 'authenticated', role: 'authenticated', iat: now - 7200, exp: now - 3600,
      })
      const fragment = `#access_token=${forged}&refresh_token=${genuineB.refreshToken}&expires_in=3600&token_type=bearer&type=${type}`

      const storage = new MemoryStorage()
      const gateway = tab(storage)
      await gateway.signInWithPassword(a.email, SEED.password)
      expect(await gateway.currentUserId()).toBe(a.userId)

      // BEFORE any choice: the question is asked, A is still A, no business
      // screen is mounted, and Auth has not been asked about B's token at all.
      window.location.hash = fragment
      renderApp(gateway)
      const notice = await screen.findByTestId('invitation-confirmation', undefined, { timeout: 20_000 })
      expect(notice.textContent).toContain(a.email)
      expect(window.location.hash).toBe('#/dashboard')
      expect(screen.queryByTestId('shell-organization')).toBeNull()
      expect(await gateway.currentUserId()).toBe(a.userId)
      expect(await rotations(genuineB.refreshToken)).toBe('0')

      // Stay: A's session survives; B is not adopted.
      fireEvent.click(screen.getByRole('button', { name: `${a.email} olarak kalmaya devam et` }))
      await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(a.organizationName), { timeout: 20_000 })
      expect(await gateway.currentUserId()).toBe(a.userId)
      expect(await gateway.currentUserEmail()).toBe(a.email)
      expect(await rotations(genuineB.refreshToken)).toBe('0')
      cleanup()

      // The same link again, and this time an explicit "continue": only now
      // does Auth resolve the pair — to B, whatever the forged token said —
      // and the application visibly becomes B.
      window.location.hash = fragment
      renderApp(gateway)
      await screen.findByTestId('invitation-confirmation', undefined, { timeout: 20_000 })
      expect(await gateway.currentUserId()).toBe(a.userId)
      fireEvent.click(screen.getByRole('button', { name: 'Bağlantıyla devam et' }))
      await waitFor(() => expect(screen.getByTestId('shell-organization').textContent).toBe(b.organizationName), { timeout: 20_000 })
      expect(await gateway.currentUserId()).toBe(b.userId)
      expect(await gateway.currentUserEmail()).toBe(b.email)
      expect(await rotations(genuineB.refreshToken)).toBe('1')
    }, 90_000)
  }
})
