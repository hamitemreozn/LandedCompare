/**
 * The overview screen.
 *
 * Deliberately modest. It answers one question — *the application opened;
 * what is in my local database?* — and it answers it with counts and facts.
 * There are no charts, because there is nothing yet whose shape over time
 * means anything, and a chart of three integers is decoration pretending to be
 * insight. Analytics is not a Phase 9 deliverable and building the
 * infrastructure for it "while we are here" is how a dashboard becomes the
 * most expensive screen in a product nobody uses it in.
 *
 * What it does carry, because the application shell is the only place it can
 * live honestly, is the state of the recovery layer: where this data
 * physically is, whether the browser promised to keep it, whether today's
 * internal snapshot exists, and when a real backup file was last exported.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import { hrefFor } from '../../app/routes'
import { EXTERNAL_BACKUP_STALE_AFTER_DAYS } from '../../backup'
import { formatInstant } from '../../i18n/format'
import type { SupportedLocale } from '../../i18n'
import { EXTERNAL_BACKUP_STATE_TRANSLATION_KEY } from '../../i18n/persistenceText'
import { SCHEMA_VERSION } from '../../persistence'
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

  const [summary, setSummary] = useState<Summary | undefined>(undefined)
  const [error, setError] = useState<unknown>(undefined)

  const load = useCallback(async () => {
    try {
      // Three reads rather than one transaction over three stores: this is a
      // display, not a decision. Nothing here is compared against anything
      // else, so a coherent cross-store snapshot would buy a guarantee no
      // reader of this screen can use. Where coherence *does* matter — a
      // backup, a snapshot — `readBusinessData` opens exactly one transaction.
      const [products, suppliers, customers] = await Promise.all([
        listProducts(runtime.database),
        listSuppliers(runtime.database),
        listCustomers(runtime.database),
      ])

      const recent: RecentEntry[] = [
        ...products.map((record) => ({
          id: record.id,
          label: record.name,
          kind: t('product.one'),
          updatedAt: record.updatedAt,
        })),
        ...suppliers.map((record) => ({
          id: record.id,
          label: record.displayName,
          kind: t('supplier.supplier'),
          updatedAt: record.updatedAt,
        })),
        ...customers.map((record) => ({
          id: record.id,
          label: record.displayName,
          kind: t('customer.one'),
          updatedAt: record.updatedAt,
        })),
      ]
        .sort((a, b) =>
          a.updatedAt === b.updatedAt
            ? a.id < b.id
              ? -1
              : 1
            : a.updatedAt < b.updatedAt
              ? 1
              : -1,
        )
        .slice(0, 6)

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
  }, [runtime.database, t])

  useEffect(() => {
    void load()
  }, [load])

  const backupTone = runtime.backup.state === 'FRESH' ? 'info' : 'warning'
  const backupMessage = t(EXTERNAL_BACKUP_STATE_TRANSLATION_KEY[runtime.backup.state], {
    days: runtime.backup.ageDays ?? 0,
    staleAfterDays: runtime.backup.staleAfterDays ?? EXTERNAL_BACKUP_STALE_AFTER_DAYS,
  })

  const snapshotLine = useMemo(() => {
    if (runtime.maintenance === undefined) {
      return t('dashboard.snapshotUnavailable')
    }
    return runtime.maintenance.daily.created
      ? t('dashboard.snapshotTakenToday')
      : t('dashboard.snapshotAlreadyToday')
  }, [runtime.maintenance, t])

  const storageLine =
    runtime.storage === 'PERSISTED'
      ? t('dashboard.storagePersisted')
      : runtime.storage === 'NOT_PERSISTED'
        ? t('dashboard.storageNotPersisted')
        : t('dashboard.storageUnsupported')

  const origin = typeof window === 'undefined' ? t('common.unknown') : window.location.origin

  const cards: readonly { label: string; counts: ActiveCounts; href: string }[] =
    summary === undefined
      ? []
      : [
          { label: t('dashboard.products'), counts: summary.products, href: hrefFor('products') },
          { label: t('dashboard.suppliers'), counts: summary.suppliers, href: hrefFor('suppliers') },
          { label: t('dashboard.customers'), counts: summary.customers, href: hrefFor('customers') },
        ]

  const nothingYet =
    summary !== undefined &&
    summary.products.total + summary.suppliers.total + summary.customers.total === 0

  return (
    <div className="page">
      <PageHeading title={t('dashboard.title')} subtitle={t('dashboard.subtitle')} />

      {error !== undefined ? (
        <Banner
          tone="danger"
          label={t('common.error')}
          note={
            errorCodeOf(error) === undefined ? undefined : `${t('boot.errorCode')}: ${errorCodeOf(error)}`
          }
          actions={
            <button type="button" className="button button--small" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          }
        >
          {describeError(error)}
        </Banner>
      ) : null}

      <Banner
        tone={backupTone}
        label={t('backupStatus.label')}
        note={`${t('backupStatus.snapshotIsNotBackup')} ${t('backupStatus.exportComingLater')}`}
      >
        {backupMessage}
      </Banner>

      {summary === undefined ? (
        <p className="text-muted">{t('common.loading')}</p>
      ) : (
        <>
          <div className="stat-grid">
            {cards.map((card) => (
              <a className="stat" key={card.label} href={card.href}>
                <span className="stat__label">{card.label}</span>
                <span className="stat__value">{card.counts.total}</span>
                <span className="stat__meta">
                  {t('dashboard.activeOfTotal', {
                    active: card.counts.active,
                    total: card.counts.total,
                  })}
                </span>
              </a>
            ))}
          </div>

          <section className="card">
            <div className="card__header">
              <h2 className="card__title">{t('dashboard.recentlyUpdated')}</h2>
            </div>
            {nothingYet ? (
              <EmptyState title={t('dashboard.nothingYet')} body={t('dashboard.nothingYetHint')} />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">{t('dashboard.recentlyUpdated')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('dashboard.recordType')}</th>
                      <th scope="col">{t('dashboard.recordName')}</th>
                      <th scope="col">{t('form.updatedAt')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recent.map((entry) => (
                      <tr key={`${entry.kind}-${entry.id}`}>
                        <td className="text-muted">{entry.kind}</td>
                        <td className="table__primary">{entry.label}</td>
                        <td className="text-muted">{formatInstant(entry.updatedAt, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <section className="card">
        <div className="card__header">
          <h2 className="card__title">{t('dashboard.localData')}</h2>
        </div>
        <div className="card__body">
          <dl className="detail-list">
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('dashboard.database')}</dt>
              <dd className="detail-list__value detail-list__value--mono">
                {runtime.database.name}
              </dd>
            </div>
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('dashboard.schemaVersion')}</dt>
              <dd className="detail-list__value detail-list__value--mono">{SCHEMA_VERSION}</dd>
            </div>
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('dashboard.origin')}</dt>
              <dd className="detail-list__value detail-list__value--mono">{origin}</dd>
            </div>
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('dashboard.storage')}</dt>
              <dd className="detail-list__value">{storageLine}</dd>
            </div>
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('dashboard.snapshots')}</dt>
              <dd className="detail-list__value">{snapshotLine}</dd>
            </div>
            <div className="detail-list__row">
              <dt className="detail-list__term">{t('backupStatus.lastExport')}</dt>
              <dd className="detail-list__value">
                {runtime.backup.lastExternalBackupAt === undefined
                  ? '—'
                  : formatInstant(runtime.backup.lastExternalBackupAt, locale)}
              </dd>
            </div>
          </dl>
          <p className="field__hint">{t('dashboard.originHint')}</p>
        </div>
      </section>
    </div>
  )
}
