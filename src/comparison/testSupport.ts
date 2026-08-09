import { Money } from '../domain/monetary/Money'
import { Quantity } from '../domain/quantity/Quantity'
import { createProject, type Project } from '../domain/project/Project'
import { createRequirementItem, type RequirementItem } from '../domain/requirement/RequirementItem'
import { createSupplier, type Supplier } from '../domain/supplier/Supplier'
import { createQuote, type Quote } from '../domain/quote/Quote'
import { createQuoteItem, type QuoteItem } from '../domain/quote/QuoteItem'
import { ExchangeRateTable } from '../calculation/ExchangeRateTable'

/**
 * Shared, minimal object builders for Phase 5 comparison tests. Not a test
 * file itself — every default is deliberately arbitrary-but-valid so each
 * test only has to override what it actually cares about.
 */

export function requirement(
  id: string,
  opts: { productName?: string; requiredQuantity?: string; comparisonUnit?: string } = {},
): RequirementItem {
  return createRequirementItem({
    id,
    productName: opts.productName ?? id,
    requiredQuantity: opts.requiredQuantity ?? '10',
    comparisonUnit: opts.comparisonUnit ?? 'pcs',
  })
}

export function supplier(id: string, displayName?: string): Supplier {
  return createSupplier({ id, displayName: displayName ?? id })
}

export function quoteItem(opts: {
  id: string
  requirementId: string
  price: string
  currency: string
  moq?: string
  unitsPerQuotedUnit?: string
}): QuoteItem {
  return createQuoteItem({
    id: opts.id,
    requirementId: opts.requirementId,
    quotedUnitPrice: Money.fromString(opts.price, opts.currency),
    quotedUnit: 'unit',
    moq: opts.moq !== undefined ? Quantity.fromString(opts.moq) : undefined,
    unitsPerQuotedUnit:
      opts.unitsPerQuotedUnit !== undefined ? Quantity.fromString(opts.unitsPerQuotedUnit) : undefined,
  })
}

export function quote(opts: {
  id: string
  supplierId: string
  currency: string
  items?: readonly QuoteItem[]
}): Quote {
  return createQuote({
    id: opts.id,
    supplierId: opts.supplierId,
    currency: opts.currency,
    items: opts.items ?? [],
  })
}

export function project(opts: {
  baseCurrency: string
  requirements?: readonly RequirementItem[]
  suppliers?: readonly Supplier[]
  quotes?: readonly Quote[]
}): Project {
  return createProject({
    id: 'project-1',
    name: 'Test Project',
    baseCurrency: opts.baseCurrency,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    requirements: opts.requirements ?? [],
    suppliers: opts.suppliers ?? [],
    quotes: opts.quotes ?? [],
  })
}

export function baseRateTable(baseCurrency: string): ExchangeRateTable {
  return ExchangeRateTable.create(baseCurrency)
}
