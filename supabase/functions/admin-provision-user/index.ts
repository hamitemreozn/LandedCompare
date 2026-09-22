/**
 * admin-provision-user — the idempotent user provisioning workflow.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4; threat model 19
 * and 24.
 *
 * ---------------------------------------------------------------------------
 * This is not one transaction, and it is not described as one
 *
 * `auth.admin.createUser()` is an HTTP call to the Auth service. The profile
 * and membership rows are a PostgreSQL write. Between them sit a network, a
 * timeout, and this function, which can be killed mid-execution. They do not
 * commit together.
 *
 * So the workflow is designed to be IDEMPOTENT instead: running it again with
 * the same `request_id` converges on one valid final state rather than
 * producing a second one.
 *
 *   0 AUTHORISE            resolve the caller's session
 *   1 CLAIM THE ATTEMPT    api.begin_provisioning — which is ALSO where the
 *                          database proves the caller is an OWNER/ADMIN of the
 *                          named organisation, BEFORE step 2 touches Auth
 *   2 RESOLVE THE USER     the non-transactional step: find or create
 *   3 LINK                 api.complete_provisioning — profile + membership +
 *                          admin event + attempt status, in one transaction
 *   4 COMPENSATE           delete ONLY an auth user this attempt created
 *   5 RETURN               status, user id, and a password exactly once
 *
 * Two properties fall out of that and are the reason it is safe: no path ever
 * deletes an auth user it did not create in the same attempt, and the only
 * thing that is ever left half-done is a `provisioning_attempts` row, which is
 * inert.
 *
 * Deliberately NOT built: a job queue. Every step is a single call with a
 * bounded runtime, the retry is a human pressing a button again, and an
 * operation that happens three times a year does not need a scheduler.
 */

import {
  AdminError,
  fromPostgrest,
  generateTemporaryPassword,
  jsonResponse,
  resolveCaller,
  serveAdminFunction,
  serviceClient,
} from '../_shared/adminContext.ts'

interface ProvisionRequest {
  request_id?: unknown
  organization_id?: unknown
  email?: unknown
  display_name?: unknown
  role?: unknown
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AdminError(400, 'RECORD_INVALID', `${field} must be a uuid`)
  }
  return value.toLowerCase()
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AdminError(400, 'RECORD_INVALID', `${field} is required`)
  }
  return value.trim()
}

serveAdminFunction(async (request) => {
  const caller = await resolveCaller(request)

  let body: ProvisionRequest
  try {
    body = await request.json()
  } catch {
    throw new AdminError(400, 'RECORD_INVALID', 'a JSON body is required')
  }

  // The client generates `request_id` once per press of the button and reuses
  // it on retry, exactly as it already generates entity UUIDs. It is the whole
  // idempotency mechanism, so it is required rather than defaulted — a
  // server-generated one would be different on every retry, which is the
  // opposite of what it is for.
  const requestId = requireUuid(body.request_id, 'request_id')
  const organizationId = requireUuid(body.organization_id, 'organization_id')
  const email = requireText(body.email, 'email').toLowerCase()
  const displayName = requireText(body.display_name, 'display_name')
  const role = requireText(body.role, 'role').toUpperCase()

  if (role !== 'OWNER' && role !== 'ADMIN' && role !== 'MEMBER') {
    throw new AdminError(400, 'RECORD_INVALID', 'role must be OWNER, ADMIN or MEMBER')
  }

  const service = serviceClient()

  // ── 1  CLAIM THE ATTEMPT ────────────────────────────────────────────────
  // This call is also the authorisation gate. A caller who is not an ACTIVE
  // OWNER or ADMIN of `organization_id` is refused here, which means they never
  // reach the Auth Admin API at all — the ordering in §4 step 0, enforced by
  // putting the check in the first thing that runs.
  const claim = await service.rpc('begin_provisioning', {
    p_request_id: requestId,
    p_organization_id: organizationId,
    p_email: email,
    p_requested_role: role,
    p_actor_user_id: caller.userId,
  })

  if (claim.error) {
    throw fromPostgrest(claim.error)
  }

  const claimStatus = (claim.data as { status: string; user_id?: string }).status

  if (claimStatus === 'BUSY') {
    // Case E, or two administrators pressing at once. Refused rather than
    // raced: "the other attempt is probably dead by now" is a guess, and acting
    // on it is how a duplicate auth user appears.
    return jsonResponse(409, {
      code: 'PROVISIONING_IN_FLIGHT',
      request_id: requestId,
    })
  }

  if (claimStatus === 'ALREADY_SUCCEEDED') {
    // Case B. The stored outcome, returned again. No password: it was shown
    // once, at the moment it was generated, and this is not that moment.
    return jsonResponse(200, {
      status: 'ALREADY_SUCCEEDED',
      request_id: requestId,
      user_id: (claim.data as { user_id?: string }).user_id ?? null,
      temporary_password: null,
    })
  }

  // ── 2  RESOLVE THE AUTH USER — the non-transactional step ───────────────
  let userId: string
  let createdHere = false
  let temporaryPassword: string | null = null

  const existing = await findUserByEmail(service, email)

  if (existing) {
    // Case C. The account exists and is not this attempt's to re-credential:
    // it is linked, and NO password is returned. Resetting it is the separate,
    // explicit `admin-reset-password` action, precisely so that an
    // administrator re-entering an address cannot silently change a
    // colleague's password.
    userId = existing
  } else {
    const password = generateTemporaryPassword()
    const created = await service.auth.admin.createUser({
      email,
      password,
      // Asserted by an administrator who knows this person, rather than proven
      // by a click on a link that the Free plan cannot deliver. That is a
      // stronger guarantee, and the design does not pretend otherwise.
      email_confirm: true,
    })

    if (created.error || !created.data.user) {
      // A race with another administrator can land here with "already
      // registered". Re-read rather than fail: the outcome we want is that the
      // account exists and is linked, and it now does.
      const raced = await findUserByEmail(service, email)
      if (!raced) {
        await failAttempt(service, requestId, 'AUTH_CREATE_FAILED')
        throw new AdminError(502, 'SERVER_UNAVAILABLE', 'the account could not be created')
      }
      userId = raced
    } else {
      userId = created.data.user.id
      createdHere = true
      temporaryPassword = password
    }
  }

  // ── 3  LINK, TRANSACTIONALLY ────────────────────────────────────────────
  const link = await service.rpc('complete_provisioning', {
    p_request_id: requestId,
    p_user_id: userId,
    p_display_name: displayName,
    p_created_here: createdHere,
  })

  if (link.error) {
    // ── 4  COMPENSATE ─────────────────────────────────────────────────────
    // ONLY a user this attempt created. This single condition is what makes
    // case C safe: an administrator who mistypes an address into an existing
    // colleague's account, and whose link then fails, does not lose that
    // colleague's account.
    if (createdHere) {
      await service.auth.admin.deleteUser(userId).catch((cause) => {
        console.error('compensating delete failed', cause)
      })
    }
    await failAttempt(service, requestId, 'LINK_FAILED')
    throw fromPostgrest(link.error)
  }

  // ── 5  RETURN. The password appears here and nowhere else — it is not
  // stored in plaintext, not written to `admin_events`, and not logged.
  return jsonResponse(200, {
    status: 'SUCCEEDED',
    request_id: requestId,
    user_id: userId,
    account_created: createdHere,
    temporary_password: temporaryPassword,
  })
})

/**
 * Finds an auth user by e-mail, or reports that there is none.
 *
 * `listUsers` is paged, and the pilot has a handful of accounts, so the filter
 * is applied client-side over a bounded scan rather than through a query
 * parameter whose availability varies by Auth version. If this ever has to
 * handle thousands of users it needs a different mechanism, and that is a
 * problem this product will be glad to have.
 */
async function findUserByEmail(
  service: ReturnType<typeof serviceClient>,
  email: string,
): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 })
    if (error) {
      throw new AdminError(502, 'SERVER_UNAVAILABLE', 'the account directory is unavailable')
    }
    const match = data.users.find((user) => (user.email ?? '').toLowerCase() === email)
    if (match) {
      return match.id
    }
    if (data.users.length < 200) {
      return null
    }
  }
  return null
}

async function failAttempt(
  service: ReturnType<typeof serviceClient>,
  requestId: string,
  reason: string,
): Promise<void> {
  const { error } = await service.rpc('fail_provisioning', {
    p_request_id: requestId,
    p_reason: reason,
  })
  if (error) {
    // The attempt stays IN_FLIGHT. That is a recoverable state with a named
    // remedy (§4 case E: an OWNER sees it and clears it explicitly), and it is
    // strictly better than pretending the failure was clean.
    console.error('could not mark attempt failed', error.message)
  }
}
