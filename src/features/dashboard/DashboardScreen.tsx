import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import { hrefFor } from '../../app/routes'
import { formatInstant } from '../../i18n/format'
import type { SupportedLocale } from '../../i18n'
import { Banner, EmptyState } from '../../ui/Feedback'
import { listProducts } from '../catalog/productService'
import { listCustomers, listSuppliers } from '../parties/partyService'
import { countActive, type ActiveCounts } from '../shared/masterData'
import { PageHeading } from '../shared/MasterDataPage'
import { errorCodeOf, useDataErrorMessage } from '../shared/useDataErrorMessage'

interface RecentEntry {
  readonly id: string
  readonly label: string
  readonly kind: string
  readonly updatedAt: string
}

interface Summary {
  readonly products: ActiveCounts
  readonly suppliers: ActiveCounts
  readonly customers: ActiveCounts
  readonly recent: readonly RecentEntry[]
}

export function DashboardScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()
  const runtime = useAppRuntime()
  const describeError = useDataErrorMessage()
  const [summary, setSummary] = useState<Summary>()
  const [error, setError] = useState<unknown>()

  const load = useCallback(async () => {
    try {
      const organizationId = runtime.organization.id
      const [products, suppliers, customers] = await Promise.all([
        listProducts(runtime.gateway, organizationId),
        listSuppliers(runtime.gateway, organizationId),
        listCustomers(runtime.gateway, organizationId),
      ])
      const recent: RecentEntry[] = [
        ...products.map((record) => ({ id: record.id, label: record.name, kind: t('product.one'), updatedAt: record.updatedAt })),
        ...suppliers.map((record) => ({ id: record.id, label: record.displayName, kind: t('supplier.supplier'), updatedAt: record.updatedAt })),
        ...customers.map((record) => ({ id: record.id, label: record.displayName, kind: t('customer.one'), updatedAt: record.updatedAt })),
      ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)).slice(0, 6)
      setSummary({
        products: countActive(products),
        suppliers: countActive(suppliers),
        customers: countActive(customers),
        recent,
      })
      setError(undefined)
    } catch (cause) {
      setError(cause)
    }
  }, [runtime.gateway, runtime.organization.id, t])

  useEffect(() => { void load() }, [load])

  const cards: readonly { label: string; counts: ActiveCounts; href: string }[] = summary === undefined ? [] : [
    { label: t('dashboard.products'), counts: summary.products, href: hrefFor('products') },
    { label: t('dashboard.suppliers'), counts: summary.suppliers, href: hrefFor('suppliers') },
    { label: t('dashboard.customers'), counts: summary.customers, href: hrefFor('customers') },
  ]
  const nothingYet = summary !== undefined && summary.products.total + summary.suppliers.total + summary.customers.total === 0

  return (
    <div className="page">
      <PageHeading title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />
      {runtime.organizationLocked ? (
        <Banner tone="warning" label={t('common.warning')}>{t('cloudError.organizationLocked')}</Banner>
      ) : null}
      {error !== undefined ? (
        <Banner tone="danger" label={t('common.error')} note={errorCodeOf(error) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(error)}`} actions={
          <button type="button" className="button button--small" onClick={() => void load()}>{t('common.retry')}</button>
        }>{describeError(error)}</Banner>
      ) : null}
      {summary === undefined ? <p className="text-muted">{t('common.loading')}</p> : (
        <>
          <div className="stat-grid">
            {cards.map((card) => (
              <a className="stat" key={card.href} href={card.href}>
                <span className="stat__label">{card.label}</span>
                <span className="stat__value">{card.counts.total}</span>
                <span className="stat__meta">{t('dashboard.activeOfTotal', { active: card.counts.active, total: card.counts.total })}</span>
              </a>
            ))}
          </div>
          <section className="card">
            <div className="card__header"><h2 className="card__title">{t('dashboard.recentlyUpdated')}</h2></div>
            {nothingYet ? <EmptyState title={t('dashboard.nothingYet')} body={t('dashboard.nothingYetHint')} /> : (
              <div className="table-wrap"><table className="table">
                <caption className="visually-hidden">{t('dashboard.recentlyUpdated')}</caption>
                <thead><tr><th scope="col">{t('dashboard.recordType')}</th><th scope="col">{t('dashboard.recordName')}</th><th scope="col">{t('form.updatedAt')}</th></tr></thead>
                <tbody>{summary.recent.map((entry) => <tr key={`${entry.kind}-${entry.id}`}><td className="text-muted">{entry.kind}</td><td className="table__primary">{entry.label}</td><td className="text-muted">{formatInstant(entry.updatedAt, locale)}</td></tr>)}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
      <section className="card">
        <div className="card__header"><h2 className="card__title">{t('dashboard.cloudData')}</h2></div>
        <div className="card__body"><dl className="detail-list">
          <div className="detail-list__row"><dt className="detail-list__term">{t('dashboard.organization')}</dt><dd className="detail-list__value">{runtime.organization.name}</dd></div>
          <div className="detail-list__row"><dt className="detail-list__term">{t('dashboard.role')}</dt><dd className="detail-list__value detail-list__value--mono">{runtime.role}</dd></div>
          <div className="detail-list__row"><dt className="detail-list__term">{t('dashboard.source')}</dt><dd className="detail-list__value">{t('dashboard.cloudAuthoritative')}</dd></div>
        </dl></div>
      </section>
    </div>
  )
}
