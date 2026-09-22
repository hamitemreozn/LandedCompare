/**
 * Unit tests for the Edge Functions' server-credential resolver.
 *
 * The module under test lives in `supabase/functions/_shared/` because that is
 * where the Deno bundler has to find it, but it takes a plain environment
 * record and touches no Deno global — which is precisely so it can be tested
 * here, with `tsc` checking it and vitest running it, and with no real
 * credential anywhere near a fixture.
 *
 * Every value below is synthetic. `sb_secret_` is a public format marker, not a
 * key; the build-time bundle scan looks for it in `dist/`, which no test file
 * reaches.
 */

import { describe, expect, it } from 'vitest'
import {
  ServerCredentialError,
  resolveServerSecretKey,
} from '../../supabase/functions/_shared/secretKey'

const CURRENT = 'sb_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const LEGACY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig'

describe('resolveServerSecretKey', () => {
  it('reads the shape the pinned runtime actually injects', () => {
    // Measured, not assumed: SUPABASE_SECRET_KEYS is a JSON object keyed by
    // name, and the value is a bare sb_secret_ string.
    expect(
      resolveServerSecretKey({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: CURRENT }) }),
    ).toEqual({ key: CURRENT, source: 'SUPABASE_SECRET_KEYS' })
  })

  it('prefers the current key over the deprecated one when both are present', () => {
    // Both ARE present in the runtime today. Picking the legacy one would work
    // right up until Supabase finishes retiring it at the end of 2026.
    expect(
      resolveServerSecretKey({
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: CURRENT }),
        SUPABASE_SERVICE_ROLE_KEY: LEGACY,
      }).source,
    ).toBe('SUPABASE_SECRET_KEYS')
  })

  it('falls back to the legacy key on a project that still uses it', () => {
    // A project not yet migrated to the new key pair must still run. Refusing
    // to start on one would be choosing purity over the pilot working.
    expect(resolveServerSecretKey({ SUPABASE_SERVICE_ROLE_KEY: LEGACY })).toEqual({
      key: LEGACY,
      source: 'SUPABASE_SERVICE_ROLE_KEY',
    })
  })

  it('survives the envelope changing shape', () => {
    // The variable is PLURAL because Supabase supports several active keys at
    // once, which is what makes rotation possible without downtime. An
    // "observed shape of a platform-managed envelope" is exactly the kind of
    // thing that grows a second form later, so every reasonable one resolves.
    const shapes: Record<string, string> = {
      'JSON array of keys': JSON.stringify([CURRENT]),
      'JSON array of records': JSON.stringify([{ name: 'default', key: CURRENT }]),
      'JSON object of records': JSON.stringify({ default: { key: CURRENT } }),
      'bare unwrapped string': CURRENT,
      'bare string with whitespace': `  ${CURRENT}\n`,
    }

    for (const [shape, value] of Object.entries(shapes)) {
      expect(resolveServerSecretKey({ SUPABASE_SECRET_KEYS: value }).key, shape).toBe(CURRENT)
    }
  })

  it('picks the first key when rotation leaves two active', () => {
    const rotating = JSON.stringify({ default: CURRENT, previous: 'sb_secret_BBBBBBBBBBBB' })
    expect(resolveServerSecretKey({ SUPABASE_SECRET_KEYS: rotating }).key).toBe(CURRENT)
  })

  it('ignores an envelope it cannot read and takes the legacy key instead', () => {
    // Failing over is right here: an unparseable envelope plus a working legacy
    // key is a project that can still serve, and refusing would be an outage
    // chosen on principle.
    expect(
      resolveServerSecretKey({
        SUPABASE_SECRET_KEYS: 'not json at all',
        SUPABASE_SERVICE_ROLE_KEY: LEGACY,
      }).source,
    ).toBe('SUPABASE_SERVICE_ROLE_KEY')
  })

  it('never accepts a publishable key as a server credential', () => {
    // An Edge Function running with anon privileges fails on its first Auth
    // Admin call with a message about permissions, and somebody spends an
    // afternoon reading RLS policies. It fails here instead, immediately.
    expect(() =>
      resolveServerSecretKey({
        SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_publishable_AAAAAAAAAAAA' }),
      }),
    ).toThrow(ServerCredentialError)
  })

  it('fails closed, and names what was missing', () => {
    expect(() => resolveServerSecretKey({})).toThrow(ServerCredentialError)
    expect(() => resolveServerSecretKey({})).toThrow(/SUPABASE_SECRET_KEYS/)
    expect(() => resolveServerSecretKey({})).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)

    // Empty is the same as absent. A blank variable is the state a half-written
    // deployment script leaves behind, and treating it as a value would produce
    // a client authorised as nobody.
    expect(() =>
      resolveServerSecretKey({ SUPABASE_SECRET_KEYS: '   ', SUPABASE_SERVICE_ROLE_KEY: '' }),
    ).toThrow(ServerCredentialError)
  })

  it('does not depend on a project-specific secret existing', () => {
    // The whole point of the correction: LANDEDCOMPARE_SECRET_KEY is gone, and
    // setting one must not be required for the functions to work.
    expect(
      resolveServerSecretKey({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: CURRENT }) }).key,
    ).toBe(CURRENT)
  })
})
