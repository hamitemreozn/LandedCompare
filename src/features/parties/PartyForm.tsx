/**
 * The supplier and customer record forms.
 *
 * Same contract as `ProductForm`: explicit Save, field errors on fields, a
 * stale write as a banner with a reload action, and nothing written until the
 * transaction has committed. The two forms share a shell because they share
 * every behaviour and differ only in which fields they render.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { CustomerRecord, CustomerStatusRecord, SupplierRecord } from '../../cloud'
import { formatInstant } from '../../i18n/format'
import { getLocale } from '../../i18n'
import { SelectField, TextAreaField, TextField } from '../../ui/Field'
import { Banner } from '../../ui/Feedback'
import { isFormValidationError } from '../shared/formError'
import { errorCodeOf, isStaleWrite, useDataErrorMessage } from '../shared/useDataErrorMessage'
import {
  createCustomerRecord,
  createSupplierRecord,
  customerDraftFrom,
  EMPTY_CUSTOMER_DRAFT,
  EMPTY_SUPPLIER_DRAFT,
  loadCustomer,
  loadSupplier,
  supplierDraftFrom,
  updateCustomerRecord,
  updateSupplierRecord,
  type CustomerDraft,
  type SupplierDraft,
} from './partyService'
import { listCustomerStatuses } from './customerStatusService'

interface PartyFormShellProps<TRecord, TDraft> {
  readonly existing?: TRecord
  readonly draft: TDraft
  readonly setDraft: (draft: TDraft) => void
  readonly title: string
  readonly fields: (args: {
    readonly fieldErrors: Readonly<Record<string, string>>
    readonly clearError: (field: string) => void
    /** False while creating, so the Active control can be left out there. */
    readonly isEditing: boolean
  }) => ReactNode
  readonly validate: (draft: TDraft) => Readonly<Record<string, string>>
  readonly save: (existing: TRecord | undefined, draft: TDraft) => Promise<unknown>
  readonly reload: (record: TRecord) => Promise<{ record: TRecord; draft: TDraft }>
  readonly onCancel: () => void
  readonly onSaved: () => void
  readonly updatedAt?: string
}

function PartyFormShell<TRecord, TDraft>({
  existing,
  draft,
  setDraft,
  title,
  fields,
  validate,
  save,
  reload,
  onCancel,
  onSaved,
  updatedAt,
}: PartyFormShellProps<TRecord, TDraft>) {
  const { t } = useTranslation()
  const { organizationLocked } = useAppRuntime()
  const describeError = useDataErrorMessage()

  const [record, setRecord] = useState(existing)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [failure, setFailure] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)
  const [stamp, setStamp] = useState(updatedAt)

  const clearError = (field: string) =>
    setFieldErrors((current) => {
      if (!(field in current)) {
        return current
      }
      const next = { ...current }
      delete next[field]
      return next
    })

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setFailure(undefined)
    const errors = validate(draft)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      return
    }

    setBusy(true)
    try {
      await save(record, draft)
      onSaved()
    } catch (cause) {
      if (isFormValidationError(cause)) {
        setFieldErrors({ [cause.field]: t(cause.messageKey) })
      } else {
        setFailure(cause)
      }
    } finally {
      setBusy(false)
    }
  }

  const reloadRecord = async () => {
    if (record === undefined) {
      return
    }
    setBusy(true)
    try {
      const fresh = await reload(record)
      setRecord(fresh.record)
      setDraft(fresh.draft)
      setStamp((fresh.record as { updatedAt?: string }).updatedAt)
      setFailure(undefined)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  const code = errorCodeOf(failure)

  return (
    <form className="card" onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="card__header">
        <h2 className="card__title">{record === undefined ? title : t('form.editRecord')}</h2>
        {stamp !== undefined ? (
          <span className="text-sm text-muted">
            {t('form.updatedAt')}: {formatInstant(stamp, getLocale())}
          </span>
        ) : null}
      </div>

      <div className="card__body">
        {failure !== undefined ? (
          <Banner
            tone="danger"
            label={t('form.saveFailed')}
            note={code === undefined ? undefined : `${t('boot.errorCode')}: ${code}`}
            actions={
              isStaleWrite(failure) ? (
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void reloadRecord()}
                  disabled={busy}
                >
                  {t('form.reloadRecord')}
                </button>
              ) : undefined
            }
          >
            {describeError(failure)}
          </Banner>
        ) : null}

        <p className="form-note">{t('form.requiredNote')}</p>

        <div className="form-grid">
          {fields({ fieldErrors, clearError, isEditing: record !== undefined })}
        </div>
      </div>

      <div className="form-actions">
        <span className="form-actions__spacer" />
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button button--primary" disabled={busy || organizationLocked}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}

// ─────────────────────────────── supplier ────────────────────────────────

export function SupplierForm({
  existing,
  onCancel,
  onSaved,
}: {
  readonly existing?: SupplierRecord
  readonly onCancel: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const { gateway, organization } = useAppRuntime()
  const [draft, setDraft] = useState<SupplierDraft>(
    existing === undefined ? EMPTY_SUPPLIER_DRAFT : supplierDraftFrom(existing),
  )

  return (
    <PartyFormShell<SupplierRecord, SupplierDraft>
      existing={existing}
      draft={draft}
      setDraft={setDraft}
      updatedAt={existing?.updatedAt}
      title={t('supplier.newSupplier')}
      validate={(value) =>
        value.displayName.trim() === ''
          ? { displayName: t('form.requiredField') }
          : ({} as Readonly<Record<string, string>>)
      }
      save={(record, value) =>
        record === undefined
          ? createSupplierRecord(gateway, organization.id, value)
          : updateSupplierRecord(gateway, organization.id, record, value)
      }
      reload={async (record) => {
        const fresh = await loadSupplier(gateway, organization.id, record.id)
        return { record: fresh, draft: supplierDraftFrom(fresh) }
      }}
      onCancel={onCancel}
      onSaved={onSaved}
      fields={({ fieldErrors, clearError, isEditing }) => (
        <>
          <TextField
            label={t('supplier.supplierName')}
            value={draft.displayName}
            error={fieldErrors.displayName}
            required
            autoFocus
            onChange={(value) => {
              setDraft({ ...draft, displayName: value })
              clearError('displayName')
            }}
          />
          <TextField
            label={t('supplier.externalRef')}
            hint={t('supplier.externalRefHint')}
            value={draft.externalRef}
            onChange={(value) => setDraft({ ...draft, externalRef: value })}
          />
          <TextAreaField
            label={t('common.notes')}
            value={draft.note}
            rows={3}
            wide
            onChange={(value) => setDraft({ ...draft, note: value })}
          />
          {isEditing ? <p className="field__hint">{t('lifecycle.changeFromList')}</p> : null}
        </>
      )}
    />
  )
}

// ─────────────────────────────── customer ────────────────────────────────

export function CustomerForm({
  existing,
  onCancel,
  onSaved,
}: {
  readonly existing?: CustomerRecord
  readonly onCancel: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const { gateway, organization } = useAppRuntime()
  const [draft, setDraft] = useState<CustomerDraft>(
    existing === undefined ? EMPTY_CUSTOMER_DRAFT : customerDraftFrom(existing),
  )
  const [statuses, setStatuses] = useState<readonly CustomerStatusRecord[]>([])
  const [statusFailure, setStatusFailure] = useState<unknown>(undefined)

  useEffect(() => {
    let cancelled = false
    void listCustomerStatuses(gateway, organization.id)
      .then((rows) => {
        if (!cancelled) {
          setStatuses(rows)
          setStatusFailure(undefined)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setStatusFailure(cause)
      })
    return () => {
      cancelled = true
    }
  }, [gateway, organization.id])

  return (
    <PartyFormShell<CustomerRecord, CustomerDraft>
      existing={existing}
      draft={draft}
      setDraft={setDraft}
      updatedAt={existing?.updatedAt}
      title={t('customer.newCustomer')}
      validate={(value) =>
        value.displayName.trim() === ''
          ? { displayName: t('form.requiredField') }
          : ({} as Readonly<Record<string, string>>)
      }
      save={(record, value) =>
        record === undefined
          ? createCustomerRecord(gateway, organization.id, value)
          : updateCustomerRecord(gateway, organization.id, record, value)
      }
      reload={async (record) => {
        const fresh = await loadCustomer(gateway, organization.id, record.id)
        return { record: fresh, draft: customerDraftFrom(fresh) }
      }}
      onCancel={onCancel}
      onSaved={onSaved}
      fields={({ fieldErrors, clearError, isEditing }) => (
        <>
          <TextField
            label={t('customer.displayName')}
            value={draft.displayName}
            error={fieldErrors.displayName}
            required
            autoFocus
            onChange={(value) => {
              setDraft({ ...draft, displayName: value })
              clearError('displayName')
            }}
          />
          <TextField
            label={t('customer.externalRef')}
            hint={t('customer.externalRefHint')}
            value={draft.externalRef}
            onChange={(value) => setDraft({ ...draft, externalRef: value })}
          />
          <SelectField
            label={t('customer.status')}
            hint={statusFailure === undefined ? t('customer.statusHint') : t('customer.statusUnavailable')}
            value={draft.customerStatusId}
            onChange={(value) => setDraft({ ...draft, customerStatusId: value })}
            options={[
              { value: '', label: t('customer.noStatus') },
              ...statuses
                .filter((status) => status.active || status.id === draft.customerStatusId)
                .map((status) => ({
                  value: status.id,
                  label: status.active ? status.code : `${status.code} (${t('common.inactive')})`,
                })),
            ]}
          />
          <TextAreaField
            label={t('common.notes')}
            value={draft.note}
            rows={3}
            wide
            onChange={(value) => setDraft({ ...draft, note: value })}
          />
          {isEditing ? <p className="field__hint">{t('lifecycle.changeFromList')}</p> : null}
          <p className="field__hint form-grid__wide">{t('customer.notACrm')}</p>
        </>
      )}
    />
  )
}
