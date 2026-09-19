import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import i18n, { DEFAULT_LOCALE, setLocale } from './i18n'

describe('App', () => {
  afterEach(async () => {
    await setLocale(DEFAULT_LOCALE)
  })

  it('renders the placeholder heading', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'LandedCompare' })).toBeInTheDocument()
  })

  it('switches the rendered language immediately when EN/TR is clicked', async () => {
    const user = userEvent.setup()
    await setLocale('en')
    render(<App />)

    expect(screen.getByText('Under development.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Türkçe' }))
    expect(await screen.findByText('Geliştirme aşamasında.')).toBeInTheDocument()
    expect(i18n.language).toBe('tr')

    await user.click(screen.getByRole('button', { name: 'English' }))
    expect(await screen.findByText('Under development.')).toBeInTheDocument()
    expect(i18n.language).toBe('en')
  })

  it('persists the selected language preference across reload', async () => {
    const user = userEvent.setup()
    await setLocale('en')
    render(<App />)

    await user.click(screen.getByRole('button', { name: 'Türkçe' }))
    expect(window.localStorage.getItem('landedcompare.locale')).toBe('tr')
  })
})
