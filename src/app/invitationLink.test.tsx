/**
 * Accepting an invitation or recovery link: the URL is cleared at once, only
 * the exact `invite` / `recovery` shape becomes a session, the person sees
 * whose account it is and chooses their own password — and a link NEVER
 * silently replaces an account already signed in on this device, whatever the
 * link claims (login CSRF). Claims decoded from the link are unverified
 * display hints. If Auth cannot say whether a session exists, the link is held
 * and not used. The real Auth round trip, including a forged-claim link, is
 * proved in `src/app/invitationOnboarding.security.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { setLocale } from '../i18n'
import { CloudError } from '../cloud/errors'
import { createMemoryCloudGateway, TEST_USER_ID, type MemoryCloud } from '../test/memoryCloud'
import { takeInvitationTokens } from './invitationLink'

const OTHER_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000099'

/** An unsigned JWT carrying the claims the link parser reads for display. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}

function fakeLocation(hash: string, search = '?x=1') {
  const replaced: string[] = []
  return {
    location: { hash, pathname: '/app/', search },
    history: { replaceState: (_data: unknown, _unused: string, url?: string) => { replaced.push(url ?? '') } },
    replaced,
  }
}

const JWT = fakeJwt({ sub: OTHER_USER, email: 'new@example.test' })

describe('takeInvitationTokens', () => {
  it('returns an invitation\'s tokens and the UNVERIFIED e-mail hint, and removes the fragment from the address', () => {
    const { location, history, replaced } = fakeLocation(`#access_token=${JWT}&refresh_token=RT&expires_in=3600&expires_at=1999999999&token_type=bearer&type=invite`)
    expect(takeInvitationTokens(location, history)).toEqual({
      accessToken: JWT, refreshToken: 'RT', type: 'invite', unverifiedEmailHint: 'new@example.test',
    })
    expect(replaced).toEqual(['/app/?x=1#/dashboard'])
  })

  it('exposes no subject claim at all — there is nothing to compare with the signed-in account', () => {
    const { location, history } = fakeLocation(`#access_token=${JWT}&refresh_token=RT&type=invite`)
    const tokens = takeInvitationTokens(location, history)
    expect(Object.keys(tokens ?? {}).sort()).toEqual(['accessToken', 'refreshToken', 'type', 'unverifiedEmailHint'])
    expect(JSON.stringify(tokens)).not.toContain(`"${OTHER_USER}"`)
  })

  it('accepts the exact redirect Auth produces, including its empty `sb` marker', () => {
    const { location, history } = fakeLocation(`#access_token=${JWT}&expires_at=1999999999&expires_in=3600&refresh_token=RT&sb=&token_type=bearer&type=invite`)
    expect(takeInvitationTokens(location, history)).toMatchObject({ accessToken: JWT, refreshToken: 'RT', type: 'invite' })
  })

  it('accepts an operator-initiated recovery link the same way', () => {
    const { location, history } = fakeLocation(`#access_token=${JWT}&refresh_token=RT&type=recovery`)
    expect(takeInvitationTokens(location, history)).toMatchObject({ accessToken: JWT, refreshToken: 'RT', type: 'recovery' })
  })

  it('removes, but does not accept, any other Auth fragment — other flows, errors, partial, malformed or duplicated material', () => {
    for (const hash of [
      `#access_token=${JWT}&refresh_token=RT&type=magiclink`,
      `#access_token=${JWT}&refresh_token=RT&type=signup`,
      `#access_token=${JWT}&type=invite`,
      `#refresh_token=RT&type=invite`,
      `#access_token=${JWT}&refresh_token=RT`,
      `#access_token=not-a-jwt&refresh_token=RT&type=invite`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&token_type=mac`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&provider_token=PT`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&provider_refresh_token=PRT`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&code=CODE`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&token_hash=TH`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&access_token=${JWT}`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&type=recovery`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&unexpected=1`,
      `#access_token=${JWT}&refresh_token=RT&type=invite&sb=smuggled`,
      '#provider_token=PT&provider_refresh_token=PRT',
      '#code=CODE',
      '#token_hash=TH&type=invite',
      '#token=OTP&type=recovery',
      '#error=access_denied&error_code=otp_expired&error_description=expired',
      '#error_description=Email+link+is+invalid+or+has+expired',
      '#expires_in=3600&token_type=bearer',
    ]) {
      const { location, history, replaced } = fakeLocation(hash)
      expect(takeInvitationTokens(location, history), hash).toBeUndefined()
      expect(replaced, hash).toEqual(['/app/?x=1#/dashboard'])
    }
  })

  it('strips Auth material carried in the QUERY and never accepts it', () => {
    const { location, history, replaced } = fakeLocation('#/products', '?code=abc&access_token=AT&refresh_token=RT&type=invite&keep=1')
    expect(takeInvitationTokens(location, history)).toBeUndefined()
    expect(replaced).toEqual(['/app/?type=invite&keep=1#/products'])
  })

  it('leaves ordinary application routes alone, including ones that happen to look like parameters', () => {
    for (const hash of ['#/products', '#/organization', '#/products?code=K-1', '', '#', '#type=invite']) {
      const { location, history, replaced } = fakeLocation(hash)
      expect(takeInvitationTokens(location, history), hash).toBeUndefined()
      expect(replaced, hash).toEqual([])
    }
  })

  it('never throws on a JWT-shaped token whose payload is not JSON — it simply offers no hint', () => {
    const { location, history } = fakeLocation('#access_token=aaa.bbb.ccc&refresh_token=RT&type=invite')
    const tokens = takeInvitationTokens(location, history)
    expect(tokens).toMatchObject({ accessToken: 'aaa.bbb.ccc', type: 'invite' })
    expect(tokens).not.toHaveProperty('unverifiedEmailHint')
  })
})

describe('opening an invitation link', () => {
  beforeEach(async () => {
    await setLocale('tr')
    localStorage.clear()
  })
  afterEach(() => {
    window.location.hash = '#/dashboard'
  })

  it('on a device with nobody signed in: adopts the session, clears the URL, names the account and asks for the person\'s own password', async () => {
    const gateway = createMemoryCloudGateway({ signedIn: false })
    const token = fakeJwt({ sub: TEST_USER_ID, email: 'owner@example.test' })
    window.location.hash = `#access_token=${token}&refresh_token=INVITE-RT&expires_in=3600&token_type=bearer&type=invite`
    render(<App options={{ gateway, inspectLegacy: false }} />)

    // The adoption's own sign-in event restarts the boot once; wait for the
    // settled screen rather than the first element that matched.
    await waitFor(() => expect(screen.getByTestId('password-account')).toHaveTextContent('Hesap: owner@example.test'))
    expect(screen.getByRole('heading', { name: 'Parolanızı belirleyin' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bu benim hesabım değil — oturumu kapat' })).toBeInTheDocument()
    expect(gateway.adoptedInvitations).toEqual([token])
    expect(window.location.hash).toBe('#/dashboard')
    expect(window.location.href).not.toContain('INVITE-')

    await userEvent.type(screen.getByLabelText('Yeni parola'), 'my-own-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Parolayı kaydet' }))
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Ana menü' })).toBeInTheDocument())
  })

  it('"not my account" signs the device out instead of setting a password', async () => {
    const gateway = createMemoryCloudGateway({ signedIn: false })
    window.location.hash = `#access_token=${fakeJwt({ sub: TEST_USER_ID, email: 'owner@example.test' })}&refresh_token=RT&type=invite`
    render(<App options={{ gateway, inspectLegacy: false }} />)
    await waitFor(() => expect(screen.getByTestId('password-account')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: 'Bu benim hesabım değil — oturumu kapat' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument())
  })

  it('a malformed link leaves the person at the sign-in screen, with the fragment removed and nothing adopted', async () => {
    const gateway = createMemoryCloudGateway({ signedIn: false })
    window.location.hash = '#access_token=expired&refresh_token=RT&type=invite'
    render(<App options={{ gateway, inspectLegacy: false }} />)
    expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument()
    expect(window.location.hash).toBe('#/dashboard')
    expect(gateway.adoptedInvitations).toEqual([])
  })

  it('a magic-link fragment is never adopted', async () => {
    const gateway = createMemoryCloudGateway({ signedIn: false })
    window.location.hash = '#access_token=AT&refresh_token=RT&type=magiclink'
    render(<App options={{ gateway, inspectLegacy: false }} />)
    expect(await screen.findByRole('heading', { name: 'Giriş yap' })).toBeInTheDocument()
    expect(gateway.adoptedInvitations).toEqual([])
  })
})

/** A memory gateway whose current-session lookup fails the first `times` calls. */
function failingSessionRead(gateway: MemoryCloud, times: number): MemoryCloud {
  let failures = 0
  return {
    ...gateway,
    async currentUserId() {
      if (failures < times) {
        failures += 1
        throw new CloudError('SERVER_UNAVAILABLE', 'Auth did not answer')
      }
      return gateway.currentUserId()
    },
  }
}

describe('login CSRF — any link while someone is signed in', () => {
  beforeEach(async () => {
    await setLocale('tr')
    localStorage.clear()
  })
  afterEach(() => {
    window.location.hash = '#/dashboard'
  })

  for (const type of ['invite', 'recovery'] as const) {
    it(`${type}: a link naming ANOTHER account — nothing is replaced until the person decides; "stay" keeps the current account`, async () => {
      const gateway = createMemoryCloudGateway()
      window.location.hash = `#access_token=${fakeJwt({ sub: OTHER_USER, email: 'attacker@example.test' })}&refresh_token=RT&type=${type}`
      render(<App options={{ gateway, inspectLegacy: false }} />)

      const notice = await screen.findByTestId('invitation-confirmation')
      expect(notice).toHaveTextContent('owner@example.test')
      expect(notice).toHaveTextContent('attacker@example.test')
      expect(gateway.adoptedInvitations).toEqual([])
      expect(window.location.hash).toBe('#/dashboard')
      expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull()

      await userEvent.click(screen.getByRole('button', { name: 'owner@example.test olarak kalmaya devam et' }))
      await waitFor(() => expect(screen.getByRole('navigation', { name: 'Ana menü' })).toBeInTheDocument())
      expect(gateway.adoptedInvitations).toEqual([])
    })

    it(`${type}: a link whose UNVERIFIED claims name the signed-in account itself still asks first — claims never skip the question`, async () => {
      const gateway = createMemoryCloudGateway()
      // What a forged token would say: sub and email of the signed-in account.
      window.location.hash = `#access_token=${fakeJwt({ sub: TEST_USER_ID, email: 'owner@example.test' })}&refresh_token=SOMEONE-ELSES-RT&type=${type}`
      render(<App options={{ gateway, inspectLegacy: false }} />)

      expect(await screen.findByTestId('invitation-confirmation')).toHaveTextContent('owner@example.test')
      expect(gateway.adoptedInvitations).toEqual([])
      expect(screen.queryByRole('navigation', { name: 'Ana menü' })).toBeNull()

      await userEvent.click(screen.getByRole('button', { name: 'owner@example.test olarak kalmaya devam et' }))
      await waitFor(() => expect(screen.getByRole('navigation', { name: 'Ana menü' })).toBeInTheDocument())
      expect(gateway.adoptedInvitations).toEqual([])
    })
  }

  it('continuing is an explicit choice, and only then is the link adopted', async () => {
    const gateway = createMemoryCloudGateway()
    const token = fakeJwt({ sub: OTHER_USER, email: 'colleague@example.test' })
    window.location.hash = `#access_token=${token}&refresh_token=RT&type=invite`
    render(<App options={{ gateway, inspectLegacy: false }} />)
    await screen.findByTestId('invitation-confirmation')
    expect(gateway.adoptedInvitations).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Bağlantıyla devam et' }))
    await waitFor(() => expect(gateway.adoptedInvitations).toEqual([token]))
  })
})

describe('the current session cannot be read — fail closed', () => {
  beforeEach(async () => {
    await setLocale('tr')
    localStorage.clear()
  })
  afterEach(() => {
    window.location.hash = '#/dashboard'
  })

  for (const type of ['invite', 'recovery'] as const) {
    it(`${type}: the link is not used, the device is not assumed to be anonymous, and a retry/ignore state is shown`, async () => {
      const memory = createMemoryCloudGateway()
      const gateway = failingSessionRead(memory, Number.POSITIVE_INFINITY)
      const token = fakeJwt({ sub: OTHER_USER, email: 'someone@example.test' })
      window.location.hash = `#access_token=${token}&refresh_token=RT&type=${type}`
      render(<App options={{ gateway, inspectLegacy: false }} />)

      expect(await screen.findByTestId('invitation-check-failed')).toBeInTheDocument()
      expect(screen.getByText('Hata kodu: SERVER_UNAVAILABLE', { exact: false })).toBeInTheDocument()
      expect(memory.adoptedInvitations).toEqual([])
      expect(window.location.hash).toBe('#/dashboard')
      expect(screen.queryByTestId('invitation-confirmation')).toBeNull()
      expect(screen.queryByRole('heading', { name: 'Parolanızı belirleyin' })).toBeNull()

      // Retrying while Auth still cannot answer changes nothing.
      await userEvent.click(screen.getByRole('button', { name: 'Yeniden Dene' }))
      expect(await screen.findByTestId('invitation-check-failed')).toBeInTheDocument()
      expect(memory.adoptedInvitations).toEqual([])
    })
  }

  it('once Auth answers, the ordinary rule applies: a signed-in device is asked, never silently replaced', async () => {
    const memory = createMemoryCloudGateway()
    const gateway = failingSessionRead(memory, 1)
    window.location.hash = `#access_token=${fakeJwt({ sub: TEST_USER_ID, email: 'owner@example.test' })}&refresh_token=RT&type=recovery`
    render(<App options={{ gateway, inspectLegacy: false }} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Yeniden Dene' }))
    expect(await screen.findByTestId('invitation-confirmation')).toBeInTheDocument()
    expect(memory.adoptedInvitations).toEqual([])
  })

  it('"ignore the link" drops it; the existing session is untouched and the application boots as before', async () => {
    const memory = createMemoryCloudGateway()
    const gateway = failingSessionRead(memory, 1)
    window.location.hash = `#access_token=${fakeJwt({ sub: OTHER_USER })}&refresh_token=RT&type=invite`
    render(<App options={{ gateway, inspectLegacy: false }} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Bağlantıyı yok say' }))
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Ana menü' })).toBeInTheDocument())
    expect(memory.adoptedInvitations).toEqual([])
  })
})
