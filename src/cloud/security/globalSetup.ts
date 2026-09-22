/**
 * Brings the local Supabase stack to a known state before the behavioural
 * security suite runs, and refuses clearly if it cannot.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §20.
 *
 * Two things happen here and both are preconditions rather than conveniences:
 *
 * 1. **`supabase db reset`** — which replays EVERY migration from an empty
 *    database and then applies the seed. That is the proof §20 rule 1 demands
 *    before anything reaches the hosted project, and running it as part of the
 *    suite means the migration chain is exercised from nothing on every run
 *    rather than on the days somebody remembers.
 *
 * 2. **Resolving the stack's own URL and keys** from `supabase status`, instead
 *    of hard-coding them. They are not secrets — they are identical on every
 *    machine and published in Supabase's documentation — but a CLI release that
 *    changes them should make the suite adapt, not fail with a confusing 401.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TestProject } from 'vitest/node'

const run = promisify(execFile)

declare module 'vitest' {
  interface ProvidedContext {
    localStack: {
      apiUrl: string
      publishableKey: string
      secretKey: string
    }
  }
}

interface SupabaseStatus {
  API_URL?: string
  PUBLISHABLE_KEY?: string
  ANON_KEY?: string
  SECRET_KEY?: string
  SERVICE_ROLE_KEY?: string
}

export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  try {
    await run('docker', ['info'], { timeout: 30_000 })
  } catch {
    throw new Error(
      [
        '',
        'The behavioural security suite needs a running Docker-compatible container runtime.',
        'It makes real HTTP requests against the local Supabase stack, because PostgREST',
        'routing and JSON serialisation are invisible from inside the database.',
        '',
        'Start Docker Desktop (or an equivalent runtime) and run `npm run test:security` again.',
        'Everything else — `npm run test`, lint, typecheck, build — runs without it.',
        '',
      ].join('\n'),
    )
  }

  // `db reset` refuses on a stopped stack with `supabase start is not running`,
  // which surfaces through vitest as an unhandled child-process error and tells
  // the reader nothing. `start` is idempotent and returns immediately when the
  // containers are already up, so bringing them up unconditionally costs
  // nothing and removes a confusing first-run failure.
  await run('npx', ['supabase', 'start'], { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 })

  // Proves the chain from empty, every time. `db reset` is also what applies
  // supabase/seed.sql, so the two-tenant fixture the whole suite depends on is
  // rebuilt rather than inherited from whatever the last run left behind.
  await run('npx', ['supabase', 'db', 'reset'], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })

  const { stdout } = await run('npx', ['supabase', 'status', '-o', 'json'], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })

  // `supabase status` prints a human-readable line about stopped services
  // before the JSON, so the payload starts at the first brace.
  const firstBrace = stdout.indexOf('{')
  if (firstBrace < 0) {
    throw new Error('could not read `supabase status` output')
  }
  const status = JSON.parse(stdout.slice(firstBrace)) as SupabaseStatus

  const apiUrl = status.API_URL
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY
  const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY

  if (!apiUrl || !publishableKey || !secretKey) {
    throw new Error('the local Supabase stack did not report a URL and keys')
  }

  project.provide('localStack', { apiUrl, publishableKey, secretKey })

  await waitForDataApi(apiUrl, publishableKey)

  return await serveEdgeFunctions(apiUrl, publishableKey)
}

/**
 * Waits until PostgREST has loaded its schema cache.
 *
 * `db reset` restarts the containers, and PostgREST answers `503` with
 * `PGRST002` — "could not query the database for its schema cache" — for a
 * short window afterwards. Tests that fire into that window fail with a
 * *transport* error dressed as a security result: an assertion expecting
 * `[{ display_name: 'Cem Kaya' }]` receives `{ code: 'PGRST002' }` and reports
 * a tenant-isolation failure that is really a cold start.
 *
 * That is the worst kind of flake, because its failure mode is a red security
 * test that says the wrong thing about why. Waiting for readiness is not
 * papering over it — the suite has no business asserting anything about a
 * server that has not finished starting.
 *
 * The probe is an anonymous read. On a ready server `anon` is refused at the
 * schema (401, `permission denied for schema api`), which is itself one of the
 * properties the suite goes on to assert; anything 5xx or `PGRST002` means not
 * ready yet.
 */
async function waitForDataApi(apiUrl: string, publishableKey: string): Promise<void> {
  const deadline = Date.now() + 90_000
  let last = 'no response'

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${apiUrl}/rest/v1/organizations?select=id&limit=1`, {
        headers: { apikey: publishableKey },
      })
      const body = await response.text()
      if (response.status < 500 && !body.includes('PGRST002')) {
        return
      }
      last = `${response.status} ${body.slice(0, 120)}`
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`the Data API did not become ready within 90 seconds; last response: ${last}`)
}

/**
 * Starts the Edge Function runtime, unless something is already serving it.
 *
 * `supabase start` brings up the database, the Auth service and PostgREST but
 * does NOT serve `supabase/functions` — that is `supabase functions serve`, a
 * long-running process. The provisioning suite needs it, so it is started here
 * and stopped by the returned teardown; a developer who already has it running
 * in a terminal keeps theirs, because killing somebody's watch process out from
 * under them is a rude thing for a test suite to do.
 */
async function serveEdgeFunctions(
  apiUrl: string,
  publishableKey: string,
): Promise<(() => Promise<void>) | undefined> {
  if (await edgeFunctionsRespond(apiUrl, publishableKey)) {
    return undefined
  }

  const { spawn } = await import('node:child_process')
  const child = spawn('npx', ['supabase', 'functions', 'serve'], {
    stdio: 'ignore',
    detached: false,
  })

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (await edgeFunctionsRespond(apiUrl, publishableKey)) {
      return async () => {
        child.kill('SIGTERM')
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  child.kill('SIGTERM')
  throw new Error('the Edge Function runtime did not start within two minutes')
}

/**
 * True once the runtime is answering.
 *
 * An unauthenticated POST is the probe: `verify_jwt = true` means the platform
 * rejects it at the edge with 401, which is a perfectly good "the function is
 * mounted" signal and does not run any of its code.
 *
 * The readiness condition is `status < 500`, and the reason is a trap worth
 * naming: `supabase start` brings up the edge-runtime CONTAINER without
 * mounting `supabase/functions`, so the gateway answers **502**, not 404. A
 * probe that accepted anything except 404 would conclude the runtime was ready,
 * skip starting it, and hand every provisioning test a 502 that looks like a
 * broken function rather than a missing server.
 */
async function edgeFunctionsRespond(apiUrl: string, publishableKey: string): Promise<boolean> {
  try {
    const response = await fetch(`${apiUrl}/functions/v1/admin-provision-user`, {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: '{}',
    })
    return response.status < 500
  } catch {
    return false
  }
}
