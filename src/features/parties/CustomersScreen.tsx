import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupportedLocale } from '../../i18n'
import type { CustomerRecord } from '../../persistence'
import { PartyScreen } from './PartyScreen'
import { CustomerForm } from './PartyForm'
import { listCustomers, setCustomerActive } from './partyService'

export function CustomersScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()

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
      renderForm={({ existing, onCancel, onSaved }) => (
        <CustomerForm existing={existing} onCancel={onCancel} onSaved={onSaved} />
      )}
    />
  )
}
