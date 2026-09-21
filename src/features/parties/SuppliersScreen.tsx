import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { SupportedLocale } from '../../i18n'
import type { SupplierRecord } from '../../persistence'
import { PartyScreen } from './PartyScreen'
import { SupplierForm } from './PartyForm'
import { listSuppliers, setSupplierActive } from './partyService'

export function SuppliersScreen({ locale }: { readonly locale: SupportedLocale }) {
  const { t } = useTranslation()

  const searchFields = useCallback(
    (record: SupplierRecord) => [record.displayName, record.note],
    [],
  )

  return (
    <PartyScreen<SupplierRecord>
      locale={locale}
      title={t('supplier.title')}
      subtitle={t('supplier.subtitle')}
      newLabel={t('supplier.newSupplier')}
      nameLabel={t('supplier.supplierName')}
      emptyTitle={t('supplier.emptyTitle')}
      emptyBody={t('supplier.emptyBody')}
      sortByNameLabel={t('supplier.sortByName')}
      sortByUpdatedLabel={t('supplier.sortByUpdated')}
      load={listSuppliers}
      searchFields={searchFields}
      setActive={setSupplierActive}
      renderForm={({ existing, onCancel, onSaved }) => (
        <SupplierForm existing={existing} onCancel={onCancel} onSaved={onSaved} />
      )}
    />
  )
}
