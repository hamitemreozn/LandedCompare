import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { CustomerRecord, CustomerStatusRecord } from '../../cloud'
import type { SupportedLocale } from '../../i18n'
import { PartyScreen } from './PartyScreen'
import { CustomerForm } from './PartyForm'
import { listCustomers, setCustomerActive } from './partyService'
import { listCustomerStatuses } from './customerStatusService'

export function CustomersScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()
  const { gateway, organization } = useAppRuntime()
  const [statuses, setStatuses] = useState<readonly CustomerStatusRecord[]>([])

  useEffect(() => {
    let cancelled = false
    void listCustomerStatuses(gateway, organization.id).then((rows) => {
      if (!cancelled) setStatuses(rows)
    }).catch(() => {
      if (!cancelled) setStatuses([])
    })
    return () => {
      cancelled = true
    }
  }, [gateway, organization.id])

  const statusById = useMemo(
    () => new Map(statuses.map((status) => [status.id, status])),
    [statuses],
  )

  const searchFields = useCallback(
    (record: CustomerRecord) => [record.displayName, record.externalRef, record.note],
    [],
  )

  return (
    <PartyScreen<CustomerRecord>
      locale={locale}
      title={t('customer.title')}
      subtitle={t('customer.subtitle')}
      newLabel={t('customer.newCustomer')}
      nameLabel={t('customer.displayName')}
      emptyTitle={t('customer.emptyTitle')}
      emptyBody={t('customer.emptyBody')}
      footnote={t('customer.notACrm')}
      sortByNameLabel={t('customer.sortByName')}
      sortByUpdatedLabel={t('customer.sortByUpdated')}
      load={listCustomers}
      searchFields={searchFields}
      setActive={setCustomerActive}
      secondaryColumn={{
        header: t('customer.externalRef'),
        render: (record) => record.externalRef ?? '—',
      }}
      tertiaryColumn={{
        header: t('customer.status'),
        render: (record) => {
          if (record.customerStatusId === undefined) return '—'
          const status = statusById.get(record.customerStatusId)
          if (status === undefined) return t('common.unknown')
          return status.active ? status.code : `${status.code} (${t('common.inactive')})`
        },
      }}
      renderForm={({ existing, onCancel, onSaved }) => (
        <CustomerForm existing={existing} onCancel={onCancel} onSaved={onSaved} />
      )}
    />
  )
}
