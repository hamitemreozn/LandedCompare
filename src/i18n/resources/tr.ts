import type { TranslationResource } from './types'

const tr: TranslationResource = {
  app: {
    underDevelopment: 'Geliştirme aşamasında.',
    currentLanguage: 'Geçerli dil: {{language}}',
  },
  common: {
    appName: 'LandedCompare',
    save: 'Kaydet',
    cancel: 'İptal',
    delete: 'Sil',
    edit: 'Düzenle',
    add: 'Ekle',
    continue: 'Devam Et',
    back: 'Geri',
    loading: 'Yükleniyor',
    error: 'Hata',
    warning: 'Uyarı',
    yes: 'Evet',
    no: 'Hayır',
  },
  nav: {
    projects: 'Projeler',
    project: 'Proje',
    newProject: 'Yeni Proje',
    requirements: 'İhtiyaçlar',
    suppliers: 'Tedarikçiler',
    quotes: 'Teklifler',
    costs: 'Maliyetler',
    results: 'Sonuçlar',
  },
  supplier: {
    supplier: 'Tedarikçi',
    supplierName: 'Tedarikçi Adı',
  },
  quote: {
    quote: 'Teklif',
    currency: 'Para Birimi',
    unitPrice: 'Birim Fiyat',
    quantity: 'Miktar',
    requiredQuantity: 'İhtiyaç Miktarı',
    resolvedQuantity: 'Sipariş Miktarı',
    excessQuantity: 'Fazla Miktar',
    moq: 'Asgari Sipariş Miktarı (MOQ)',
    packSize: 'Paket Büyüklüğü',
  },
  costs: {
    freight: 'Navlun',
    insurance: 'Sigorta',
    customsDuty: 'Gümrük Vergisi',
    surcharge: 'Ek Ücret',
    discount: 'İskonto',
    additionalCost: 'Ek Maliyet',
    exchangeRate: 'Döviz Kuru',
  },
  comparison: {
    landedCost: 'Toplam İthal Maliyeti',
    lowestLandedCost: 'En Düşük Toplam İthal Maliyeti',
    incompleteQuote: 'Eksik Teklif',
    invalidQuote: 'Geçersiz Teklif',
    rank: 'Sıra',
    tied: 'Eşit',
    comparisonUnavailable: 'Karşılaştırma Yapılamıyor',
    suppliersCompared_one: '{{count}} tedarikçi karşılaştırıldı',
    suppliersCompared_other: '{{count}} tedarikçi karşılaştırıldı',
  },
  warnings: {
    allocationUnavailable:
      'Bu tedarikçi için maliyet dağıtımı hesaplanamadı; toplam tutar yine de güvenilirdir.',
  },
  issues: {
    missingQuote: 'Bu tedarikçi için teklif bulunmuyor.',
    emptyQuote: 'Teklifte hiçbir kalem yok.',
    missingRequiredItems: 'Teklif, ihtiyaç kalemlerinin tümünü kapsamıyor.',
    duplicateQuoteItem: 'Teklifte aynı ihtiyaç için birden fazla kalem var.',
    unknownRequirementReference: 'Teklif, projede bulunmayan bir ihtiyaca fiyat veriyor.',
    calculationError: 'Hesaplama sırasında bir hata oluştu.',
  },
  insights: {
    noComparableSuppliers: 'Karşılaştırılabilir tedarikçi yok.',
    onlyComparableSupplier:
      '{{supplierId}} karşılaştırılabilir tek tedarikçi (Toplam İthal Maliyeti: {{amount}}).',
    lowestCalculatedLandedCost: '{{supplierId}}, en düşük Toplam İthal Maliyetine sahip ({{amount}}).',
    tiedLowestCalculatedLandedCost:
      '{{count}} tedarikçi en düşük Toplam İthal Maliyetinde eşit ({{amount}}).',
    lowestMerchandiseNotLowestLandedCost:
      'En düşük mal bedeline sahip tedarikçi, en düşük Toplam İthal Maliyetine sahip değil.',
  },
  language: {
    tr: 'Türkçe',
    en: 'English',
  },
}

export default tr
