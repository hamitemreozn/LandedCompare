/**
 * The `projects` store: an analysis project, its requirements and its quotes.
 *
 * Two structural decisions, both taken from the canonical documents:
 *
 * **Requirements and quotes are embedded.** They are one aggregate with the
 * project — always read together, always written together, and a write of half
 * of them is never valid (Data Model R5). Splitting them into their own stores
 * would normalise IndexedDB as if it were PostgreSQL, buying a join and a
 * second place for the relationship to be wrong.
 *
 * **Suppliers are referenced, not embedded.** `Project` holds
 * `readonly suppliers: Supplier[]` at runtime and `compareSuppliers()` expects
 * exactly that, but a purchase order must point at one company-wide supplier
 * record. So the record stores `supplierIds` and the loader reassembles the
 * runtime shape from the `suppliers` store (Local Persistence & Backup §3).
 *
 * Every `Money` and `Quantity` is stored through its existing
 * `toJSON()`/`fromJSON()` contract as a decimal string. No class instance is
 * ever written, and nothing is hydrated by casting — the domain factories
 * rebuild each value, so a stored record that has drifted from the model is
 * rejected instead of quietly becoming a domain object.
 */

import { Money, type MoneySnapshot } from '../../domain/monetary/Money'
import { Quantity, type QuantitySnapshot } from '../../domain/quantity/Quantity'
import { createProject, type Project } from '../../domain/project/Project'
import {
  createRequirementItem,
  type RequirementItem,
} from '../../domain/requirement/RequirementItem'
import { createQuote, type Quote } from '../../domain/quote/Quote'
import { createQuoteItem, type QuoteItem } from '../../domain/quote/QuoteItem'
import type { Supplier } from '../../domain/supplier/Supplier'
import { PersistenceError } from '../errors'
import {
  expectArray,
  expectCurrencyCode,
  expectDecimalString,
  expectInstant,
  expectNoUnknownKeys,
  expectNonEmptyString,
  expectObject,
  expectString,
  expectUuid,
  optional,
} from '../validation'

export interface RequirementItemRecord {
  readonly id: string
  readonly productName: string
  readonly sku?: string
  /**
   * Optional link into the `products` store, added at `schemaVersion` 3
   * (Data Model §12). Absent on every requirement written before it, which is
   * the correct value: the requirement simply names no catalog product.
   */
  readonly productId?: string
  readonly requiredQuantity: QuantitySnapshot
  readonly comparisonUnit: string
}

export interface QuoteItemRecord {
  readonly id: string
  readonly requirementId: string
  readonly quotedUnitPrice: MoneySnapshot
  readonly quotedUnit: string
  readonly unitsPerQuotedUnit?: QuantitySnapshot
  readonly moq?: QuantitySnapshot
}

export interface QuoteRecord {
  readonly id: string
  readonly supplierId: string
  readonly currency: string
  /** A business date (`YYYY-MM-DD`) or free text as the user typed it. */
  readonly quoteDate?: string
  readonly incoterm?: string
  readonly paymentTerms?: string
  readonly leadTime?: string
  readonly warranty?: string
  readonly notes?: string
  readonly items: readonly QuoteItemRecord[]
}

export interface ProjectRecord {
  readonly id: string
  readonly name: string
  readonly baseCurrency: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly supplierIds: readonly string[]
  readonly requirements: readonly RequirementItemRecord[]
  readonly quotes: readonly QuoteRecord[]
}

const PROJECT_KEYS = [
  'id',
  'name',
  'baseCurrency',
  'createdAt',
  'updatedAt',
  'supplierIds',
  'requirements',
  'quotes',
]
const REQUIREMENT_KEYS = [
  'id',
  'productName',
  'sku',
  'productId',
  'requiredQuantity',
  'comparisonUnit',
]
const QUOTE_KEYS = [
  'id',
  'supplierId',
  'currency',
  'quoteDate',
  'incoterm',
  'paymentTerms',
  'leadTime',
  'warranty',
  'notes',
  'items',
]
const QUOTE_ITEM_KEYS = [
  'id',
  'requirementId',
  'quotedUnitPrice',
  'quotedUnit',
  'unitsPerQuotedUnit',
  'moq',
]

function parseQuantitySnapshot(value: unknown, path: string): QuantitySnapshot {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['value'], path)
  return { value: expectDecimalString(record.value, `${path}.value`) }
}

function parseMoneySnapshot(value: unknown, path: string): MoneySnapshot {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, ['amount', 'currency'], path)
  return {
    amount: expectDecimalString(record.amount, `${path}.amount`),
    currency: expectCurrencyCode(record.currency, `${path}.currency`),
  }
}

function parseRequirementItemRecord(value: unknown, path: string): RequirementItemRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, REQUIREMENT_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    productName: expectNonEmptyString(record.productName, `${path}.productName`),
    sku: optional(record.sku, `${path}.sku`, expectString),
    productId: optional(record.productId, `${path}.productId`, expectUuid),
    requiredQuantity: parseQuantitySnapshot(record.requiredQuantity, `${path}.requiredQuantity`),
    comparisonUnit: expectNonEmptyString(record.comparisonUnit, `${path}.comparisonUnit`),
  }
}

function parseQuoteItemRecord(value: unknown, path: string): QuoteItemRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, QUOTE_ITEM_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    requirementId: expectUuid(record.requirementId, `${path}.requirementId`),
    quotedUnitPrice: parseMoneySnapshot(record.quotedUnitPrice, `${path}.quotedUnitPrice`),
    quotedUnit: expectNonEmptyString(record.quotedUnit, `${path}.quotedUnit`),
    unitsPerQuotedUnit: optional(
      record.unitsPerQuotedUnit,
      `${path}.unitsPerQuotedUnit`,
      parseQuantitySnapshot,
    ),
    moq: optional(record.moq, `${path}.moq`, parseQuantitySnapshot),
  }
}

function parseQuoteRecord(value: unknown, path: string): QuoteRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, QUOTE_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    supplierId: expectUuid(record.supplierId, `${path}.supplierId`),
    currency: expectCurrencyCode(record.currency, `${path}.currency`),
    quoteDate: optional(record.quoteDate, `${path}.quoteDate`, expectString),
    incoterm: optional(record.incoterm, `${path}.incoterm`, expectString),
    paymentTerms: optional(record.paymentTerms, `${path}.paymentTerms`, expectString),
    leadTime: optional(record.leadTime, `${path}.leadTime`, expectString),
    warranty: optional(record.warranty, `${path}.warranty`, expectString),
    notes: optional(record.notes, `${path}.notes`, expectString),
    items: expectArray(record.items, `${path}.items`).map((item, index) =>
      parseQuoteItemRecord(item, `${path}.items[${index}]`),
    ),
  }
}

export function parseProjectRecord(value: unknown, path = 'project'): ProjectRecord {
  const record = expectObject(value, path)
  expectNoUnknownKeys(record, PROJECT_KEYS, path)
  return {
    id: expectUuid(record.id, `${path}.id`),
    name: expectNonEmptyString(record.name, `${path}.name`),
    baseCurrency: expectCurrencyCode(record.baseCurrency, `${path}.baseCurrency`),
    createdAt: expectInstant(record.createdAt, `${path}.createdAt`),
    updatedAt: expectInstant(record.updatedAt, `${path}.updatedAt`),
    supplierIds: expectArray(record.supplierIds, `${path}.supplierIds`).map((id, index) =>
      expectUuid(id, `${path}.supplierIds[${index}]`),
    ),
    requirements: expectArray(record.requirements, `${path}.requirements`).map((item, index) =>
      parseRequirementItemRecord(item, `${path}.requirements[${index}]`),
    ),
    quotes: expectArray(record.quotes, `${path}.quotes`).map((quote, index) =>
      parseQuoteRecord(quote, `${path}.quotes[${index}]`),
    ),
  }
}

/**
 * Drops keys whose value is `undefined`.
 *
 * An absent optional field is stored by *not existing*, never as an explicit
 * `undefined`. That keeps `expectNoUnknownKeys` honest and means a record read
 * back has exactly the keys it was written with.
 */
function withoutUndefined<T extends object>(record: T): T {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return result as T
}

export function toProjectRecord(project: Project): ProjectRecord {
  return {
    id: project.id,
    name: project.name,
    baseCurrency: project.baseCurrency,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    supplierIds: project.suppliers.map((supplier) => supplier.id),
    requirements: project.requirements.map((requirement) =>
      withoutUndefined<RequirementItemRecord>({
        id: requirement.id,
        productName: requirement.productName,
        sku: requirement.sku,
        productId: requirement.productId,
        requiredQuantity: requirement.requiredQuantity.toJSON(),
        comparisonUnit: requirement.comparisonUnit,
      }),
    ),
    quotes: project.quotes.map((quote) =>
      withoutUndefined<QuoteRecord>({
        id: quote.id,
        supplierId: quote.supplierId,
        currency: quote.currency,
        quoteDate: quote.quoteDate,
        incoterm: quote.incoterm,
        paymentTerms: quote.paymentTerms,
        leadTime: quote.leadTime,
        warranty: quote.warranty,
        notes: quote.notes,
        items: quote.items.map((item) =>
          withoutUndefined<QuoteItemRecord>({
            id: item.id,
            requirementId: item.requirementId,
            quotedUnitPrice: item.quotedUnitPrice.toJSON(),
            quotedUnit: item.quotedUnit,
            unitsPerQuotedUnit: item.unitsPerQuotedUnit?.toJSON(),
            moq: item.moq?.toJSON(),
          }),
        ),
      }),
    ),
  }
}

function toRuntimeRequirement(record: RequirementItemRecord): RequirementItem {
  return createRequirementItem({
    id: record.id,
    productName: record.productName,
    sku: record.sku,
    productId: record.productId,
    requiredQuantity: record.requiredQuantity.value,
    comparisonUnit: record.comparisonUnit,
  })
}

function toRuntimeQuoteItem(record: QuoteItemRecord): QuoteItem {
  return createQuoteItem({
    id: record.id,
    requirementId: record.requirementId,
    quotedUnitPrice: Money.fromJSON(record.quotedUnitPrice),
    quotedUnit: record.quotedUnit,
    unitsPerQuotedUnit:
      record.unitsPerQuotedUnit === undefined
        ? undefined
        : Quantity.fromJSON(record.unitsPerQuotedUnit),
    moq: record.moq === undefined ? undefined : Quantity.fromJSON(record.moq),
  })
}

function toRuntimeQuote(record: QuoteRecord): Quote {
  return createQuote({
    id: record.id,
    supplierId: record.supplierId,
    currency: record.currency,
    quoteDate: record.quoteDate,
    incoterm: record.incoterm,
    paymentTerms: record.paymentTerms,
    leadTime: record.leadTime,
    warranty: record.warranty,
    notes: record.notes,
    items: record.items.map(toRuntimeQuoteItem),
  })
}

/**
 * Assembles the runtime `Project` from its record plus the separately stored
 * suppliers it references.
 *
 * The supplier list is ordered by `supplierIds`, not by whatever order the
 * store handed the records back in. Supplier order is an input the user
 * controls and the comparison engine breaks ranking ties on it, so a load that
 * reordered suppliers could change which of two equally priced suppliers is
 * listed first.
 */
export function toRuntimeProject(
  record: ProjectRecord,
  suppliersById: ReadonlyMap<string, Supplier>,
): Project {
  const suppliers = record.supplierIds.map((id) => {
    const supplier = suppliersById.get(id)
    if (supplier === undefined) {
      throw new PersistenceError(
        'REFERENCE_MISSING',
        `Project references supplier "${id}", which does not exist in the supplier master`,
        { details: { projectId: record.id, supplierId: id } },
      )
    }
    return supplier
  })

  return createProject({
    id: record.id,
    name: record.name,
    baseCurrency: record.baseCurrency,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    requirements: record.requirements.map(toRuntimeRequirement),
    suppliers,
    quotes: record.quotes.map(toRuntimeQuote),
  })
}
