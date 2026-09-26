/**
 * The company screen (Phase 12): who you are here, the users (OWNER/ADMIN),
 * and the portable company backup (OWNER/ADMIN). Credentials are never handled
 * here: an account is global, so no company administrator sets, resets or
 * even sees a password — a new person is invited by e-mail and chooses their
 * own.
 *
 * Every button on this screen is a request the server authorises on its own.
 * What the screen offers is decided from the caller's LIVE membership, read
 * on every load, so a demotion made elsewhere shows up here as fewer buttons
 * rather than as refusals; and when a refusal does arrive (the role changed
 * between the load and the click) the screen says so and offers to reload
 * the application's authority from the server instead of guessing.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import { exportOrganizationBackup, type CloudBackupArtifact } from '../../backup/cloud'
import { downloadBackup } from '../../backup/download'
import { isCloudError, type MembershipRole, type OrganizationMember } from '../../cloud'
import { formatInstant } from '../../i18n/format'
import type { SupportedLocale } from '../../i18n'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { SelectField, TextField } from '../../ui/Field'
import { Banner } from '../../ui/Feedback'
import { Select } from '../../ui/Select'
import { PageHeading } from '../shared/MasterDataPage'
import { isFormValidationError } from '../shared/formError'
import { errorCodeOf, useDataErrorMessage } from '../shared/useDataErrorMessage'
import {
  assignableRoles,
  canManage,
  changeMemberRole,
  changeMemberStatus,
  clearProvisioningAttempt,
  EMPTY_INVITATION,
  inviteMember,
  isAdministrator,
  loadOrganizationAdministration,
  type InvitationDraft,
  type OrganizationAdministration,
} from './organizationService'

type PendingAction =
  | { readonly kind: 'role'; readonly member: OrganizationMember; readonly role: MembershipRole }
  | { readonly kind: 'status'; readonly member: OrganizationMember }

function memberName(member: OrganizationMember, fallback: string): string {
  return member.displayName ?? member.email ?? fallback
}

export function OrganizationScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()
  const runtime = useAppRuntime()
  const describeError = useDataErrorMessage()
  const organizationId = runtime.organization.id
  const [administration, setAdministration] = useState<OrganizationAdministration>()
  const [loadError, setLoadError] = useState<unknown>()
  const [actionError, setActionError] = useState<unknown>()
  const [pending, setPending] = useState<PendingAction>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()

  const load = useCallback(async () => {
    try {
      setAdministration(await loadOrganizationAdministration(runtime.gateway, organizationId, runtime.userId))
      setLoadError(undefined)
    } catch (cause) {
      setLoadError(cause)
    }
  }, [organizationId, runtime.gateway, runtime.userId])

  useEffect(() => { void load() }, [load])

  const liveRole = administration?.liveRole ?? null
  const admin = isAdministrator(liveRole)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setActionError(undefined)
    setNotice(undefined)
    try {
      await action()
    } catch (cause) {
      setActionError(cause)
    } finally {
      setBusy(false)
      await load()
    }
  }

  const confirmPending = () => {
    const action = pending
    setPending(undefined)
    if (action === undefined) return
    void run(async () => {
      if (action.kind === 'role') {
        await changeMemberRole(runtime.gateway, organizationId, action.member, action.role)
      } else {
        await changeMemberStatus(runtime.gateway, organizationId, action.member, action.member.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')
      }
    })
  }

  const pendingDialog = (() => {
    if (pending === undefined) return null
    const name = memberName(pending.member, t('organization.members.noProfile'))
    const copy =
      pending.kind === 'role'
        ? {
            title: t('organization.members.roleTitle', { name }),
            body: t('organization.members.roleBody', {
              from: t(`organization.roles.${pending.member.role}`),
              to: t(`organization.roles.${pending.role}`),
            }),
          }
        : pending.member.status === 'ACTIVE'
          ? { title: t('organization.members.disableTitle', { name }), body: t('organization.members.disableBody'), note: t('organization.members.disableNote') }
          : { title: t('organization.members.enableTitle', { name }), body: t('organization.members.enableBody') }
    return (
      <ConfirmDialog
        title={copy.title}
        body={copy.body}
        note={'note' in copy ? copy.note : undefined}
        confirmLabel={t('organization.members.confirm')}
        cancelLabel={t('common.cancel')}
        busy={busy}
        onCancel={() => setPending(undefined)}
        onConfirm={confirmPending}
      />
    )
  })()

  const forbidden = isCloudError(actionError) && actionError.code === 'FORBIDDEN'

  return (
    <div className="page">
      <PageHeading title={t('organization.title')} subtitle={t('organization.subtitle')} />

      {loadError !== undefined ? (
        <Banner tone="danger" label={t('common.error')} note={errorCodeOf(loadError) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(loadError)}`} actions={
          <button type="button" className="button button--small" onClick={() => void load()}>{t('common.retry')}</button>
        }>{describeError(loadError)}</Banner>
      ) : null}

      {actionError !== undefined ? (
        <Banner tone="danger" label={t('common.error')} note={errorCodeOf(actionError) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(actionError)}`} actions={
          forbidden ? <button type="button" className="button button--small" onClick={runtime.revalidate}>{t('organization.reload')}</button> : undefined
        }>{describeError(actionError)}</Banner>
      ) : null}

      {notice !== undefined ? <Banner tone="info" label={t('common.status')}>{notice}</Banner> : null}

      <section className="card">
        <div className="card__header"><h2 className="card__title">{t('organization.info.title')}</h2></div>
        <div className="card__body">
          <dl className="detail-list">
            <div className="detail-list__row"><dt className="detail-list__term">{t('organization.info.name')}</dt><dd className="detail-list__value">{runtime.organization.name}</dd></div>
            <div className="detail-list__row"><dt className="detail-list__term">{t('organization.info.yourRole')}</dt><dd className="detail-list__value" data-testid="organization-role">{liveRole === null ? '—' : t(`organization.roles.${liveRole}`)}</dd></div>
            <div className="detail-list__row"><dt className="detail-list__term">{t('organization.info.yourAccess')}</dt><dd className="detail-list__value">{t(`organization.statuses.${liveRole === null ? 'DISABLED' : 'ACTIVE'}`)}</dd></div>
            <div className="detail-list__row"><dt className="detail-list__term">{t('organization.info.id')}</dt><dd className="detail-list__value detail-list__value--mono">{runtime.organization.id}</dd></div>
          </dl>
          {runtime.choices.length > 1 ? <p className="text-muted">{t('organization.info.companies', { count: runtime.choices.length })}</p> : null}
        </div>
      </section>

      {administration !== undefined && !admin ? (
        <Banner tone="info" label={t('common.status')}>{t('organization.memberOnly')}</Banner>
      ) : null}

      {admin ? (
        <BackupCard
          onDone={(artifact) => setNotice(`${t('organization.backup.done', { filename: artifact.filename })} ${t('organization.backup.counts', artifact.entityCounts)}`)}
        />
      ) : null}

      {admin && administration?.members !== undefined ? (
        <section className="card">
          <div className="card__header"><h2 className="card__title">{t('organization.members.title')}</h2></div>
          <div className="table-wrap"><table className="table">
            <caption className="visually-hidden">{t('organization.members.title')}</caption>
            <thead><tr>
              <th scope="col">{t('organization.members.name')}</th>
              <th scope="col">{t('organization.members.email')}</th>
              <th scope="col">{t('organization.members.role')}</th>
              <th scope="col">{t('organization.members.status')}</th>
              <th scope="col">{t('common.actions')}</th>
            </tr></thead>
            <tbody>
              {administration.members.map((member) => {
                const name = memberName(member, t('organization.members.noProfile'))
                const manageable = canManage(liveRole, runtime.userId, member)
                const roles = assignableRoles(liveRole)
                return (
                  <tr key={member.userId} data-inactive={member.status === 'DISABLED' ? 'true' : undefined} data-member-id={member.userId}>
                    <td className="table__primary">
                      {member.displayName ?? t('organization.members.noProfile')}
                      {member.userId === runtime.userId ? <span className="text-muted"> ({t('organization.members.you')})</span> : null}
                    </td>
                    <td className="text-muted">{member.email ?? '—'}</td>
                    <td>
                      {manageable ? (
                        <Select
                          ariaLabel={t('organization.members.roleSelectLabel', { name })}
                          value={member.role}
                          disabled={busy}
                          onChange={(role) => setPending({ kind: 'role', member, role: role as MembershipRole })}
                          options={(roles.includes(member.role) ? roles : [member.role, ...roles]).map((role) => ({
                            value: role,
                            label: t(`organization.roles.${role}`),
                          }))}
                        />
                      ) : t(`organization.roles.${member.role}`)}
                    </td>
                    <td>
                      <span className={member.status === 'ACTIVE' ? 'badge badge--active' : 'badge badge--inactive'}>
                        {t(`organization.statuses.${member.status}`)}
                      </span>
                    </td>
                    <td>
                      {manageable ? (
                        <button type="button" className="button button--small" disabled={busy} onClick={() => setPending({ kind: 'status', member })}>
                          {member.status === 'ACTIVE' ? t('organization.members.disable') : t('organization.members.enable')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table></div>
        </section>
      ) : null}

      {admin ? (
        <InviteCard
          actorRole={liveRole}
          onProvisioned={(draft) => {
            // One neutral sentence for every success: whether the address was
            // new (Auth e-mailed the person an invitation) or already had an
            // account (it was linked) is not shown, and nothing that could
            // open the account ever reaches this screen.
            setNotice(t('organization.invite.done', { email: draft.email.trim().toLowerCase() }))
            void load()
          }}
        />
      ) : null}

      {admin && administration?.attempts !== undefined && administration.attempts.total > 0 ? (
        <section className="card">
          <div className="card__header"><h2 className="card__title">{t('organization.attempts.title')}</h2></div>
          <div className="card__body"><p className="text-muted">{t('organization.attempts.body')}</p></div>
          <div className="table-wrap"><table className="table">
            <caption className="visually-hidden">{t('organization.attempts.title')}</caption>
            <thead><tr>
              <th scope="col">{t('organization.members.email')}</th>
              <th scope="col">{t('organization.members.role')}</th>
              <th scope="col">{t('organization.attempts.startedAt')}</th>
              <th scope="col">{t('common.actions')}</th>
            </tr></thead>
            <tbody>
              {administration.attempts.attempts.map((attempt) => (
                <tr key={attempt.requestId}>
                  <td className="table__primary">{attempt.email}</td>
                  <td>{t(`organization.roles.${attempt.requestedRole}`)}</td>
                  <td className="text-muted">{formatInstant(attempt.createdAt, locale)}</td>
                  <td>
                    {liveRole === 'OWNER' ? (
                      <button type="button" className="button button--small" disabled={busy}
                        onClick={() => void run(() => clearProvisioningAttempt(runtime.gateway, organizationId, attempt.requestId))}>
                        {t('organization.attempts.clear')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
          {administration.attempts.total > administration.attempts.attempts.length ? (
            <div className="card__body"><p className="text-muted">{t('organization.attempts.more', { count: administration.attempts.total - administration.attempts.attempts.length })}</p></div>
          ) : null}
        </section>
      ) : null}

      {pendingDialog}
    </div>
  )
}

/**
 * The backup action. The download is started ONLY after the whole file has
 * been read, built and read back through the strict parser; a failure at any
 * point leaves no file at all.
 */
function BackupCard({ onDone }: { readonly onDone: (artifact: CloudBackupArtifact) => void }) {
  const { t } = useTranslation()
  const runtime = useAppRuntime()
  const describeError = useDataErrorMessage()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()

  const exportNow = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      const artifact = await exportOrganizationBackup(runtime.gateway, runtime.organization.id)
      downloadBackup(artifact)
      onDone(artifact)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card__header"><h2 className="card__title">{t('organization.backup.title')}</h2></div>
      <div className="card__body">
        <p>{t('organization.backup.body')}</p>
        <p className="text-muted">{t('organization.backup.scope')}</p>
        <p className="text-muted">{t('organization.backup.integrity')}</p>
        {failure !== undefined ? (
          <Banner tone="danger" label={t('organization.backup.failed')} note={errorCodeOf(failure) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(failure)}`}>
            {describeError(failure)}
          </Banner>
        ) : null}
        <div className="form-actions">
          <span className="form-actions__spacer" />
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void exportNow()}>
            {busy ? t('organization.backup.exporting') : t('organization.backup.export')}
          </button>
        </div>
      </div>
    </section>
  )
}

/**
 * Adds a user. One request id per invitation: generated on the first submit
 * and REUSED if the same invitation is submitted again (a retry after a lost
 * response), replaced as soon as any field changes or the invitation
 * succeeds. That is what lets the server converge on one account (§4 case B).
 */
function InviteCard({
  actorRole,
  onProvisioned,
}: {
  readonly actorRole: MembershipRole | null
  readonly onProvisioned: (draft: InvitationDraft) => void
}) {
  const { t } = useTranslation()
  const runtime = useAppRuntime()
  const describeError = useDataErrorMessage()
  const [draft, setDraft] = useState<InvitationDraft>(EMPTY_INVITATION)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const requestId = useRef<string | undefined>(undefined)

  const update = (patch: Partial<InvitationDraft>) => {
    requestId.current = undefined
    setDraft((current) => ({ ...current, ...patch }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setFailure(undefined)
    requestId.current ??= crypto.randomUUID()
    try {
      await inviteMember(runtime.gateway, runtime.organization.id, requestId.current, draft)
      const submitted = draft
      requestId.current = undefined
      setDraft(EMPTY_INVITATION)
      onProvisioned(submitted)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  const fieldError = (field: string) =>
    isFormValidationError(failure) && failure.field === field ? t(failure.messageKey) : undefined

  return (
    <section className="card">
      <div className="card__header"><h2 className="card__title">{t('organization.invite.title')}</h2></div>
      <div className="card__body">
        <p className="text-muted">{t('organization.invite.hint')}</p>
        {failure !== undefined && !isFormValidationError(failure) ? (
          <Banner tone="danger" label={t('common.error')} note={errorCodeOf(failure) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(failure)}`}>
            {describeError(failure)}
          </Banner>
        ) : null}
        <form onSubmit={(event) => void submit(event)}>
          <div className="form-grid">
            <TextField label={t('organization.invite.email')} type="email" value={draft.email} onChange={(email) => update({ email })} required error={fieldError('email')} />
            <TextField label={t('organization.invite.displayName')} value={draft.displayName} onChange={(displayName) => update({ displayName })} required error={fieldError('displayName')} />
            <SelectField
              label={t('organization.invite.role')}
              value={draft.role}
              onChange={(role) => update({ role: role as MembershipRole })}
              options={assignableRoles(actorRole).map((role) => ({ value: role, label: t(`organization.roles.${role}`) }))}
              required
            />
          </div>
          <div className="form-actions">
            <span className="form-actions__spacer" />
            <button type="submit" className="button button--primary" disabled={busy || draft.email.trim() === '' || draft.displayName.trim() === ''}>
              {busy ? t('organization.invite.submitting') : t('organization.invite.submit')}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
