/**
 * Shared server-side context for the privileged Edge Function.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4 and §19.
 *
 * These functions exist for exactly one reason: invitation-based provisioning
 * must invite a new `auth.users` identity or locate an existing one through the
 * Auth Admin API. That API requires the secret key, which bypasses every
 * row-level policy in the system. It therefore lives in Edge Function secrets,
 * is read here, and is never returned, logged, or sent anywhere near a client.
 *
 * Everything else this product does is a view or a function in the `api`
 * schema. One Edge Function (`admin-provision-user`) is the whole server-side
 * deployment surface — `admin-reset-password` was removed in Phase 12 because
 * an organisation must not replace a global credential (P12-B1) —
 * outside the migrations.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.58.0'
import { resolveServerSecretKey } from './secretKey.ts'

/**
 * The secret key, taken from the platform rather than managed by hand.
 *
 * There is **no project-specific secret to set**. Supabase injects the server
 * credential into every Edge Function invocation — `SUPABASE_SECRET_KEYS`
 * today, `SUPABASE_SERVICE_ROLE_KEY` on projects still on the legacy pair — so
 * requiring an operator to create a second copy of it would add a step to the
 * deployment runbook whose only effect is a duplicate of the most dangerous
 * credential in the system, drifting out of date the first time the real one is
 * rotated.
 *
 * `./secretKey.ts` holds the resolution rules and is unit-tested from the
 * application suite; this function only supplies the environment.
 */
function secretKey(): string {
  return resolveServerSecretKey(Deno.env.toObject()).key
}

function projectUrl(): string {
  const url = Deno.env.get('SUPABASE_URL')
  if (!url) {
    throw new Error('server is not configured: no project URL available')
  }
  return url
}

/**
 * A client authorised as `service_role`, holding EXECUTE on three named RPCs
 * and no privilege on any table in `app_data`.
 *
 * That is deliberate and it is the reason this is the only place the secret key
 * appears: the most dangerous credential in the system can call
 * `begin_provisioning`, `complete_provisioning` and `fail_provisioning`, and
 * cannot compose a single statement against a business table if this file is
 * ever wrong. (The two password-reset RPCs were dropped in Phase 12.)
 */
export function serviceClient(): SupabaseClient {
  return createClient(projectUrl(), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'api' },
  })
}

export interface Caller {
  readonly userId: string
  readonly email: string | null
}

/**
 * Resolves the caller from the `Authorization` header, or refuses.
 *
 * This establishes only WHO is asking. Whether they may do the thing they are
 * asking for is decided by the database, from `app_data.memberships`, inside
 * the RPC — and is decided again there even though this function has already
 * been called, because a control that exists in one place is a control that a
 * rewrite of that place removes silently.
 */
export async function resolveCaller(request: Request): Promise<Caller> {
  const header = request.headers.get('Authorization') ?? ''
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (token === '') {
    throw new AdminError(401, 'UNAUTHENTICATED', 'a signed-in caller is required')
  }

  const { data, error } = await serviceClient().auth.getUser(token)
  if (error || !data.user) {
    throw new AdminError(401, 'UNAUTHENTICATED', 'the session is not valid')
  }

  return { userId: data.user.id, email: data.user.email ?? null }
}

/**
 * A failure with a machine-readable code and a status.
 *
 * The `message` is developer-facing English and is not a sentence any user
 * reads: the client maps `code` to a translation key, exactly as
 * `src/i18n/persistenceText.ts` already maps the persistence layer's codes. A
 * raw PostgreSQL message never reaches a screen.
 */
export class AdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'AdminError'
  }
}

/**
 * Turns a PostgREST error into the vocabulary the client already speaks.
 *
 * The RPCs raise with `errcode` and a `detail` naming the code — `FORBIDDEN`,
 * `RECORD_INVALID`, `DUPLICATE_KEY` — rather than relying on message text,
 * because message text is the thing that gets reworded.
 */
export function fromPostgrest(error: { code?: string; details?: string | null; message: string }): AdminError {
  const detail = (error.details ?? '').trim()
  if (detail === 'FORBIDDEN' || error.code === '42501') {
    return new AdminError(403, 'FORBIDDEN', error.message)
  }
  if (detail === 'RECORD_INVALID') {
    return new AdminError(400, 'RECORD_INVALID', error.message)
  }
  if (detail === 'DUPLICATE_KEY') {
    return new AdminError(409, 'DUPLICATE_KEY', error.message)
  }
  if (detail === 'RECORD_NOT_FOUND') {
    return new AdminError(404, 'RECORD_NOT_FOUND', error.message)
  }
  return new AdminError(500, 'SERVER_UNAVAILABLE', error.message)
}

/**
 * Where an invitation link lands, or undefined for the project's Site URL.
 *
 * Read from the function's environment (`LANDEDCOMPARE_INVITE_REDIRECT_URL`,
 * an operator setting) and NEVER from a request: the link carries the
 * invited person's session tokens in its fragment, so a caller-chosen
 * destination would be a way to collect them. Auth additionally refuses any
 * redirect outside the project's allow list. Only `https:` — or plain `http:`
 * to a loopback address, for local development — is accepted; anything else
 * fails closed rather than silently falling back.
 *
 * There is no generated password anywhere in this codebase any more (Phase
 * 12): a new person receives an invitation and chooses their own.
 */
export function inviteRedirectUrl(): string | undefined {
  const raw = (Deno.env.get('LANDEDCOMPARE_INVITE_REDIRECT_URL') ?? '').trim()
  if (raw === '') return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AdminError(500, 'SERVER_UNAVAILABLE', 'the invitation redirect is misconfigured')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AdminError(500, 'SERVER_UNAVAILABLE', 'the invitation redirect must be https')
  }
  return url.toString()
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/**
 * The outer shape every handler shares: CORS, method check, and a single place
 * where an unexpected throwable becomes a response instead of a stack trace in
 * a log the Free plan keeps for one day.
 */
export function serveAdminFunction(handler: (request: Request) => Promise<Response>): void {
  Deno.serve(async (request: Request) => {
    if (request.method === 'OPTIONS') {
      return corsPreflight()
    }
    if (request.method !== 'POST') {
      return jsonResponse(405, { code: 'METHOD_NOT_ALLOWED' })
    }
    try {
      return await handler(request)
    } catch (cause) {
      if (cause instanceof AdminError) {
        return jsonResponse(cause.status, { code: cause.code, message: cause.message })
      }
      // Deliberately generic. Whatever went wrong here, the client's correct
      // response is the same one, and the details are not a client's business.
      console.error('unhandled admin function failure', cause)
      return jsonResponse(500, { code: 'SERVER_UNAVAILABLE' })
    }
  })
}
