/**
 * F12.7-02 — the final independent audit found `--focus-ring` (the navy
 * brand colour, ~1.32:1) nearly invisible against the dark sidebar
 * (`--surface-nav`). Same read-the-source-and-resolve technique as
 * `visualPolishRound4.test.ts`: this asserts the actual *contextual pair* —
 * the dark-surface focus token against the surface it's meant to be seen
 * on — rather than merely asserting a literal string, which would pass even
 * if the new token still resolved to something equally invisible.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const stylesTokens = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf-8')
const uiTokens = readFileSync(join(process.cwd(), 'src/ui/tokens.css'), 'utf-8')

function parseRoot(css: string): Map<string, string> {
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

function lin(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  expect(m, `expected a #rrggbb hex colour, got "${hex}"`).not.toBeNull()
  const n = parseInt(m![1], 16)
  return 0.2126 * lin((n >> 16) & 0xff) + 0.7152 * lin((n >> 8) & 0xff) + 0.0722 * lin(n & 0xff)
}

/** Non-text (UI component) contrast — WCAG 1.4.11 asks for >= 3:1, not the 4.5:1 text threshold. */
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

describe('F12.7-02 — dark-surface focus contrast', () => {
  it('--focus-ring-on-dark against --surface-nav meets WCAG 1.4.11 (>= 3:1)', () => {
    const ring = resolve('--focus-ring-on-dark')
    const surface = resolve('--surface-nav')
    expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3)
  })

  it('reproduces the audit-cited failure: plain --focus-ring against --surface-nav is under 3:1', () => {
    // Documents *why* a separate token was necessary — if this ever starts
    // passing, the light-surface ring changed underneath this test and the
    // audit's premise (and the need for `--focus-ring-on-dark`) should be
    // re-examined, not silently left stale.
    const ring = resolve('--focus-ring')
    const surface = resolve('--surface-nav')
    expect(contrast(ring, surface)).toBeLessThan(3)
  })

  it('--focus-ring on light surfaces is unchanged: still the navy system, not reverted or touched', () => {
    const ring = resolve('--focus-ring')
    const surface = resolve('--surface-card')
    expect(ring).toBe('#1b2a55')
    expect(contrast(ring, surface)).toBeGreaterThanOrEqual(3)
  })
})
