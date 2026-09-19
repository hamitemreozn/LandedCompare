import { describe, expect, it } from 'vitest'
import en from './en'
import tr from './tr'

/** Recursively collects dot-joined leaf key paths from a nested translation object. */
function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') {
    return [prefix]
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      collectKeyPaths(child, prefix ? `${prefix}.${key}` : key),
    )
  }
  return [prefix]
}

describe('translation catalog parity', () => {
  it('exposes the exact same set of keys in tr and en', () => {
    const enKeys = collectKeyPaths(en).sort()
    const trKeys = collectKeyPaths(tr).sort()

    const missingFromTr = enKeys.filter((key) => !trKeys.includes(key))
    const missingFromEn = trKeys.filter((key) => !enKeys.includes(key))

    expect(missingFromTr, `keys present in en but missing from tr: ${missingFromTr.join(', ')}`).toEqual([])
    expect(missingFromEn, `keys present in tr but missing from en: ${missingFromEn.join(', ')}`).toEqual([])
  })

  it('has no empty translation values in either catalog', () => {
    for (const [name, catalog] of [
      ['en', en],
      ['tr', tr],
    ] as const) {
      for (const key of collectKeyPaths(catalog)) {
        const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog)
        expect(typeof value === 'string' && value.trim().length > 0, `${name}.${key} is empty`).toBe(true)
      }
    }
  })
})

describe('required core keys', () => {
  const requiredKeys = [
    'common.appName',
    'common.save',
    'common.cancel',
    'common.delete',
    'common.edit',
    'common.add',
    'common.continue',
    'common.back',
    'common.loading',
    'common.error',
    'common.warning',
    'common.yes',
    'common.no',
    'nav.projects',
    'nav.project',
    'nav.newProject',
    'nav.requirements',
    'nav.suppliers',
    'nav.quotes',
    'nav.costs',
    'nav.results',
    'supplier.supplier',
    'supplier.supplierName',
    'quote.quote',
    'quote.currency',
    'quote.unitPrice',
    'quote.quantity',
    'quote.requiredQuantity',
    'quote.resolvedQuantity',
    'quote.excessQuantity',
    'quote.moq',
    'quote.packSize',
    'costs.freight',
    'costs.insurance',
    'costs.customsDuty',
    'costs.surcharge',
    'costs.discount',
    'costs.additionalCost',
    'costs.exchangeRate',
    'comparison.landedCost',
    'comparison.lowestLandedCost',
    'comparison.incompleteQuote',
    'comparison.invalidQuote',
    'comparison.rank',
    'comparison.tied',
    'comparison.comparisonUnavailable',
    'warnings.allocationUnavailable',
  ]

  it.each(requiredKeys)('%s exists in en and tr', (key) => {
    const path = key.split('.')
    const enValue = path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en)
    const trValue = path.reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], tr)
    expect(typeof enValue).toBe('string')
    expect(typeof trValue).toBe('string')
  })
})
