import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { Select, type SelectOption } from './Select'

afterEach(() => {
  cleanup()
})

const OPTIONS: readonly SelectOption[] = [
  { value: 'PIECE', label: 'Piece' },
  { value: 'BOX', label: 'Box' },
  { value: 'CARTON', label: 'Carton', disabled: true },
]

/** A controlled harness — `Select` itself is uncontrolled-in-the-DOM-sense but value-driven. */
function ControlledSelect({
  initial,
  options = OPTIONS,
  onChangeSpy,
  ...rest
}: {
  readonly initial: string
  readonly options?: readonly SelectOption[]
  readonly onChangeSpy?: (value: string) => void
  readonly id?: string
  readonly ariaLabel?: string
  readonly disabled?: boolean
  readonly placeholder?: string
}) {
  const [value, setValue] = useState(initial)
  return (
    <Select
      value={value}
      onChange={(next) => {
        setValue(next)
        onChangeSpy?.(next)
      }}
      options={options}
      {...rest}
    />
  )
}

describe('Select', () => {
  it('renders the current selected value as the trigger text', () => {
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" />)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveTextContent('Box')
  })

  it('shows the placeholder when the value matches no option', () => {
    render(<ControlledSelect initial="" ariaLabel="Unit" placeholder="Choose…" />)
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveTextContent('Choose…')
  })

  it('opens and lists every option, including a disabled one', async () => {
    const user = userEvent.setup()
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" />)
    await user.click(screen.getByRole('combobox', { name: 'Unit' }))

    expect(await screen.findByRole('option', { name: 'Piece' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Box' })).toBeInTheDocument()
    const carton = screen.getByRole('option', { name: 'Carton' })
    expect(carton).toHaveAttribute('data-disabled')
  })

  it('calls onChange with the picked value, and updates the trigger', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" onChangeSpy={onChangeSpy} />)

    await user.click(screen.getByRole('combobox', { name: 'Unit' }))
    await user.click(await screen.findByRole('option', { name: 'Piece' }))

    expect(onChangeSpy).toHaveBeenCalledWith('PIECE')
    expect(screen.getByRole('combobox', { name: 'Unit' })).toHaveTextContent('Piece')
  })

  it('a disabled option cannot be picked', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" onChangeSpy={onChangeSpy} />)

    await user.click(screen.getByRole('combobox', { name: 'Unit' }))
    await user.click(await screen.findByRole('option', { name: 'Carton' }))

    expect(onChangeSpy).not.toHaveBeenCalled()
  })

  it('supports keyboard: open, arrow to an option, Enter to pick it', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<ControlledSelect initial="PIECE" ariaLabel="Unit" onChangeSpy={onChangeSpy} />)

    const trigger = screen.getByRole('combobox', { name: 'Unit' })
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('option', { name: 'Piece' })).toBeInTheDocument()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(onChangeSpy).toHaveBeenCalledWith('BOX')
  })

  it('closes on Escape without picking anything, and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" onChangeSpy={onChangeSpy} />)

    const trigger = screen.getByRole('combobox', { name: 'Unit' })
    await user.click(trigger)
    await screen.findByRole('option', { name: 'Piece' })

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('option', { name: 'Piece' })).toBeNull()
    expect(onChangeSpy).not.toHaveBeenCalled()
    expect(trigger).toHaveFocus()
  })

  it('a disabled select cannot be opened', async () => {
    const user = userEvent.setup()
    render(<ControlledSelect initial="BOX" ariaLabel="Unit" disabled />)

    const trigger = screen.getByRole('combobox', { name: 'Unit' })
    expect(trigger).toHaveAttribute('data-disabled')
    await user.click(trigger)
    expect(screen.queryByRole('option', { name: 'Piece' })).toBeNull()
  })

  it('binds to a label via id, the same way a native form field does', () => {
    render(
      <>
        <label htmlFor="unit-field">Stock unit</label>
        <ControlledSelect initial="BOX" id="unit-field" />
      </>,
    )
    expect(screen.getByLabelText('Stock unit')).toHaveTextContent('Box')
  })

  it('round-trips an empty-string option (the Radix empty-value sentinel never leaks out)', async () => {
    const user = userEvent.setup()
    const onChangeSpy = vi.fn()
    const options: readonly SelectOption[] = [
      { value: '', label: 'No status' },
      { value: 'A', label: 'A' },
    ]
    render(<ControlledSelect initial="A" ariaLabel="Status" options={options} onChangeSpy={onChangeSpy} />)

    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: 'No status' }))

    // The caller sees exactly '', never the internal sentinel.
    expect(onChangeSpy).toHaveBeenCalledWith('')
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveTextContent('No status')
  })
})
