/**
 * admin-provision-user — the idempotent user provisioning workflow.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4; threat model 19
 * and 24.
 *
 * ---------------------------------------------------------------------------
 * This is not one transaction, and it is not described as one
 *
 * `auth.admin.inviteUserByEmail()` is an HTTP call to the Auth service. The
 * profile and membership rows are a PostgreSQL write. Between them sit a
 * network, a timeout, and this function, which can be killed mid-execution.
 * They do not commit together.
 *
 * So the workflow is designed to be IDEMPOTENT instead: running it again with
 * the same `request_id` converges on one valid final state rather than
 * producing a second one.
 *
 *   0 AUTHORISE            resolve the caller's session
 *   1 CLAIM THE ATTEMPT    api.begin_provisioning — which is ALSO where the
 *                          database proves the caller is an OWNER/ADMIN of the
 *                          named organisation, BEFORE step 2 touches Auth
 *   2 RESOLVE THE USER     the non-transactional step: find, or INVITE
 *   3 LINK                 api.complete_provisioning — profile + membership +
 *                          admin event + attempt status, in one transaction
 *   4 ON FAILURE           mark the attempt FAILED; delete NOTHING
 *   5 RETURN               { status, request_id } — the same shape always
 *
 * ## No administrator ever holds a credential (Phase 12, final correction)
 *
 * An Auth identity is GLOBAL: one person, one password, for every
 * organisation they belong to. An earlier version created a NEW account with
 * a generated password and returned it to the inviting administrator — so if
 * a second organisation linked the same address before the person changed
 * that password, the first administrator could sign in as them there. The
 * forced-change flag could not prevent it: it is an onboarding screen, and a
 * direct API call never sees it.
 *
 * Now a new address receives an INVITATION, sent by Auth to that address and
 * nowhere else. The person opens it, is signed in by it, and chooses their own
 * password. This function never generates, sees, returns or logs a password,
 * an invitation link, an OTP or a token. An EXISTING account is linked and its
 * credential is never touched.
 *
 *   address unknown to Auth          → invite (creates the account, e-mails the
 *                                      person), then link
 *   address known, never confirmed   → re-send the invitation to the person
 *                                      (a previous invitation may have been
 *                                      lost), then link
 *   address known and confirmed      → link only
 *
 * The invitation link lands on the project's configured Site URL, or on
 * `LANDEDCOMPARE_INVITE_REDIRECT_URL` when the operator sets one — never on a
 * URL taken from the request, which would let a caller redirect the person's
 * session tokens anywhere. Auth itself refuses a redirect outside its allow
 * list.
 *
 * ## Why there is no compensating delete (P12-H2)
 *
 * Between creating an account and a failed link, ANOTHER organisation's
 * provisioning can find the account by its address and link it; deleting it
 * then would remove a person another company just gave access to. So a failed
 * attempt leaves the account in place, without a membership — exactly what
 * `app_private.orphaned_auth_identities` reports — and the operator purge
 * deletes it only after re-proving, under a row lock in the database, that no
 * membership and no in-flight attempt exists. A retry links it.
 *
 * ## What the caller learns (P12-M2)
 *
 * `{ status, request_id }` — identical whether the address was new or
 * already had an account. No user id, no "created" flag, no credential, and
 * one failure reason (`LINK_FAILED`) whichever case it was. Nothing about
 * other organisations is returned.
 *
 * Deliberately NOT built: a job queue. Every step is a single call with a
 * bounded runtime, the retry is a human pressing a button again, and an
 * operation that happens three times a year does not need a scheduler.
 */

import {
  AdminError,
  fromPostgrest,
  inviteRedirectUrl,
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
    // Case B. The stored outcome, returned again — the same shape as the
    // first answer, so a retry learns nothing new either.
    return jsonResponse(200, {
      status: 'ALREADY_SUCCEEDED',
      request_id: requestId,
    })
  }

  // ── 2  RESOLVE THE AUTH USER — the non-transactional step ───────────────
  let userId: string
  let createdHere = false

  const existing = await findUserByEmail(service, email)

  if (existing && existing.confirmed) {
    // Case C. The account exists and belongs to its owner, who has already
    // set it up. It is linked; its credential is not this function's to
    // touch, by any path.
    userId = existing.id
  } else {
    // A new address, or an account whose invitation was never accepted (a
    // lost e-mail, another organisation's pending invitation). Auth sends the
    // invitation to the PERSON; nothing that could open the account comes
    // back here.
    const redirectTo = inviteRedirectUrl()
    const invited = await service.auth.admin.inviteUserByEmail(email, redirectTo ? { redirectTo } : undefined)

    if (invited.error || !invited.data.user) {
      // "Already registered" is a race with another administrator, or a
      // confirmation that landed in between: re-read and link what exists.
      const raced = await findUserByEmail(service, email)
      if (!raced) {
        await failAttempt(service, requestId, 'INVITATION_FAILED')
        throw new AdminError(502, 'SERVER_UNAVAILABLE', 'the invitation could not be sent')
      }
      userId = raced.id
    } else {
      userId = invited.data.user.id
      createdHere = !existing
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
    // ── 4  ON FAILURE ─────────────────────────────────────────────────────
    // Nothing is deleted — see "Why there is no compensating delete". One
    // reason for every case: whether this attempt created the account is not
    // something the organisation's administrators need, and the attempt row
    // is readable by them.
    await failAttempt(service, requestId, 'LINK_FAILED')
    throw fromPostgrest(link.error)
  }

  // ── 5  RETURN — the same shape for a new address and an existing account.
  return jsonResponse(200, {
    status: 'SUCCEEDED',
    request_id: requestId,
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
): Promise<{ id: string; confirmed: boolean } | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage: 200 })
    if (error) {
      throw new AdminError(502, 'SERVER_UNAVAILABLE', 'the account directory is unavailable')
    }
    const match = data.users.find((user) => (user.email ?? '').toLowerCase() === email)
    if (match) {
      return { id: match.id, confirmed: Boolean(match.email_confirmed_at) }
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
