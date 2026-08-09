import type { Project } from '../domain/project/Project'
import type { ExchangeRateTable } from '../calculation/ExchangeRateTable'

/**
 * Global problems that make the *comparison itself* meaningless, as opposed
 * to a single supplier's data being incomplete or invalid. These block the
 * whole comparison (thrown, never swallowed into a per-supplier result) —
 * see docs/CALCULATION_RULES.md, "Comparison-level structural validation".
 */
export type ComparisonStructuralIssueCode =
  | 'EMPTY_REQUIREMENTS'
  | 'DUPLICATE_REQUIREMENT_ID'
  | 'ZERO_REQUIRED_QUANTITY'
  | 'DUPLICATE_SUPPLIER_ID'
  | 'ORPHAN_QUOTE'
  | 'DUPLICATE_QUOTE_FOR_SUPPLIER'
  | 'BASE_CURRENCY_MISMATCH'

export class InvalidComparisonInputError extends Error {
  readonly code: ComparisonStructuralIssueCode

  constructor(code: ComparisonStructuralIssueCode, message: string) {
    super(message)
    this.name = 'InvalidComparisonInputError'
    this.code = code
  }
}

/**
 * Validates the project-wide structural preconditions a supplier comparison
 * relies on. This is deliberately separate from per-supplier completeness
 * (`SupplierEvaluation.ts`): a problem here means the comparison cannot be
 * meaningfully constructed at all, not that one supplier's quote is missing
 * or malformed.
 */
export function validateComparisonStructure(
  project: Project,
  exchangeRateTable: ExchangeRateTable,
): void {
  if (project.baseCurrency !== exchangeRateTable.baseCurrency) {
    throw new InvalidComparisonInputError(
      'BASE_CURRENCY_MISMATCH',
      `Project base currency "${project.baseCurrency}" does not match the exchange rate table's base currency "${exchangeRateTable.baseCurrency}"`,
    )
  }

  if (project.requirements.length === 0) {
    throw new InvalidComparisonInputError(
      'EMPTY_REQUIREMENTS',
      'Project has no requirements; there is nothing to compare supplier quotations against',
    )
  }

  assertUniqueIds(
    project.requirements.map((requirement) => requirement.id),
    'DUPLICATE_REQUIREMENT_ID',
    (id) => `Duplicate requirement id "${id}"`,
  )

  const zeroQuantityIds = project.requirements
    .filter((requirement) => requirement.requiredQuantity.isZero())
    .map((requirement) => requirement.id)
  if (zeroQuantityIds.length > 0) {
    throw new InvalidComparisonInputError(
      'ZERO_REQUIRED_QUANTITY',
      `Requirement(s) with zero required quantity cannot be compared: ${zeroQuantityIds.join(', ')}`,
    )
  }

  assertUniqueIds(
    project.suppliers.map((supplier) => supplier.id),
    'DUPLICATE_SUPPLIER_ID',
    (id) => `Duplicate supplier id "${id}"`,
  )

  const supplierIds = new Set(project.suppliers.map((supplier) => supplier.id))
  const orphanQuoteIds = project.quotes
    .filter((quote) => !supplierIds.has(quote.supplierId))
    .map((quote) => quote.id)
  if (orphanQuoteIds.length > 0) {
    throw new InvalidComparisonInputError(
      'ORPHAN_QUOTE',
      `Quote(s) reference a supplierId not present in the project: ${orphanQuoteIds.join(', ')}`,
    )
  }

  const quoteCountBySupplierId = new Map<string, number>()
  for (const quote of project.quotes) {
    quoteCountBySupplierId.set(quote.supplierId, (quoteCountBySupplierId.get(quote.supplierId) ?? 0) + 1)
  }
  const suppliersWithMultipleQuotes = [...quoteCountBySupplierId.entries()]
    .filter(([, count]) => count > 1)
    .map(([supplierId]) => supplierId)
  if (suppliersWithMultipleQuotes.length > 0) {
    throw new InvalidComparisonInputError(
      'DUPLICATE_QUOTE_FOR_SUPPLIER',
      `More than one quote references the same supplier, which is ambiguous: ${suppliersWithMultipleQuotes.join(', ')}`,
    )
  }
}

function assertUniqueIds(
  ids: readonly string[],
  code: ComparisonStructuralIssueCode,
  messageFor: (id: string) => string,
): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new InvalidComparisonInputError(code, messageFor(id))
    }
    seen.add(id)
  }
}
