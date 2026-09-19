/**
 * Structural shape every supported-locale resource must satisfy. `en.ts` and
 * `tr.ts` are both typed against this, so a key added to one and forgotten in
 * the other is a compile error, not just a runtime drift caught by tests.
 */
export interface TranslationResource {
  readonly app: {
    readonly underDevelopment: string
    readonly currentLanguage: string
  }
  readonly common: {
    readonly appName: string
    readonly save: string
    readonly cancel: string
    readonly delete: string
    readonly edit: string
    readonly add: string
    readonly continue: string
    readonly back: string
    readonly loading: string
    readonly error: string
    readonly warning: string
    readonly yes: string
    readonly no: string
  }
  readonly nav: {
    readonly projects: string
    readonly project: string
    readonly newProject: string
    readonly requirements: string
    readonly suppliers: string
    readonly quotes: string
    readonly costs: string
    readonly results: string
  }
  readonly supplier: {
    readonly supplier: string
    readonly supplierName: string
  }
  readonly quote: {
    readonly quote: string
    readonly currency: string
    readonly unitPrice: string
    readonly quantity: string
    readonly requiredQuantity: string
    readonly resolvedQuantity: string
    readonly excessQuantity: string
    readonly moq: string
    readonly packSize: string
  }
  readonly costs: {
    readonly freight: string
    readonly insurance: string
    readonly customsDuty: string
    readonly surcharge: string
    readonly discount: string
    readonly additionalCost: string
    readonly exchangeRate: string
  }
  readonly comparison: {
    readonly landedCost: string
    readonly lowestLandedCost: string
    readonly incompleteQuote: string
    readonly invalidQuote: string
    readonly rank: string
    readonly tied: string
    readonly comparisonUnavailable: string
    readonly suppliersCompared_one: string
    readonly suppliersCompared_other: string
  }
  readonly warnings: {
    readonly allocationUnavailable: string
  }
  readonly issues: {
    readonly missingQuote: string
    readonly emptyQuote: string
    readonly missingRequiredItems: string
    readonly duplicateQuoteItem: string
    readonly unknownRequirementReference: string
    readonly calculationError: string
  }
  readonly insights: {
    readonly noComparableSuppliers: string
    readonly onlyComparableSupplier: string
    readonly lowestCalculatedLandedCost: string
    readonly tiedLowestCalculatedLandedCost: string
    readonly lowestMerchandiseNotLowestLandedCost: string
  }
  readonly language: {
    readonly tr: string
    readonly en: string
  }
}
