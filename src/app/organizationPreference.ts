/**
 * The organisation this device last entered, per user — a PREFERENCE, never
 * authority (Audit A, A-L7).
 *
 * ## What is stored, and what is not
 *
 * One `localStorage` key, `landedcompare.selectedOrganization`, holding
 * `{ "userId": "<uuid>", "organizationId": "<uuid>" }`. Two identifiers, both
 * already visible to the signed-in user, neither of them a credential. It is
 * deliberately NOT under the Supabase session key (`landedcompare.session`),
 * so reading, writing or clearing it can never disturb the session, and
 * signing out never has to reason about it.
 *
 * ## Why it can never grant anything
 *
 * The boot sequence reads it and compares it with the ACTIVE memberships it
 * has just read from the server (`bootstrapCloudSession`). A value naming an
 * organisation the user is no longer an active member of is simply not among
 * the choices and is ignored; a value written for a different user is
 * ignored. Every business request is then authorised by RLS against live
 * membership regardless. Deleting this key, or setting it to anything at
 * all, changes which company the selector pre-selects — nothing more.
 *
 * ## Tabs
 *
 * All tabs of one origin share it. The `storage` event tells the others when
 * one tab switches company, and they reboot into the new selection (see
 * `useApplicationBoot`), so a device shows one company at a time rather than
 * different companies in tabs that look identical.
 */

export const ORGANIZATION_PREFERENCE_KEY = 'landedcompare.selectedOrganization'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrganizationPreference {
  readonly userId: string
  readonly organizationId: string
}

function defaultStorage(): Storage | undefined {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage
  } catch {
    return undefined
  }
}

/** Parses a stored value; anything malformed is "no preference". */
export function parseOrganizationPreference(raw: string | null | undefined): OrganizationPreference | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as { userId?: unknown; organizationId?: unknown } | null
    if (
      value === null || typeof value !== 'object' ||
      typeof value.userId !== 'string' || !UUID.test(value.userId) ||
      typeof value.organizationId !== 'string' || !UUID.test(value.organizationId)
    ) {
      return undefined
    }
    return { userId: value.userId, organizationId: value.organizationId }
  } catch {
    return undefined
  }
}

/** The organisation this user last selected on this device, if any. */
export function readOrganizationPreference(userId: string, storage: Storage | undefined = defaultStorage()): string | undefined {
  try {
    const preference = parseOrganizationPreference(storage?.getItem(ORGANIZATION_PREFERENCE_KEY))
    return preference !== undefined && preference.userId === userId ? preference.organizationId : undefined
  } catch {
    return undefined
  }
}

/**
 * Remembers a selection. Writes only when the value changes, so re-entering
 * the same company does not wake every other tab. A storage failure (private
 * mode, quota) is not an error: the next start simply asks again.
 */
export function writeOrganizationPreference(
  userId: string,
  organizationId: string,
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    if (readOrganizationPreference(userId, storage) === organizationId) return
    storage?.setItem(ORGANIZATION_PREFERENCE_KEY, JSON.stringify({ userId, organizationId }))
  } catch {
    // A preference that cannot be stored is a preference not remembered.
  }
}
