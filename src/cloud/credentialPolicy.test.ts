/**
 * Audit A, A-M4 — the credential guards must DECODE a JWT-form key.
 *
 * A legacy Supabase key is a JWT whose role claim is base64url-encoded, so the
 * text `service_role` never appears inside a real service-role key. Every
 * guard — the runtime configuration check, the production build scanner and
 * the hosted posture script — shares `credentialPolicy.mjs`, and each is
 * exercised here against synthetic credentials. No real key material is used,
 * and no assertion prints a credential value.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyCredential,
  findPrivilegedCredentials,
  isClientCredential,
} from './credentialPolicy.mjs'

function syntheticJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.synthetic-signature`
}

const LEGACY_ANON = syntheticJwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'anon' })
const LEGACY_SERVICE_ROLE = syntheticJwt({ iss: 'supabase', ref: 'abcdefghijklmnopqrst', role: 'service_role' })
const PUBLISHABLE = 'sb_publishable_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SECRET = 'sb_secret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const ROOT = process.cwd()

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function bundleContaining(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'lc-bundle-'))
  temporary.push(directory)
  mkdirSync(join(directory, 'assets'))
  writeFileSync(join(directory, 'assets', 'index.js'), `const config = { key: "${text}" }; export default config`)
  return directory
}

function runScanner(directory: string): { status: number; output: string } {
  try {
    const output = execFileSync('node', [join(ROOT, 'scripts/assert-no-secret-key.mjs'), directory], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, output }
  } catch (cause) {
    const failure = cause as { status: number; stdout: string; stderr: string }
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` }
  }
}

describe('classifyCredential', () => {
  it('reads the role from the decoded payload, not from the encoded text', () => {
    expect(LEGACY_SERVICE_ROLE).not.toContain('service_role')
    expect(classifyCredential(LEGACY_SERVICE_ROLE)).toEqual({ kind: 'PRIVILEGED_JWT', role: 'service_role' })
    expect(classifyCredential(LEGACY_ANON)).toEqual({ kind: 'LEGACY_ANON_JWT', role: 'anon' })
    expect(classifyCredential(syntheticJwt({ role: 'supabase_admin' })).kind).toBe('PRIVILEGED_JWT')
    expect(classifyCredential(syntheticJwt({ role: 'authenticated' })).kind).toBe('PRIVILEGED_JWT')
    expect(classifyCredential(PUBLISHABLE).kind).toBe('PUBLISHABLE')
    expect(classifyCredential(SECRET).kind).toBe('SECRET')
    expect(classifyCredential('eyJx.eyJ-not-json.sig').kind).toBe('MALFORMED_JWT')
    expect(classifyCredential('anything').kind).toBe('UNRECOGNIZED')
  })

  it('permits a legacy anon JWT only when a caller asks for it', () => {
    expect(isClientCredential(PUBLISHABLE)).toBe(true)
    expect(isClientCredential(LEGACY_ANON)).toBe(false)
    expect(isClientCredential(LEGACY_ANON, { allowLegacyAnon: true })).toBe(true)
    expect(isClientCredential(LEGACY_SERVICE_ROLE, { allowLegacyAnon: true })).toBe(false)
    expect(isClientCredential(SECRET, { allowLegacyAnon: true })).toBe(false)
  })

  it('finds a privileged key embedded in text and reports its kind, never its value', () => {
    const hits = findPrivilegedCredentials(`a ${LEGACY_SERVICE_ROLE} b ${LEGACY_ANON} c ${SECRET}`)
    expect(hits).toEqual([{ kind: 'SECRET' }, { kind: 'PRIVILEGED_JWT', role: 'service_role' }])
    expect(JSON.stringify(hits)).not.toContain(LEGACY_SERVICE_ROLE)
  })
})

describe('the production build scanner (scripts/assert-no-secret-key.mjs)', () => {
  it('REFUSES a legacy service_role JWT in the bundle without printing it', () => {
    const result = runScanner(bundleContaining(LEGACY_SERVICE_ROLE))
    expect(result.status).toBe(1)
    expect(result.output).toContain('decoded role is "service_role"')
    expect(result.output).not.toContain(LEGACY_SERVICE_ROLE)
  })

  it('REFUSES an sb_secret_ key', () => {
    const result = runScanner(bundleContaining(SECRET))
    expect(result.status).toBe(1)
    expect(result.output).not.toContain(SECRET)
  })

  it('permits a publishable key and a legacy anon JWT, which are public by design', () => {
    expect(runScanner(bundleContaining(PUBLISHABLE)).status).toBe(0)
    expect(runScanner(bundleContaining(LEGACY_ANON)).status).toBe(0)
  })
})

describe('the hosted posture script (scripts/verify-hosted.mjs)', () => {
  function runVerify(key: string): { status: number; output: string } {
    try {
      const output = execFileSync('node', [join(ROOT, 'scripts/verify-hosted.mjs')], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // A closed loopback port: a refused key must stop the script before any
        // request is made, so nothing ever reaches the network.
        env: { ...process.env, SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_PUBLISHABLE_KEY: key },
        timeout: 20_000,
      })
      return { status: 0, output }
    } catch (cause) {
      const failure = cause as { status: number; stdout: string; stderr: string }
      return { status: failure.status, output: `${failure.stdout}${failure.stderr}` }
    }
  }

  it('refuses to run with a legacy service_role JWT or a secret key, naming only the kind', () => {
    const privileged = runVerify(LEGACY_SERVICE_ROLE)
    expect(privileged.status).toBe(2)
    expect(privileged.output).toContain('PRIVILEGED_JWT')
    expect(privileged.output).not.toContain(LEGACY_SERVICE_ROLE)

    const secret = runVerify(SECRET)
    expect(secret.status).toBe(2)
    expect(secret.output).not.toContain(SECRET)
  })
})
