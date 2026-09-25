import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Icons } from './icons'

describe('Icons', () => {
  it('maps every navigation concept to a renderable icon', () => {
    for (const [name, Icon] of Object.entries(Icons)) {
      const { container } = render(<Icon aria-hidden="true" />)
      expect(container.querySelector('svg'), `Icons.${name} did not render an <svg>`).not.toBeNull()
    }
  })
})
