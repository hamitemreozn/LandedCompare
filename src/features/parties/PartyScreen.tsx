/**
 * The shared list screen for the two party masters.
 *
 * Suppliers and customers are the same record with one field's difference, so
 * their screens are the same screen with one column's difference. Writing it
 * once is not premature abstraction here — it is the alternative to two files
 * that start identical and drift, which is how the third one ends up behaving
 * differently from the other two for no reason anybody can name.
 *
 * The generic is constrained to "has an id, an active flag, an `updatedAt` and
 * a `displayName`", which is exactly the shape both records share and exactly
 * what this component reads. Everything else — the extra column, the form —
 * arrives as a prop from the screen that owns it.
 */

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { DataGateway } from '../../cloud'
import type { SupportedLocale } from '../../i18n'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Banner, EmptyState, StatusBadge } from '../../ui/Feedback'
import { compareText, compareUpdatedAtDescending } from '../shared/masterData'
import { ListToolbar, PageHeading, ResultCount, type SortOption } from '../shared/MasterDataPage'
import { errorCodeOf, useDataErrorMessage } from '../shared/useDataErrorMessage'
import {
  useMasterDataList,
  type MasterDataRecord,
  type SortComparator,
} from '../shared/useMasterDataList'

export interface PartyRecordShape extends MasterDataRecord {
  readonly displayName: string
  readonly note?: string
}

export interface PartyScreenProps<T extends PartyRecordShape> {
  readonly locale: SupportedLocale
  readonly title: string
  readonly subtitle: string
  readonly newLabel: string
  readonly nameLabel: string
  readonly emptyTitle: string
  readonly emptyBody: string
  readonly footnote?: string
  readonly sortByNameLabel: string
  readonly sortByUpdatedLabel: string
  readonly load: (gateway: DataGateway, organizationId: string) => Promise<readonly T[]>
  readonly searchFields: (record: T) => readonly (string | undefined)[]
  readonly setActive: (
    gateway: DataGateway,
    organizationId: string,
    record: T,
    active: boolean,
  ) => Promise<unknown>
  /** An optional second column, e.g. the customer's external reference. */
  readonly secondaryColumn?: {
    readonly header: string
    readonly render: (record: T) => ReactNode
  }
  readonly tertiaryColumn?: {
    readonly header: string
    readonly render: (record: T) => ReactNode
  }
  readonly renderForm: (args: {
    readonly existing?: T
    readonly onCancel: () => void
    readonly onSaved: () => void
  }) => ReactNode
}

type View<T> = { mode: 'LIST' } | { mode: 'CREATE' } | { mode: 'EDIT'; record: T }

export function PartyScreen<T extends PartyRecordShape>(props: PartyScreenProps<T>) {
  const { t } = useTranslation()
  const { gateway, organization, organizationLocked } = useAppRuntime()
  const describeError = useDataErrorMessage()

  const [view, setView] = useState<View<T>>({ mode: 'LIST' })
  const [pending, setPending] = useState<T | undefined>(undefined)
  const [actionError, setActionError] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)

  const sorts = useMemo<Readonly<Record<string, SortComparator<T>>>>(
    () => ({
      name: (a, b, locale) => compareText(a.displayName, b.displayName, locale),
      updated: compareUpdatedAtDescending,
    }),
    [],
  )

  const list = useMasterDataList<T>({
    load: props.load,
    searchFields: props.searchFields,
    sorts,
    defaultSort: 'name',
    locale: props.locale,
  })

  const sortOptions: readonly SortOption[] = useMemo(
    () => [
      { id: 'name', label: props.sortByNameLabel },
      { id: 'updated', label: props.sortByUpdatedLabel },
    ],
    [props.sortByNameLabel, props.sortByUpdatedLabel],
  )

  const confirmLifecycleChange = async () => {
    if (pending === undefined) {
      return
    }
    setBusy(true)
    try {
      await props.setActive(gateway, organization.id, pending, !pending.active)
      setActionError(undefined)
      setPending(undefined)
      await list.reload()
    } catch (cause) {
      setActionError(cause)
      setPending(undefined)
    } finally {
      setBusy(false)
    }
  }

  if (view.mode !== 'LIST') {
    return (
      <div className="page">
        <PageHeading title={props.title} subtitle={props.subtitle} />
        {props.renderForm({
          existing: view.mode === 'EDIT' ? view.record : undefined,
          onCancel: () => setView({ mode: 'LIST' }),
          onSaved: () => {
            setView({ mode: 'LIST' })
            void list.reload()
          },
        })}
      </div>
    )
  }

  const isEmptyMaster = list.status === 'READY' && list.all.length === 0
  const hasRecords = list.status === 'READY' && list.all.length > 0

  const newButton = (
    <button
      type="button"
      className="button button--primary"
      onClick={() => setView({ mode: 'CREATE' })}
      disabled={organizationLocked}
    >
      {props.newLabel}
    </button>
  )

  return (
    <div className="page">
      {/* While the master is empty the empty state carries the action, so the
          header does not offer a second copy of the same button. */}
      <PageHeading
        title={props.title}
        subtitle={props.subtitle}
        action={hasRecords ? newButton : undefined}
      />

      {list.status === 'ERROR' ? (
        <Banner
          tone="danger"
          label={t('common.error')}
          note={
            errorCodeOf(list.loadError) === undefined
              ? undefined
              : `${t('boot.errorCode')}: ${errorCodeOf(list.loadError)}`
          }
          actions={
            <button type="button" className="button button--small" onClick={() => void list.reload()}>
              {t('common.retry')}
            </button>
          }
        >
          {describeError(list.loadError)}
        </Banner>
      ) : null}

      {actionError !== undefined ? (
        <Banner tone="danger" label={t('form.saveFailed')}>
          {describeError(actionError)}
        </Banner>
      ) : null}

      {list.status === 'LOADING' ? (
        <div className="card">
          <p className="card__body text-muted">{t('common.loading')}</p>
        </div>
      ) : isEmptyMaster ? (
        <div className="card">
          <EmptyState title={props.emptyTitle} body={props.emptyBody} action={newButton} />
        </div>
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
            <>
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{props.title}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{props.nameLabel}</th>
                      {props.secondaryColumn !== undefined ? (
                        <th scope="col">{props.secondaryColumn.header}</th>
                      ) : null}
                      {props.tertiaryColumn !== undefined ? (
                        <th scope="col">{props.tertiaryColumn.header}</th>
                      ) : null}
                      <th scope="col">{t('common.notes')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.visible.map((record) => (
                      <tr key={record.id} data-inactive={!record.active}>
                        <td>
                          <span className="table__primary">{record.displayName}</span>
                        </td>
                        {props.secondaryColumn !== undefined ? (
                          <td className="table__mono">{props.secondaryColumn.render(record)}</td>
                        ) : null}
                        {props.tertiaryColumn !== undefined ? (
                          <td>{props.tertiaryColumn.render(record)}</td>
                        ) : null}
                        <td className="text-muted">{record.note ?? '—'}</td>
                        <td>
                          <StatusBadge
                            active={record.active}
                            activeLabel={t('common.active')}
                            inactiveLabel={t('common.inactive')}
                          />
                        </td>
                        <td>
                          <div className="table__actions">
                            <button
                              type="button"
                              className="button button--small"
                              onClick={() => setView({ mode: 'EDIT', record })}
                            >
                              {t('common.edit')}
                            </button>
                            <button
                              type="button"
                              className="button button--small button--ghost"
                              onClick={() => setPending(record)}
                            >
                              {record.active ? t('lifecycle.deactivate') : t('lifecycle.activate')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card__body">
                <ResultCount shown={list.visible.length} total={list.all.length} />
                {props.footnote !== undefined ? (
                  <p className="field__hint">{props.footnote}</p>
                ) : null}
              </div>
            </>
          )}
        </section>
      )}

      {pending !== undefined ? (
        <ConfirmDialog
          title={
            pending.active
              ? t('lifecycle.deactivateTitle', { name: pending.displayName })
              : t('lifecycle.activateTitle', { name: pending.displayName })
          }
          body={pending.active ? t('lifecycle.deactivateBody') : t('lifecycle.activateBody')}
          note={pending.active ? t('lifecycle.notADeletion') : undefined}
          confirmLabel={pending.active ? t('lifecycle.deactivate') : t('lifecycle.activate')}
          cancelLabel={t('common.cancel')}
          busy={busy}
          onConfirm={() => void confirmLifecycleChange()}
          onCancel={() => setPending(undefined)}
        />
      ) : null}
    </div>
  )
}
