import { describe, expect, it } from 'vitest'
import {
  CloudConfigError,
  containsForbiddenKeyMaterial,
  readCloudConfig,
  type CloudEnvironment,
} from './config'

// Every key in this file is synthetic. Real key material — even the local
// stack's, which is public, identical on every machine and opens a throwaway
// database on 127.0.0.1 — does not belong in a committed fixture: it trips
// secret scanners, and it sets the precedent of pasting a key into a test.
const VALID: CloudEnvironment = {
  VITE_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
}

function problemOf(environment: CloudEnvironment): string {
  try {
    readCloudConfig(environment)
  } catch (cause) {
    if (cause instanceof CloudConfigError) {
      return cause.problem
    }
  }
  return 'NO_ERROR'
}

describe('readCloudConfig', () => {
  it('accepts a project URL and a publishable key', () => {
    expect(readCloudConfig(VALID)).toEqual({
      url: VALID.VITE_SUPABASE_URL,
      publishableKey: VALID.VITE_SUPABASE_PUBLISHABLE_KEY,
    })
  })

  it('refuses a secret key where a publishable one belongs', () => {
    // The single most dangerous configuration mistake available, and the reason
    // it has to fail loudly is that it does not fail quietly: a bundle carrying
    // a secret key WORKS. Every screen loads, every save succeeds — and every
    // row-level policy in the database is bypassed for anyone who opens the
    // network tab.
    expect(
      problemOf({ ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    ).toBe('KEY_IS_SECRET')
  })

  it('refuses a legacy service-role key too', () => {
    // Supabase is deprecating the legacy anon/service_role JWT pair, but a
    // legacy secret in a bundle is exactly as catastrophic as a new one. A
    // check that only knew the new prefix would wave the old one through.
    const legacyServiceRole =
      'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJzZXJ2aWNlX3JvbGUifQ.signature'
    expect(containsForbiddenKeyMaterial(legacyServiceRole)).toBe(false)
    // …the JWT body is base64, so the marker is not visible in the token
    // itself. What IS visible — and what the build scan and CI configuration
    // actually catch — is the plain string appearing beside it.
    expect(problemOf({ ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: 'service_role-key' })).toBe(
      'KEY_IS_SECRET',
    )
  })

  it('names a missing URL and a missing key separately', () => {
    expect(problemOf({ ...VALID, VITE_SUPABASE_URL: '' })).toBe('URL_MISSING')
    expect(problemOf({ ...VALID, VITE_SUPABASE_PUBLISHABLE_KEY: '   ' })).toBe('KEY_MISSING')
  })

  it('refuses plain http except on the loopback development stack', () => {
    // A session token travelling in clear text is a stolen session, which is
    // the one threat row-level security cannot mitigate.
    expect(problemOf({ ...VALID, VITE_SUPABASE_URL: 'http://example.com' })).toBe('URL_INVALID')
    expect(problemOf({ ...VALID, VITE_SUPABASE_URL: 'http://127.0.0.1:54321' })).toBe('NO_ERROR')
    expect(problemOf({ ...VALID, VITE_SUPABASE_URL: 'http://localhost:54321' })).toBe('NO_ERROR')
  })

  it('refuses something that is not a URL at all', () => {
    expect(problemOf({ ...VALID, VITE_SUPABASE_URL: 'abcdefghijklmnop.supabase.co' })).toBe(
      'URL_INVALID',
    )
  })

  it('refuses rather than returning a partial configuration', () => {
    // A client built from a missing URL produces network errors that look
    // exactly like an unavailable server — and telling an administrator "the
    // server is down" when the truth is "this build was never configured"
    // sends them to restart a project that was never the problem.
    expect(() => readCloudConfig({})).toThrow(CloudConfigError)
  })
})
