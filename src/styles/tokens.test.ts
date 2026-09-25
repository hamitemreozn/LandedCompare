import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf-8')

/** Pulls the declarations out of one `{ ... }` block (no nested blocks). */
function parseBlock(block: string): Map<string, string> {
  const decls = new Map<string, string>()
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    decls.set(match[1], match[2].trim())
  }
  return decls
}

function extractBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  expect(start, `selector "${selector}" not found`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

const lightDecls = parseBlock(extractBlock(':root'))
const darkOverrides = parseBlock(extractBlock(":root[data-theme='dark']"))
// `:root[data-theme='dark']` only overrides some tokens; the rest cascade
// down from `:root` in the real DOM, so resolution must fall back to light.
const darkDecls = new Map([...lightDecls, ...darkOverrides])

/** Resolves `var(--x)` chains against a declaration map down to a literal. */
function resolve(value: string, decls: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`var() chain too deep resolving "${value}"`)
  const match = /^var\((--[a-z0-9-]+)\)$/i.exec(value.trim())
  if (match === null) return value.trim()
  const next = decls.get(match[1])
  expect(next, `"${match[1]}" referenced but not declared`).toBeDefined()
  return resolve(next!, decls, depth + 1)
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

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

const STATUS_STATES = ['success', 'warning', 'error', 'info'] as const
const STATUS_ROLES = ['', '-icon', '-surface', '-text'] as const

describe('design tokens', () => {
  it('defines the semantic light tokens Phase 12.7 will consume', () => {
    for (const token of [
      '--brand-primary',
      '--brand-accent',
      '--surface-app',
      '--surface-card',
      '--text-primary',
      '--action-primary',
      '--focus-ring',
      '--font-ui',
      '--font-mono',
    ]) {
      expect(css).toContain(`${token}:`)
    }
  })

  it('scopes dark tokens to an explicit opt-in, never to prefers-color-scheme', () => {
    expect(css).toContain("[data-theme='dark']")
    expect(css).not.toContain('@media (prefers-color-scheme')
  })

  describe('status tokens (F12.6-03)', () => {
    it('declares all four roles (base/icon/surface/text) for all four states, in BOTH light and dark', () => {
      for (const state of STATUS_STATES) {
        for (const role of STATUS_ROLES) {
          const name = `--status-${state}${role}`
          expect(lightDecls.has(name), `light is missing ${name}`).toBe(true)
          // Checked against the dark block's OWN declarations, not the
          // light-fallback-merged map: a status semantic must be explicitly
          // re-themed for dark, never silently inherited from light.
          expect(darkOverrides.has(name), `dark is missing ${name}`).toBe(true)
        }
      }
    })

    it.each(STATUS_STATES)('light: --status-%s-text on --status-%s-surface meets WCAG AA (>= 4.5:1)', (state) => {
      const text = resolve(lightDecls.get(`--status-${state}-text`)!, lightDecls)
      const surface = resolve(lightDecls.get(`--status-${state}-surface`)!, lightDecls)
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5)
    })

    it.each(STATUS_STATES)('dark: --status-%s-text on --status-%s-surface meets WCAG AA (>= 4.5:1)', (state) => {
      const text = resolve(darkDecls.get(`--status-${state}-text`)!, darkDecls)
      const surface = resolve(darkDecls.get(`--status-${state}-surface`)!, darkDecls)
      expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5)
    })

    it('does not repeat the F12.6-03 failure (a ~2.2:1 warning pair)', () => {
      const text = resolve(lightDecls.get('--status-warning-text')!, lightDecls)
      const surface = resolve(lightDecls.get('--status-warning-surface')!, lightDecls)
      expect(contrast(text, surface)).toBeGreaterThan(4.5)
    })
  })
})
