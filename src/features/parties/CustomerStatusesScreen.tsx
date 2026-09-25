import { useCallback, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { CustomerStatusRecord } from '../../cloud'
import type { SupportedLocale } from '../../i18n'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { TextField } from '../../ui/Field'
import { Banner, EmptyState, StatusBadge } from '../../ui/Feedback'
import { compareText } from '../shared/masterData'
import { ListToolbar, PageHeading, ResultCount, type SortOption } from '../shared/MasterDataPage'
import { isFormValidationError } from '../shared/formError'
import { errorCodeOf, useDataErrorMessage } from '../shared/useDataErrorMessage'
import { useMasterDataList, type SortComparator } from '../shared/useMasterDataList'
import {
  createCustomerStatus,
  customerStatusDraftFrom,
  EMPTY_CUSTOMER_STATUS_DRAFT,
  listCustomerStatuses,
  setCustomerStatusActive,
  updateCustomerStatus,
  type CustomerStatusDraft,
} from './customerStatusService'

const SORTS: Readonly<Record<string, SortComparator<CustomerStatusRecord>>> = {
  order: (a, b, locale) => a.sortOrder - b.sortOrder || compareText(a.code, b.code, locale),
  code: (a, b, locale) => compareText(a.code, b.code, locale),
}

type View =
  | { readonly mode: 'LIST' }
  | { readonly mode: 'CREATE' }
  | { readonly mode: 'EDIT'; readonly record: CustomerStatusRecord }

function StatusForm({
  existing,
  onCancel,
  onSaved,
}: {
  readonly existing?: CustomerStatusRecord
  readonly onCancel: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const { gateway, organization, organizationLocked } = useAppRuntime()
  const describeError = useDataErrorMessage()
  const [draft, setDraft] = useState<CustomerStatusDraft>(
    existing === undefined ? EMPTY_CUSTOMER_STATUS_DRAFT : customerStatusDraftFrom(existing),
  )
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({})
  const [failure, setFailure] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (draft.code.trim() === '') {
      setErrors({ code: t('form.requiredField') })
      return
    }
    setBusy(true)
    setFailure(undefined)
    try {
      if (existing === undefined) {
        await createCustomerStatus(gateway, organization.id, draft)
      } else {
        await updateCustomerStatus(gateway, organization.id, existing, draft)
      }
      onSaved()
    } catch (cause) {
      if (isFormValidationError(cause)) {
        setErrors({ [cause.field]: t(cause.messageKey) })
      } else {
        setFailure(cause)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={(event) => void submit(event)} noValidate>
      <div className="card__header">
        <h2 className="card__title">
          {existing === undefined ? t('customerStatus.newStatus') : t('form.editRecord')}
        </h2>
      </div>
      <div className="card__body">
        {failure !== undefined ? (
          <Banner
            tone="danger"
            label={t('form.saveFailed')}
            note={errorCodeOf(failure) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(failure)}`}
          >
            {describeError(failure)}
          </Banner>
        ) : null}
        <div className="form-grid">
          <TextField
            label={t('customerStatus.code')}
            value={draft.code}
            error={errors.code}
            required
            autoFocus
            onChange={(code) => {
              setDraft({ ...draft, code })
              setErrors({})
            }}
          />
          <TextField
            label={t('customerStatus.sortOrder')}
            value={draft.sortOrder}
            error={errors.sortOrder}
            hint={t('customerStatus.sortOrderHint')}
            onChange={(sortOrder) => {
              setDraft({ ...draft, sortOrder })
              setErrors({})
            }}
          />
        </div>
        <p className="field__hint">{t('customerStatus.hint')}</p>
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

export function CustomerStatusesScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()
  const { gateway, organization, organizationLocked } = useAppRuntime()
  const describeError = useDataErrorMessage()
  const [view, setView] = useState<View>({ mode: 'LIST' })
  const [pending, setPending] = useState<CustomerStatusRecord | undefined>()
  const [actionError, setActionError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const searchFields = useCallback((record: CustomerStatusRecord) => [record.code], [])
  const list = useMasterDataList<CustomerStatusRecord>({
    load: listCustomerStatuses,
    searchFields,
    sorts: SORTS,
    defaultSort: 'order',
    locale,
  })
  const sortOptions = useMemo<readonly SortOption[]>(
    () => [
      { id: 'order', label: t('customerStatus.sortByOrder') },
      { id: 'code', label: t('customerStatus.sortByCode') },
    ],
    [t],
  )

  if (view.mode !== 'LIST') {
    return (
      <div className="page">
        <PageHeading title={t('customerStatus.title')} subtitle={t('customerStatus.subtitle')} />
        <StatusForm
          existing={view.mode === 'EDIT' ? view.record : undefined}
          onCancel={() => setView({ mode: 'LIST' })}
          onSaved={() => {
            setView({ mode: 'LIST' })
            void list.reload()
          }}
        />
      </div>
    )
  }

  const changeActive = async () => {
    if (pending === undefined) return
    setBusy(true)
    try {
      await setCustomerStatusActive(gateway, organization.id, pending, !pending.active)
      setPending(undefined)
      setActionError(undefined)
      await list.reload()
    } catch (cause) {
      setActionError(cause)
      setPending(undefined)
    } finally {
      setBusy(false)
    }
  }

  const addButton = (
    <button
      type="button"
      className="button button--primary"
      onClick={() => setView({ mode: 'CREATE' })}
      disabled={organizationLocked}
    >
      {t('customerStatus.newStatus')}
    </button>
  )

  return (
    <div className="page">
      <PageHeading
        title={t('customerStatus.title')}
        subtitle={t('customerStatus.subtitle')}
        action={list.all.length > 0 ? addButton : undefined}
      />
      {list.status === 'ERROR' ? (
        <Banner tone="danger" label={t('common.error')} actions={
          <button type="button" className="button button--small" onClick={() => void list.reload()}>
            {t('common.retry')}
          </button>
        }>{describeError(list.loadError)}</Banner>
      ) : null}
      {actionError !== undefined ? (
        <Banner tone="danger" label={t('form.saveFailed')}>{describeError(actionError)}</Banner>
      ) : null}
      {list.status === 'LOADING' ? (
        <div className="card"><p className="card__body text-muted">{t('common.loading')}</p></div>
      ) : list.all.length === 0 ? (
        <div className="card"><EmptyState title={t('customerStatus.emptyTitle')} body={t('customerStatus.emptyBody')} action={addButton} /></div>
      ) : (
        <section className="card">
          <ListToolbar
            search={list.search}
            onSearchChange={list.setSearch}
            filter={list.filter}
            onFilterChange={list.setFilter}
            sort={list.sort}
            onSortChange={list.setSort}
            sortOptions={sortOptions}
            searchLabel={t('common.search')}
          />
          {list.visible.length === 0 ? (
            <EmptyState title={t('list.noResults')} body={t('list.noResultsHint')} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="visually-hidden">{t('customerStatus.title')}</caption>
                <thead><tr>
                  <th scope="col">{t('customerStatus.code')}</th>
                  <th scope="col">{t('customerStatus.sortOrder')}</th>
                  <th scope="col">{t('common.status')}</th>
                  <th scope="col">{t('common.actions')}</th>
                </tr></thead>
                <tbody>{list.visible.map((record) => (
                  <tr key={record.id} data-inactive={!record.active}>
                    <td className="table__primary">{record.code}</td>
                    <td className="table__mono">{record.sortOrder}</td>
                    <td><StatusBadge active={record.active} activeLabel={t('common.active')} inactiveLabel={t('common.inactive')} /></td>
                    <td><div className="table__actions">
                      <button type="button" className="button button--small" onClick={() => setView({ mode: 'EDIT', record })} disabled={organizationLocked}>{t('common.edit')}</button>
                      <button type="button" className="button button--small" onClick={() => setPending(record)} disabled={organizationLocked}>{record.active ? t('lifecycle.deactivate') : t('lifecycle.activate')}</button>
                    </div></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
          <div className="card__body">
            <ResultCount shown={list.visible.length} total={list.all.length} />
          </div>
        </section>
      )}
      {pending !== undefined ? (
        <ConfirmDialog
          title={pending.active ? t('lifecycle.deactivateTitle', { name: pending.code }) : t('lifecycle.activateTitle', { name: pending.code })}
          body={pending.active ? t('customerStatus.deactivateBody') : t('lifecycle.activateBody')}
          note={t('customerStatus.historicalNote')}
          confirmLabel={pending.active ? t('lifecycle.deactivate') : t('lifecycle.activate')}
          cancelLabel={t('common.cancel')}
          onConfirm={() => void changeActive()}
          onCancel={() => setPending(undefined)}
          busy={busy}
        />
      ) : null}
    </div>
  )
}
