/**
 * admin-reset-password — an administrator issues a new temporary password.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4.
 *
 * ---------------------------------------------------------------------------
 * Why this is a separate function and not part of provisioning
 *
 * §4 case C: when an administrator enters an address that already has an
 * account, `admin-provision-user` LINKS it and returns no password. Folding a
 * reset into that path would mean an administrator who re-typed a colleague's
 * address silently changed that colleague's password — a destructive side
 * effect of an operation that looks like an invitation.
 *
 * So resetting is explicit, has its own name, and appears in `admin_events` as
 * its own event type.
 *
 * ---------------------------------------------------------------------------
 * There is no self-service reset, and the interface says so
 *
 * Self-service password reset is an e-mail-delivery feature, and the Free
 * plan's built-in e-mail sends two messages an hour to the Supabase
 * organisation's own team members only. A "Şifremi unuttum" link would
 * therefore do nothing. The honest product tells the user to call their
 * administrator, which is a person they can actually reach.
 *
 * OPTIONAL FUTURE: a third-party SMTP provider makes self-service reset work
 * and changes nothing about this function or the model behind it.
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AdminError(400, 'RECORD_INVALID', `${field} must be a uuid`)
  }
  return value.toLowerCase()
}

serveAdminFunction(async (request) => {
  const caller = await resolveCaller(request)

  let body: { organization_id?: unknown; user_id?: unknown }
  try {
    body = await request.json()
  } catch {
    throw new AdminError(400, 'RECORD_INVALID', 'a JSON body is required')
  }

  const organizationId = requireUuid(body.organization_id, 'organization_id')
  const subjectUserId = requireUuid(body.user_id, 'user_id')

  const service = serviceClient()

  // ── AUTHORISE, before the Auth Admin API is touched ─────────────────────
  //
  // The database checks three things this function must not decide for itself:
  // that the caller is an ACTIVE OWNER/ADMIN of this organisation, that the
  // SUBJECT is an ACTIVE member of the SAME organisation — without which an
  // ADMIN of any company could reset any account in the system by naming its
  // uuid — and that an ADMIN is not resetting an OWNER.
  const authorised = await service.rpc('begin_password_reset', {
    p_organization_id: organizationId,
    p_actor_user_id: caller.userId,
    p_subject_user_id: subjectUserId,
  })

  if (authorised.error) {
    throw fromPostgrest(authorised.error)
  }

  // ── RE-CREDENTIAL ───────────────────────────────────────────────────────
  const password = generateTemporaryPassword()
  const updated = await service.auth.admin.updateUserById(subjectUserId, { password })

  if (updated.error) {
    throw new AdminError(502, 'SERVER_UNAVAILABLE', 'the password could not be changed')
  }

  // ── RECORD ──────────────────────────────────────────────────────────────
  //
  // Sets `must_change_password` and writes the admin event. If this fails the
  // password HAS already changed, and saying otherwise would send an
  // administrator to read out a credential that no longer works — so the
  // response says exactly what happened instead of reporting a clean failure.
  const recorded = await service.rpc('complete_password_reset', {
    p_organization_id: organizationId,
    p_actor_user_id: caller.userId,
    p_subject_user_id: subjectUserId,
  })

  if (recorded.error) {
    console.error('password changed but not recorded', recorded.error.message)
    return jsonResponse(200, {
      status: 'CHANGED_BUT_NOT_RECORDED',
      user_id: subjectUserId,
      temporary_password: password,
    })
  }

  // The password appears here and nowhere else. It is not stored in plaintext,
  // it is not written to `admin_events` — which records that a reset happened
  // and who did it, never the value — and it is not logged.
  return jsonResponse(200, {
    status: 'RESET',
    user_id: subjectUserId,
    temporary_password: password,
  })
})
