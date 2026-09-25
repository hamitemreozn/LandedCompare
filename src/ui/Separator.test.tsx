import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { Separator } from './Separator'

afterEach(() => {
  cleanup()
})

describe('Separator', () => {
  it('is decorative (role="none") by default, so it is not announced as structure', () => {
    const { container } = render(<Separator />)
    expect(container.firstChild).toHaveAttribute('role', 'none')
  })

  it('exposes separator semantics and orientation when marked non-decorative', () => {
    const { container } = render(<Separator orientation="vertical" decorative={false} />)
    const el = container.firstChild as HTMLElement
    expect(el).toHaveAttribute('role', 'separator')
    expect(el).toHaveAttribute('aria-orientation', 'vertical')
  })
})
