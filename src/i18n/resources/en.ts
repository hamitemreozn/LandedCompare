import type { TranslationResource } from './types'

const en: TranslationResource = {
  app: {
    underDevelopment: 'Under development.',
    currentLanguage: 'Current language: {{language}}',
  },
  common: {
    appName: 'LandedCompare',
    save: 'Save',
    cancel: 'Cancel',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    continue: 'Continue',
    back: 'Back',
    loading: 'Loading',
    error: 'Error',
    warning: 'Warning',
    yes: 'Yes',
    no: 'No',
  },
  nav: {
    projects: 'Projects',
    project: 'Project',
    newProject: 'New Project',
    requirements: 'Requirements',
    suppliers: 'Suppliers',
    quotes: 'Quotes',
    costs: 'Costs',
    results: 'Results',
  },
  supplier: {
    supplier: 'Supplier',
    supplierName: 'Supplier Name',
  },
  quote: {
    quote: 'Quote',
    currency: 'Currency',
    unitPrice: 'Unit Price',
    quantity: 'Quantity',
    requiredQuantity: 'Required Quantity',
    resolvedQuantity: 'Resolved Quantity',
    excessQuantity: 'Excess Quantity',
    moq: 'Minimum Order Quantity (MOQ)',
    packSize: 'Pack Size',
  },
  costs: {
    freight: 'Freight',
    insurance: 'Insurance',
    customsDuty: 'Customs Duty',
    surcharge: 'Surcharge',
    discount: 'Discount',
    additionalCost: 'Additional Cost',
    exchangeRate: 'Exchange Rate',
  },
  comparison: {
    landedCost: 'Landed Cost',
    lowestLandedCost: 'Lowest Landed Cost',
    incompleteQuote: 'Incomplete Quote',
    invalidQuote: 'Invalid Quote',
    rank: 'Rank',
    tied: 'Tied',
    comparisonUnavailable: 'Comparison Unavailable',
    suppliersCompared_one: '{{count}} supplier compared',
    suppliersCompared_other: '{{count}} suppliers compared',
  },
  warnings: {
    allocationUnavailable:
      'Cost allocation could not be calculated for this supplier; the total remains reliable.',
  },
  issues: {
    missingQuote: 'No quote exists for this supplier.',
    emptyQuote: 'The quote has no items.',
    missingRequiredItems: 'The quote does not cover all required items.',
    duplicateQuoteItem: 'The quote has more than one item for the same requirement.',
    unknownRequirementReference: 'The quote prices a requirement that is not in the project.',
    calculationError: 'An error occurred during calculation.',
  },
  insights: {
    noComparableSuppliers: 'No comparable suppliers.',
    onlyComparableSupplier: '{{supplierId}} is the only comparable supplier (Landed Cost: {{amount}}).',
    lowestCalculatedLandedCost: '{{supplierId}} has the lowest Landed Cost ({{amount}}).',
    tiedLowestCalculatedLandedCost:
      '{{count}} suppliers are tied for the lowest Landed Cost ({{amount}}).',
    lowestMerchandiseNotLowestLandedCost:
      'The supplier with the lowest merchandise value does not have the lowest Landed Cost.',
  },
  language: {
    tr: 'Türkçe',
    en: 'English',
  },
}

export default en
