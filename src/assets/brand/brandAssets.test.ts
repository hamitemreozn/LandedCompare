/**
 * Regression coverage for the frozen source SVG files (F12.6-04): nothing
 * here should be able to drift away from the master geometry without a test
 * failing, since these files are hand-edited, not generated.
 *
 * Master geometry (docs/DESIGN_SYSTEM.md, "Master mark"):
 *   L:   M15 16 L15 44 L29 44
 *   C:   M29 28.06 A12 12 0 1 1 29 43.94
 *   dot: cx=29 cy=44 r=3.2
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MASTER_L = 'M15 16 L15 44 L29 44'
const MASTER_C = 'M29 28.06 A12 12 0 1 1 29 43.94'
const MASTER_DOT = 'cx="29" cy="44" r="3.2"'

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf-8')
}

describe('brand mark source assets — master geometry', () => {
  it.each([
    ['src/assets/brand/lc-mark.svg', '#1B2A55', '#3557F3'],
    ['src/assets/brand/lc-mark-dark.svg', '#FFFFFF', '#8FA3FF'],
    ['src/assets/brand/lc-mark-mono.svg', '#12172B', '#12172B'],
  ] as const)('%s carries the exact master L/C paths and a gold dot', (path, lStroke, cStroke) => {
    const svg = read(path)
    expect(svg).toContain(MASTER_L)
    expect(svg).toContain(MASTER_C)
    expect(svg).toContain(MASTER_DOT)
    expect(svg).toContain(`stroke="${lStroke}"`)
    expect(svg).toContain(`stroke="${cStroke}"`)
  })

  it.each(['src/assets/brand/lc-mark-small.svg', 'public/favicon.svg'] as const)(
    '%s (small optical variant) uses the master L/C paths, stroke-width 9, and no gold dot',
    (path) => {
      const svg = read(path)
      expect(svg).toContain(MASTER_L)
      expect(svg).toContain(MASTER_C)
      expect(svg).toContain('stroke="#1B2A55"')
      expect(svg).toContain('stroke="#3557F3"')
      expect(svg).toContain('stroke-width="9"')
      expect(svg).not.toContain('circle')
      expect(svg).not.toContain(MASTER_DOT)
    },
  )

  it('app-icon.svg places the exact master L/C/dot inside a scaled group, never a redrawn geometry', () => {
    const svg = read('src/assets/brand/app-icon.svg')
    expect(svg).toContain(MASTER_L)
    expect(svg).toContain(MASTER_C)
    expect(svg).toContain(MASTER_DOT)
    expect(svg).toContain('fill="#1B2A55"') // tile background
    expect(svg).toContain('stroke="#FFFFFF"') // L, tile-specific colour
    // F12.6-01: the dark/tile optical C colour is #8FA3FF, approved and
    // frozen — #6C86FF (the dark-theme *action* colour) must never replace
    // it here; the two are visually adjacent but semantically distinct.
    expect(svg).toContain('stroke="#8FA3FF"')
    expect(svg).not.toContain('#6C86FF')
    expect(svg).toContain('fill="#C99A3D"') // dot
  })

  it('no source SVG substitutes the dark-theme action blue (#6C86FF) for the approved optical C colour (#8FA3FF)', () => {
    for (const path of [
      'src/assets/brand/lc-mark.svg',
      'src/assets/brand/lc-mark-small.svg',
      'src/assets/brand/lc-mark-mono.svg',
      'src/assets/brand/lc-mark-dark.svg',
      'src/assets/brand/app-icon.svg',
      'public/favicon.svg',
    ]) {
      expect(read(path)).not.toContain('#6C86FF')
    }
  })
})
