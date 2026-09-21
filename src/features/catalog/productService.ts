/**
 * Product catalog actions — the layer between a React screen and the typed
 * product store.
 *
 * ```text
 *   ProductsScreen / ProductForm
 *        ↓   (a draft: strings, exactly as typed)
 *   productService              ← here
 *        ↓   (a ProductRecord: validated, timestamped)
 *   stores/productStore
 *        ↓
 *   IndexedDB
 * ```
 *
 * The boundary this file defends is the one an independent audit warned about:
 * a feature that reaches past the typed store and writes through
 * `TransactionScope.put` — or worse, `indexedDB` directly — bypasses the
 * record validators, and a record that never met them can be written today and
 * refuse to restore from a backup tomorrow. **No React component in this
 * application imports `src/persistence/idb`, and none opens a transaction.**
 *
 * It is also where identity and time are decided, and neither is allowed
 * further down:
 *
 * - `id` is a `crypto.randomUUID()` and is generated **once**, on create. An
 *   edit reuses it. Array position is never identity (Data Model §2).
 * - `createdAt` is preserved across every edit; `updatedAt` is restamped. The
 *   store cannot stamp `updatedAt` itself, because that is the value the
 *   stale-write check compares against — a persistence helper inventing it
 *   would defeat the check it exists to serve.
 */

import { Quantity } from '../../domain/quantity/Quantity'
import type { SupportedLocale } from '../../i18n'
import {
  listProductRecords,
  loadProductRecord,
  saveProduct,
  type Database,
  type ProductRecord,
} from '../../persistence'
import { formatDecimalForInput, parseDecimalInput } from '../shared/decimalInput'
import { FormValidationError, requiredText } from '../shared/formError'
import { optionalText } from '../shared/masterData'

/**
 * A product form's contents: strings **as the user sees them**, plus the
 * lifecycle flag.
 *
 * This is deliberately not a record with the field names spelled differently.
 * A draft holds display text — a pack factor a Turkish user reads as `12,5`,
 * a unit the dropdown resolved to the canonical `BOX` — and turning that into
 * a `ProductRecord` is this module's job and the only place it happens. The
 * two directions are `productDraftFrom` and `buildRecord`, and both take a
 * locale, because the conversion is not locale-free in either direction.
 */
export interface ProductDraft {
  readonly sku: string
  readonly name: string
  readonly description: string
  readonly stockUnit: string
  readonly defaultPurchaseUnit: string
  readonly unitsPerPurchaseUnit: string
  readonly manufacturer: string
  readonly manufacturerRef: string
  readonly note: string
  readonly active: boolean
}

export const EMPTY_PRODUCT_DRAFT: ProductDraft = {
  sku: '',
  name: '',
  description: '',
  stockUnit: '',
  defaultPurchaseUnit: '',
  unitsPerPurchaseUnit: '',
  manufacturer: '',
  manufacturerRef: '',
  note: '',
  active: true,
}

/**
 * The stored record, as form text.
 *
 * The units come back untouched — a canonical code stays a canonical code and
 * a custom unit stays the string it was — because the dropdown resolves codes
 * to labels at render time rather than here. Only the pack factor is
 * localised, so a Turkish user reopens `12.5` as `12,5` and an English one as
 * `12.5`.
 */
export function productDraftFrom(record: ProductRecord, locale: SupportedLocale): ProductDraft {
  return {
    sku: record.sku,
    name: record.name,
    description: record.description ?? '',
    stockUnit: record.stockUnit,
    defaultPurchaseUnit: record.defaultPurchaseUnit ?? '',
    unitsPerPurchaseUnit:
      record.unitsPerPurchaseUnit === undefined
        ? ''
        : formatDecimalForInput(record.unitsPerPurchaseUnit.value, locale),
    manufacturer: record.manufacturer ?? '',
    manufacturerRef: record.manufacturerRef ?? '',
    note: record.note ?? '',
    active: record.active,
  }
}

export interface ServiceClock {
  readonly now?: () => string
  readonly generateId?: () => string
}

/** A service call that has to read localised input back into canonical form. */
export interface ProductServiceOptions extends ServiceClock {
  readonly locale: SupportedLocale
}

function instant(options: ServiceClock): string {
  return (options.now ?? (() => new Date().toISOString()))()
}

/**
 * Parses the pack factor, which is the one numeric field on this form.
 *
 * Two steps, in this order and never merged. `parseDecimalInput` rewrites
 * separator characters for the current locale — `12,5` becomes `12.5` — and
 * refuses the one shape that could mean two magnitudes. `Quantity.fromString`
 * then decides whether the canonical string is a valid quantity at all, and
 * remains the authority on that: nothing here computes, rounds, or goes near
 * `parseFloat`. A factor that arrived as a binary float would carry that
 * imprecision into every future purchase-order line converted with it.
 *
 * An empty field is an absent optional, not a zero.
 */
function packFactor(value: string, locale: SupportedLocale): { value: string } | undefined {
  const text = optionalText(value)
  if (text === undefined) {
    return undefined
  }
  const parsed = parseDecimalInput(text, locale)
  if (!parsed.ok) {
    throw new FormValidationError(
      'unitsPerPurchaseUnit',
      parsed.reason === 'AMBIGUOUS_SEPARATOR' ? 'form.ambiguousSeparator' : 'form.mustBeNumber',
    )
  }
  let quantity: Quantity
  try {
    quantity = Quantity.fromString(parsed.canonical)
  } catch {
    throw new FormValidationError('unitsPerPurchaseUnit', 'form.mustBeNumber')
  }
  if (quantity.isZero()) {
    throw new FormValidationError('unitsPerPurchaseUnit', 'form.mustBePositive')
  }
  return quantity.toJSON()
}

function buildRecord(
  draft: ProductDraft,
  locale: SupportedLocale,
  identity: { id: string; createdAt: string; updatedAt: string },
): ProductRecord {
  return {
    id: identity.id,
    sku: requiredText(draft.sku, 'sku'),
    name: requiredText(draft.name, 'name'),
    description: optionalText(draft.description),
    stockUnit: requiredText(draft.stockUnit, 'stockUnit'),
    defaultPurchaseUnit: optionalText(draft.defaultPurchaseUnit),
    unitsPerPurchaseUnit: packFactor(draft.unitsPerPurchaseUnit, locale),
    manufacturer: optionalText(draft.manufacturer),
    manufacturerRef: optionalText(draft.manufacturerRef),
    active: draft.active,
    note: optionalText(draft.note),
    createdAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  }
}

export function listProducts(database: Database): Promise<ProductRecord[]> {
  return listProductRecords(database)
}

export function loadProduct(database: Database, id: string): Promise<ProductRecord> {
  return loadProductRecord(database, id)
}

/**
 * Creates a product, and resolves only once the transaction has **committed**.
 *
 * The record is returned so a caller can show it, but the caller is expected
 * to re-read the list rather than splice this into one: an optimistic update
 * would let the screen claim a success the database refused. Persist first,
 * then reflect.
 */
export async function createProduct(
  database: Database,
  draft: ProductDraft,
  options: ProductServiceOptions,
): Promise<ProductRecord> {
  const at = instant(options)
  const record = buildRecord(draft, options.locale, {
    id: (options.generateId ?? (() => crypto.randomUUID()))(),
    createdAt: at,
    updatedAt: at,
  })
  await saveProduct(database, record)
  return record
}

/**
 * Updates a product in place.
 *
 * `existing` is the record the form loaded, and both things taken from it
 * matter: its `id` keeps identity stable across the edit, and its `updatedAt`
 * is handed to the store as `previousUpdatedAt`, which is what turns a second
 * tab's concurrent save into a refusal instead of a silent overwrite.
 */
export async function updateProduct(
  database: Database,
  existing: ProductRecord,
  draft: ProductDraft,
  options: ProductServiceOptions,
): Promise<ProductRecord> {
  const record = buildRecord(draft, options.locale, {
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: instant(options),
  })
  await saveProduct(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}

/**
 * Flips the lifecycle flag, and nothing else.
 *
 * `active: false` is the deletion mechanism for a master record (Data Model
 * §4, I14): a product referenced by any movement, order, shipment or
 * reservation is never hard-deleted, and at Phase 9 nothing can yet prove
 * whether such a reference exists. Deactivation is the operation that is
 * correct either way, so it is the only one offered.
 */
export async function setProductActive(
  database: Database,
  existing: ProductRecord,
  active: boolean,
  options: ServiceClock = {},
): Promise<ProductRecord> {
  const record: ProductRecord = { ...existing, active, updatedAt: instant(options) }
  await saveProduct(database, record, { previousUpdatedAt: existing.updatedAt })
  return record
}
