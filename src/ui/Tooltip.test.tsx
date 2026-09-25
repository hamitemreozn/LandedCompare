import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tooltip } from './Tooltip'

afterEach(() => {
  cleanup()
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Tooltip', () => {
  it('connects the trigger to the tooltip text via aria-describedby', () => {
    render(
      <Tooltip content="Filter results">
        <button type="button" aria-label="Filter">
          F
        </button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Filter' })
    const describedBy = button.getAttribute('aria-describedby')
    expect(describedBy).not.toBeNull()
    expect(document.getElementById(describedBy!)).toHaveTextContent('Filter results')
  })

  it('merges into an existing aria-describedby instead of replacing it', () => {
    render(
      <Tooltip content="Filter results">
        <button type="button" aria-label="Filter" aria-describedby="existing-hint">
          F
        </button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Filter' })
    const ids = button.getAttribute('aria-describedby')!.split(' ')
    expect(ids).toContain('existing-hint')
    // No duplicate ids, and the tooltip's own id resolves to its text.
    expect(new Set(ids).size).toBe(ids.length)
    const tooltipId = ids.find((candidate) => candidate !== 'existing-hint')!
    expect(document.getElementById(tooltipId)).toHaveTextContent('Filter results')
  })

  it('becomes visible on keyboard focus, not only on hover', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Filter results">
        <button type="button" aria-label="Filter">
          F
        </button>
      </Tooltip>,
    )
    const tooltip = screen.getByRole('tooltip', { hidden: true })
    expect(tooltip).not.toHaveAttribute('data-visible', 'true')

    await user.tab()
    expect(tooltip).toHaveAttribute('data-visible', 'true')

    await user.tab()
    expect(tooltip).not.toHaveAttribute('data-visible', 'true')
  })

  it('dismisses on Escape without moving focus, and can reappear on the next interaction', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Filter results">
        <button type="button" aria-label="Filter">
          F
        </button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Filter' })
    const tooltip = screen.getByRole('tooltip', { hidden: true })

    await user.tab()
    expect(tooltip).toHaveAttribute('data-visible', 'true')
    expect(document.activeElement).toBe(button)

    await user.keyboard('{Escape}')
    expect(tooltip).not.toHaveAttribute('data-visible', 'true')
    // Escape never moves focus.
    expect(document.activeElement).toBe(button)

    // A fresh trigger interaction (blur, then focus again) brings it back.
    button.blur()
    expect(tooltip).not.toHaveAttribute('data-visible', 'true')
    await user.tab()
    expect(document.activeElement).toBe(button)
    expect(tooltip).toHaveAttribute('data-visible', 'true')
  })

  it('stays open while the pointer moves from the trigger onto the tooltip content (hoverable)', async () => {
    const user = userEvent.setup()
    render(
      <Tooltip content="Filter results">
        <button type="button" aria-label="Filter">
          F
        </button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Filter' })
    const tooltip = screen.getByRole('tooltip', { hidden: true })

    await user.hover(button)
    expect(tooltip).toHaveAttribute('data-visible', 'true')

    await user.unhover(button)
    await user.hover(tooltip)
    // Past the hide delay: still visible because the pointer landed on the
    // tooltip itself before the delayed hide fired.
    await wait(250)
    expect(tooltip).toHaveAttribute('data-visible', 'true')

    await user.unhover(tooltip)
    await wait(250)
    expect(tooltip).not.toHaveAttribute('data-visible', 'true')
  })
})
