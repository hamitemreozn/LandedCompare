/**
 * A-L6 / §19 — the privileged half of the user lifecycle never enters the
 * browser path.
 *
 * Inviting a new Auth user and resolving an existing identity needs the Auth
 * Admin API and the secret key; that lives in `supabase/functions` and nowhere
 * else. Re-credentialling is deliberately absent, and purging an orphaned
 * identity is an operator act on a superuser connection. This scans every
 * module the application bundle can include — all of `src/` except tests and
 * test support — and fails if any of them names one of those capabilities.
 * The build's own bundle scan (`scripts/assert-no-secret-key.mjs`) covers key
 * MATERIAL; this covers the CALLS.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob<string>(['/src/**/*.ts', '/src/**/*.tsx'], { query: '?raw', import: 'default', eager: true })

const edgeFunctions = import.meta.glob<string>('/supabase/functions/**/*.ts', { query: '?raw', import: 'default', eager: true })

const runtimeSources = Object.entries(sources).filter(([path]) =>
  !/\.test\.tsx?$/.test(path) &&
  !/\.testSupport\.ts$/.test(path) &&
  !path.startsWith('/src/test/') &&
  !path.startsWith('/src/cloud/security/'),
)

const FORBIDDEN: readonly [RegExp, string][] = [
  [/auth\.admin\.(createUser|deleteUser|updateUserById|listUsers|inviteUserByEmail|generateLink)\b/, 'Auth Admin API call'],
  [/SUPABASE_SECRET_KEYS|SUPABASE_SERVICE_ROLE_KEY/, 'server credential variable'],
  [/purge_orphaned_auth_identity|orphaned_auth_identities/, 'operator-only identity function'],
  [/\bsb_secret_[A-Za-z0-9_-]{8,}/, 'secret key material'],
]

describe('the browser path holds no privileged user-lifecycle capability', () => {
  it('scans a meaningful set of runtime modules', () => {
    expect(runtimeSources.length).toBeGreaterThan(50)
    expect(runtimeSources.some(([path]) => path === '/src/cloud/gateway.ts')).toBe(true)
    expect(runtimeSources.some(([path]) => path === '/src/features/organization/OrganizationScreen.tsx')).toBe(true)
  })

  it('no runtime module calls the Auth Admin API, names a server credential, or reaches an operator function', () => {
    const hits: string[] = []
    for (const [path, text] of runtimeSources) {
      for (const [pattern, what] of FORBIDDEN) {
        if (pattern.test(text)) hits.push(`${path}: ${what}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('user administration from the browser goes only through admin-provision-user and the typed RPCs — no reset path', () => {
    const gateway = sources['/src/cloud/gateway.ts']
    expect(gateway).toContain('invokeFunction<{')
    expect(gateway).toMatch(/'admin-provision-user'/)
    expect(gateway).not.toMatch(/admin-reset-password|resetMemberPassword|password_reset/)
    expect(gateway).not.toMatch(/admin-delete-user|deleteUser/)
  })
})

describe('the Edge Functions never delete or re-credential an existing Auth identity (P12-B1, P12-H2)', () => {
  it('scans the deployed function sources', () => {
    expect(Object.keys(edgeFunctions)).toContain('/supabase/functions/admin-provision-user/index.ts')
    expect(Object.keys(edgeFunctions).some((path) => path.includes('admin-reset-password'))).toBe(false)
  })

  it('no function deletes a user, and none changes the password of an existing one', () => {
    const hits: string[] = []
    for (const [path, text] of Object.entries(edgeFunctions)) {
      if (/auth\.admin\.deleteUser\b/.test(text)) hits.push(`${path}: deleteUser`)
      if (/auth\.admin\.updateUserById\b/.test(text)) hits.push(`${path}: updateUserById`)
      // No administrator-known credential can be minted: no account created
      // with a password, no link generated to hand to anybody, no password
      // generator. A new person is invited by Auth, to their own address.
      if (/auth\.admin\.createUser\b/.test(text)) hits.push(`${path}: createUser`)
      if (/auth\.admin\.generateLink\b/.test(text)) hits.push(`${path}: generateLink`)
      if (/generateTemporaryPassword|temporary_password/.test(text)) hits.push(`${path}: temporary password`)
    }
    expect(hits).toEqual([])
  })

  it('new people are invited, and the invitation redirect is never taken from a request', () => {
    const provision = edgeFunctions['/supabase/functions/admin-provision-user/index.ts']
    expect(provision).toMatch(/auth\.admin\.inviteUserByEmail\(/)
    expect(provision).not.toMatch(/body\.redirect|redirect_to|redirectTo:\s*body/)
    expect(edgeFunctions['/supabase/functions/_shared/adminContext.ts']).toMatch(/LANDEDCOMPARE_INVITE_REDIRECT_URL/)
  })
})
