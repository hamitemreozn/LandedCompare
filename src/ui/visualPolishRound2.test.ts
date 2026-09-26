/**
 * Locks in the CSS-level decisions from Visual Polish Round 2 that have no
 * other place to be tested (the DOM behaviour they produce is unit-tested
 * elsewhere — `Tooltip.test.tsx`, `features/shell/AppShell.test.tsx` — but
 * "which colour a class resolves to" and "did this rule get removed" are
 * plain-text facts about the stylesheet, not something jsdom's unstyled DOM
 * can assert on). Same technique as `src/styles/tokens.test.ts`: read the
 * source file and check the declarations, not a rendered/computed style.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tokens = readFileSync(join(process.cwd(), 'src/ui/tokens.css'), 'utf-8')
const components = readFileSync(join(process.cwd(), 'src/ui/components.css'), 'utf-8')

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('Visual Polish Round 2, §1 — primary CTA colour', () => {
  it('--cta-primary resolves to the frozen brand navy, not the interaction-blue accent', () => {
    expect(tokens).toMatch(/--cta-primary:\s*var\(--brand-primary\)/)
  })

  it('.button--primary fills with --cta-primary, not --accent-600', () => {
    const block = extractBlock(components, '.button--primary')
    expect(block).toMatch(/background:\s*var\(--cta-primary\)/)
    expect(block).not.toMatch(/--accent-600/)
  })

  it('the segmented filter\'s selected state is a light surface with blue text, not a solid blue fill', () => {
    const block = extractBlock(components, ".segmented__option[aria-pressed='true']")
    expect(block).toMatch(/background:\s*var\(--accent-100\)/)
    expect(block).not.toMatch(/--text-on-accent/)
  })

  it('status badges stay on the semantic green/slate scale, untouched by the accent rewiring', () => {
    const active = extractBlock(components, '.badge--active')
    expect(active).toMatch(/var\(--green-700\)/)
    expect(active).not.toMatch(/--accent|--cta-primary/)
  })
})

describe('Visual Polish Round 2, §3 — form action footers', () => {
  it('.form-actions carries no tinted background', () => {
    const block = extractBlock(components, '.form-actions')
    expect(block).not.toMatch(/background:/)
  })
})

describe('Visual Polish Round 2, §4 — select caret', () => {
  it('.select removes the native arrow and draws its own, inset from the edge', () => {
    // `.select {` also closes the shared `.input, .textarea, .select {`
    // block earlier in the file — this rule is its own, later block.
    const start = components.lastIndexOf('.select {')
    const end = components.indexOf('}', start)
    const block = components.slice(start, end)
    expect(block).toMatch(/appearance:\s*none/)
    expect(block).toMatch(/background-image:\s*url\(/)
    expect(block).toMatch(/padding-inline-end:/)
  })
})
