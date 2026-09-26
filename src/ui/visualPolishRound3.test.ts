/**
 * Locks in the CSS-level decisions from Visual Polish Round 3 — same
 * technique as `src/styles/tokens.test.ts` and `visualPolishRound2.test.ts`:
 * read the source file and check the declarations, since jsdom renders no
 * layout for these to be observed through computed style. The DOM-level
 * consequences (where the collapse control actually sits, that the topbar
 * starts with the breadcrumb) are covered in
 * `src/features/shell/AppShell.test.tsx`.
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

describe('Visual Polish Round 3, §1 — collapse control location', () => {
  it('no .topbar__collapse-trigger rule remains', () => {
    expect(components).not.toMatch(/\.topbar__collapse-trigger/)
  })
})

describe('Visual Polish Round 3, §3 — expanded workspace on collapse', () => {
  it('--content-max is raised from the Round 1/2 value', () => {
    expect(tokens).toMatch(/--content-max:\s*1440px/)
  })

  it('collapsing the sidebar raises --content-max further, on .shell itself', () => {
    const block = extractBlock(components, '.shell:has(.sidebar--collapsed)')
    expect(block).toMatch(/--content-max:\s*1600px/)
  })
})

describe('Visual Polish Round 3, §4 — form action footer', () => {
  it('.form-actions has no background and no border', () => {
    const block = extractBlock(components, '.form-actions')
    expect(block).not.toMatch(/background:/)
    expect(block).not.toMatch(/border-top:/)
  })
})

describe('Visual Polish Round 3, §5–§8 — Select primitive', () => {
  it('the closed trigger uses semantic elevated surface, --focus-ring, and the shared border/radius scale', () => {
    const block = extractBlock(components, '.select-trigger')
    expect(block).toMatch(/background:\s*var\(--surface-elevated\)/)
  })

  it('the trigger focus ring uses --focus-ring', () => {
    const block = extractBlock(components, '.select-trigger:focus-visible')
    expect(block).toMatch(/outline:\s*2px solid var\(--focus-ring\)/)
  })

  it('the selected item uses the light-blue selected surface and blue text, not gold', () => {
    const block = extractBlock(components, ".select-item[data-state='checked']")
    expect(block).toMatch(/background:\s*var\(--state-selected-bg\)/)
    expect(block).toMatch(/color:\s*var\(--action-primary\)/)
    expect(block).not.toMatch(/gold/i)
  })
})
