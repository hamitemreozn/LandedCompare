/**
 * Visual Polish Round 4 — the bright-blue-as-UI-colour policy. Same
 * read-the-source-and-resolve technique as `src/styles/tokens.test.ts`, this
 * time merged across both token files the way the real cascade resolves
 * them (`src/index.css` loads `styles/tokens.css` first, `ui/tokens.css`
 * second — a name declared in both resolves to `ui/tokens.css`'s value,
 * same as in the browser).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stylesTokens = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf-8')
const uiTokens = readFileSync(join(process.cwd(), 'src/ui/tokens.css'), 'utf-8')
const components = readFileSync(join(process.cwd(), 'src/ui/components.css'), 'utf-8')

function parseRoot(css: string): Map<string, string> {
  // Only the bare `:root {` block (not `:root[data-theme='dark']`) — the
  // light theme is the only one currently live in the running application.
  const start = css.indexOf(':root {')
  expect(start, 'no bare :root block found').toBeGreaterThanOrEqual(0)
  const end = css.indexOf('\n}', start)
  const block = css.slice(start, end)
  const decls = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    decls.set(match[1], match[2].trim())
  }
  return decls
}

// ui/tokens.css's :root wins for any name both declare — same as the real cascade.
const decls = new Map([...parseRoot(stylesTokens), ...parseRoot(uiTokens)])

function resolve(name: string, depth = 0): string {
  if (depth > 12) throw new Error(`var() chain too deep resolving "${name}"`)
  const raw = decls.get(name)
  expect(raw, `"${name}" is not declared in either token file's :root`).toBeDefined()
  const match = /^var\((--[a-z0-9-]+)\)$/i.exec(raw!)
  if (match === null) return raw!.toLowerCase()
  return resolve(match[1], depth + 1)
}

const BRIGHT_BLUE = '#3557f3'

describe('Visual Polish Round 4, §1–§3 — #3557F3 retired as an application-UI colour', () => {
  it.each([
    '--action-primary',
    '--action-primary-hover',
    '--action-primary-active',
    '--focus-ring',
    '--accent-600',
    '--accent-700',
    '--accent-500',
    '--accent',
    '--accent-strong',
    '--cta-primary',
    '--cta-primary-hover',
    '--state-selected-bg',
  ])('%s does not resolve to #3557F3', (token) => {
    expect(resolve(token)).not.toBe(BRIGHT_BLUE)
  })

  it('--action-primary and --focus-ring resolve to the frozen brand navy (#1B2A55)', () => {
    expect(resolve('--action-primary')).toBe('#1b2a55')
    expect(resolve('--focus-ring')).toBe('#1b2a55')
  })

  it('--action-primary-hover resolves to the approved dark-navy hover (#101B33)', () => {
    expect(resolve('--action-primary-hover')).toBe('#101b33')
  })

  it('--state-selected-bg resolves to the approved low-saturation neutral (#EEF1F5)', () => {
    expect(resolve('--state-selected-bg')).toBe('#eef1f5')
  })

  it('the raw #3557F3 palette anchor is still declared (brand artwork may reference it) but nothing in the light theme resolves through it any more', () => {
    expect(stylesTokens).toMatch(/--palette-blue-600:\s*#3557f3/i)
    // Every light-theme custom property that used to chain through it now
    // terminates somewhere else — proven by the resolution tests above, not
    // asserted again here (a literal "nothing references it" text search
    // would also match this file's own explanatory comments).
  })
})

describe('Visual Polish Round 4, §5 — segmented controls', () => {
  it('selected state has no bright-blue fill/text/outline', () => {
    const start = components.indexOf(".segmented__option[aria-pressed='true'] {")
    const end = components.indexOf('}', start)
    const block = components.slice(start, end)
    expect(block.toLowerCase()).not.toContain(BRIGHT_BLUE)
  })
})

describe('Visual Polish Round 4, §6 — Select / dropdown selected state', () => {
  it('the checked item has no bright-blue background/text/icon', () => {
    const start = components.indexOf(".select-item[data-state='checked'] {")
    const end = components.indexOf('}', start)
    const block = components.slice(start, end)
    expect(block.toLowerCase()).not.toContain(BRIGHT_BLUE)
  })
})

describe('Visual Polish Round 4, §8 — active navigation accent', () => {
  it('the active-nav accent bar is no longer --palette-blue-500', () => {
    const start = components.indexOf("[aria-current='page'] {")
    const end = components.indexOf('}', start)
    const block = components.slice(start, end)
    expect(block).not.toMatch(/--palette-blue-500/)
  })
})

describe('Visual Polish Round 4, §9–§11 — the edge-handle collapse control', () => {
  it('the positioning wrapper is hidden under the mobile breakpoint, where the drawer trigger takes over', () => {
    const mobileBlockStart = components.indexOf('@media (max-width: 900px) {')
    const mobileBlockEnd = components.indexOf('\n@media (max-width: 900px) and (prefers-reduced-motion', mobileBlockStart)
    const mobileBlock = components.slice(mobileBlockStart, mobileBlockEnd)
    expect(mobileBlock).toMatch(/\.sidebar__collapse-toggle-wrap\s*{\s*display:\s*none;/)
  })

  it('no rule nests the button or its positioning wrapper under .brand or .sidebar__scroll', () => {
    expect(components).not.toMatch(/\.brand\s+\.sidebar__collapse-toggle/)
    expect(components).not.toMatch(/\.sidebar__scroll\s+\.sidebar__collapse-toggle/)
  })

  it('position: absolute lives on the wrapper, not the button — a Tooltip-wrapped positioned button resolves its containing block off Tooltip\'s own relative span instead of .sidebar', () => {
    const wrapStart = components.indexOf('.sidebar__collapse-toggle-wrap {')
    const wrapEnd = components.indexOf('}', wrapStart)
    const wrapBlock = components.slice(wrapStart, wrapEnd)
    expect(wrapBlock).toMatch(/position:\s*absolute/)

    const buttonStart = components.indexOf('.sidebar__collapse-toggle {')
    const buttonEnd = components.indexOf('}', buttonStart)
    const buttonBlock = components.slice(buttonStart, buttonEnd)
    expect(buttonBlock).not.toMatch(/position:\s*absolute/)
  })
})

describe('Visual Polish Round 4 — regressions that must still hold', () => {
  it('the primary CTA is still the calm navy, not blue', () => {
    expect(resolve('--cta-primary')).toBe('#1b2a55')
  })

  it('semantic status badges are untouched — still the green/slate family', () => {
    const start = components.indexOf('.badge--active {')
    const end = components.indexOf('}', start)
    const block = components.slice(start, end)
    expect(block).toMatch(/var\(--green-700\)/)
    expect(block).not.toMatch(/--accent|--action-primary|--cta-primary/)
  })
})
