import type { ComparisonInsight } from '../comparison/ComparisonInsights'
import type { SupplierIssueCode, SupplierWarningCode } from '../comparison/SupplierEvaluation'

/**
 * Maps the engine's stable, machine-readable codes to translation keys. This
 * is the UI/i18n boundary described in the Phase 6 architecture rule: the
 * engine (`comparison`, `calculation`, `domain`) returns codes only, and only
 * this layer — which imports engine *types*, never the other way around —
 * turns a code into human-readable text via `t(key, params)`.
 *
 * Only type-only imports are used above, so this module adds no runtime
 * dependency from the engine onto i18n; it depends on the engine's public
 * code vocabulary, not vice versa.
 */

export const SUPPLIER_ISSUE_TRANSLATION_KEY: Record<SupplierIssueCode, string> = {
  MISSING_QUOTE: 'issues.missingQuote',
  EMPTY_QUOTE: 'issues.emptyQuote',
  MISSING_REQUIRED_ITEMS: 'issues.missingRequiredItems',
  DUPLICATE_QUOTE_ITEM: 'issues.duplicateQuoteItem',
  UNKNOWN_REQUIREMENT_REFERENCE: 'issues.unknownRequirementReference',
  CALCULATION_ERROR: 'issues.calculationError',
}

export const SUPPLIER_WARNING_TRANSLATION_KEY: Record<SupplierWarningCode, string> = {
  ALLOCATION_UNAVAILABLE: 'warnings.allocationUnavailable',
}

export const COMPARISON_INSIGHT_TRANSLATION_KEY: Record<ComparisonInsight['code'], string> = {
  NO_COMPARABLE_SUPPLIERS: 'insights.noComparableSuppliers',
  ONLY_COMPARABLE_SUPPLIER: 'insights.onlyComparableSupplier',
  LOWEST_CALCULATED_LANDED_COST: 'insights.lowestCalculatedLandedCost',
  TIED_LOWEST_CALCULATED_LANDED_COST: 'insights.tiedLowestCalculatedLandedCost',
  LOWEST_MERCHANDISE_NOT_LOWEST_LANDED_COST: 'insights.lowestMerchandiseNotLowestLandedCost',
  INCOMPLETE_QUOTE: 'comparison.incompleteQuote',
  INVALID_QUOTE: 'comparison.invalidQuote',
}
