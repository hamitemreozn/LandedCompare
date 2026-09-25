import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { AppIconTile, BrandMark } from './Brand'
import en from '../i18n/resources/en'

afterEach(() => {
  cleanup()
})

describe('BrandMark', () => {
  it('renders the standard variant with the frozen brand colours', () => {
    const { container } = render(<BrandMark variant="standard" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(container.querySelector('circle')).toHaveAttribute('fill', '#C99A3D')
  })

  it('omits the dot on the small optical variant', () => {
    const { container } = render(<BrandMark variant="small" />)
    expect(container.querySelector('circle')).toBeNull()
  })

  it('is decorative by default and only exposes a label when asked', () => {
    const decorative = render(<BrandMark variant="standard" />)
    expect(decorative.container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    decorative.unmount()

    const labelled = render(<BrandMark variant="standard" title="LandedCompare" />)
    expect(labelled.container.querySelector('svg')).toHaveAttribute('aria-label', 'LandedCompare')
  })

  // F12.6-04 / F12.6-01: locks in the frozen per-variant colours so a future
  // edit can't silently drift the dark/tile optical C colour (#8FA3FF) onto
  // the dark-theme *action* blue (#6C86FF) — visually adjacent, semantically
  // distinct, and F12.6-01 explicitly rejected merging them.
  it.each([
    ['standard', '#1B2A55', '#3557F3', '#C99A3D'],
    ['small', '#1B2A55', '#3557F3', undefined],
    ['mono', '#12172B', '#12172B', '#12172B'],
    ['dark', '#FFFFFF', '#8FA3FF', '#C99A3D'],
  ] as const)('variant="%s" uses its frozen L/C/dot colours, not #6C86FF', (variant, lStroke, cStroke, dot) => {
    const { container } = render(<BrandMark variant={variant} />)
    const paths = container.querySelectorAll('path')
    expect(paths[0]).toHaveAttribute('stroke', lStroke)
    expect(paths[1]).toHaveAttribute('stroke', cStroke)
    if (dot === undefined) {
      expect(container.querySelector('circle')).toBeNull()
    } else {
      expect(container.querySelector('circle')).toHaveAttribute('fill', dot)
    }
    expect(container.innerHTML).not.toContain('#6C86FF')
  })
})

describe('AppIconTile', () => {
  it('renders as a decorative tile by default', () => {
    const { container } = render(<AppIconTile />)
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('rect')).toHaveAttribute('fill', '#1B2A55')
  })

  it('places the exact master monogram geometry (scaled), never a redrawn L/C', () => {
    const master = render(<BrandMark variant="standard" />)
    const masterPaths = [...master.container.querySelectorAll('path')].map((path) => path.getAttribute('d'))
    const masterDot = master.container.querySelector('circle')!
    master.unmount()

    const tile = render(<AppIconTile />)
    const tilePaths = [...tile.container.querySelectorAll('path')].map((path) => path.getAttribute('d'))
    const tileDot = tile.container.querySelector('circle')!

    expect(tilePaths).toEqual(masterPaths)
    expect(tileDot).toHaveAttribute('cx', masterDot.getAttribute('cx'))
    expect(tileDot).toHaveAttribute('cy', masterDot.getAttribute('cy'))
    expect(tileDot).toHaveAttribute('r', masterDot.getAttribute('r'))

    // The only thing tile-specific is the centring/scaling transform.
    expect(tile.container.querySelector('g')).toHaveAttribute('transform', 'translate(9.6,8) scale(0.8)')
  })

  it('uses the approved #8FA3FF optical C colour, never the dark-theme action blue #6C86FF', () => {
    const { container } = render(<AppIconTile />)
    const paths = container.querySelectorAll('path')
    expect(paths[1]).toHaveAttribute('stroke', '#8FA3FF')
    expect(container.innerHTML).not.toContain('#6C86FF')
  })
})

describe('product wordmark casing', () => {
  it('is exactly "LandedCompare" (PascalCase) in the English resource', () => {
    expect(en.common.appName).toBe('LandedCompare')
  })
})
