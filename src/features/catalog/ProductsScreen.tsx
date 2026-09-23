/**
 * The product catalog screen.
 *
 * List → form → list, with the form replacing the list rather than floating
 * over it. A modal would have meant a focus trap, a scroll lock and a dialog
 * large enough to need its own scrolling; swapping the content region costs
 * none of that and keeps the whole record visible at once, which for a
 * ten-field form on a desktop is simply better.
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { ProductRecord } from '../../cloud'
import type { SupportedLocale } from '../../i18n'
import { ConfirmDialog } from '../../ui/ConfirmDialog'
import { Banner, EmptyState, StatusBadge } from '../../ui/Feedback'
import { compareText, compareUpdatedAtDescending } from '../shared/masterData'
import { unitLabel } from '../shared/units'
import { ListToolbar, PageHeading, ResultCount, type SortOption } from '../shared/MasterDataPage'
import { errorCodeOf, useDataErrorMessage } from '../shared/useDataErrorMessage'
import { useMasterDataList, type SortComparator } from '../shared/useMasterDataList'
import { ProductForm } from './ProductForm'
import {
  EMPTY_PRODUCT_DRAFT,
  listProducts,
  productDraftFrom,
  setProductActive,
} from './productService'

const SORTS: Readonly<Record<string, SortComparator<ProductRecord>>> = {
  name: (a, b, locale) => compareText(a.name, b.name, locale) || compareText(a.sku, b.sku, locale),
  sku: (a, b, locale) => compareText(a.sku, b.sku, locale),
  updated: compareUpdatedAtDescending,
}

type View =
  | { readonly mode: 'LIST' }
  | { readonly mode: 'CREATE' }
  | { readonly mode: 'EDIT'; readonly record: ProductRecord }

export function ProductsScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()
  const { gateway, organization, organizationLocked } = useAppRuntime()
  const describeError = useDataErrorMessage()

  const [view, setView] = useState<View>({ mode: 'LIST' })
  const [pending, setPending] = useState<ProductRecord | undefined>(undefined)
  const [actionError, setActionError] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)

  const searchFields = useCallback(
    (record: ProductRecord) => [
      record.sku,
      record.name,
      record.manufacturer,
      record.manufacturerRef,
      // Searched by what is on screen, not by the code behind it: a user
      // looking for "kutu" has never seen the string `BOX`.
      unitLabel(record.stockUnit, t),
    ],
    [t],
  )

  const list = useMasterDataList<ProductRecord>({
    load: listProducts,
    searchFields,
    sorts: SORTS,
    defaultSort: 'name',
    locale,
  })

  const sortOptions: readonly SortOption[] = useMemo(
    () => [
      { id: 'name', label: t('product.sortByName') },
      { id: 'sku', label: t('product.sortBySku') },
      { id: 'updated', label: t('product.sortByUpdated') },
    ],
    [t],
  )

  const confirmLifecycleChange = async () => {
    if (pending === undefined) {
      return
    }
    setBusy(true)
    try {
      await setProductActive(gateway, organization.id, pending, !pending.active)
      setActionError(undefined)
      setPending(undefined)
      // Read the stored truth back rather than assuming the write landed the
      // way the screen expected it to.
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
        <PageHeading title={t('product.title')} subtitle={t('product.subtitle')} />
        <ProductForm
          existing={view.mode === 'EDIT' ? view.record : undefined}
          locale={locale}
          initialDraft={
            view.mode === 'EDIT' ? productDraftFrom(view.record, locale) : EMPTY_PRODUCT_DRAFT
          }
          onCancel={() => setView({ mode: 'LIST' })}
          onSaved={() => {
            setView({ mode: 'LIST' })
            void list.reload()
          }}
        />
      </div>
    )
  }

  const isEmptyCatalog = list.status === 'READY' && list.all.length === 0
  const hasRecords = list.status === 'READY' && list.all.length > 0

  const newButton = (
    <button
      type="button"
      className="button button--primary"
      onClick={() => setView({ mode: 'CREATE' })}
      disabled={organizationLocked}
    >
      {t('product.newProduct')}
    </button>
  )

  return (
    <div className="page">
      {/* While the catalogue is empty the empty state carries the action, so
          the header does not offer a second copy of the same button. */}
      <PageHeading
        title={t('product.title')}
        subtitle={t('product.subtitle')}
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
      ) : isEmptyCatalog ? (
        <div className="card">
          <EmptyState
            title={t('product.emptyTitle')}
            body={t('product.emptyBody')}
            action={newButton}
          />
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
                  <caption className="visually-hidden">{t('product.title')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('product.sku')}</th>
                      <th scope="col">{t('product.name')}</th>
                      <th scope="col">{t('product.stockUnit')}</th>
                      <th scope="col">{t('common.status')}</th>
                      <th scope="col">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.visible.map((record) => (
                      <tr key={record.id} data-inactive={!record.active}>
                        <td className="table__mono">{record.sku}</td>
                        <td>
                          <span className="table__primary">{record.name}</span>
                          {record.manufacturer !== undefined ? (
                            <span className="table__secondary">
                              {record.manufacturer}
                              {record.manufacturerRef !== undefined
                                ? ` · ${record.manufacturerRef}`
                                : ''}
                            </span>
                          ) : null}
                        </td>
                        {/* A canonical unit reads in the current language; a
                            company's own unit reads exactly as it was typed. */}
                        <td>{unitLabel(record.stockUnit, t)}</td>
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
              </div>
            </>
          )}
        </section>
      )}

      {pending !== undefined ? (
        <ConfirmDialog
          title={
            pending.active
              ? t('lifecycle.deactivateTitle', { name: pending.name })
              : t('lifecycle.activateTitle', { name: pending.name })
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
