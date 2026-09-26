/**
 * The shared frame of a master-data screen: title, primary action, toolbar,
 * and the card the records live in.
 *
 * Products, suppliers and customers differ in their columns and their form,
 * not in how a list page behaves, so the behaviour lives here once and the
 * differences stay in the three screens. The toolbar in particular is worth
 * sharing: a search box, a status filter and a sort control that all announce
 * themselves correctly is a surprisingly easy thing to get subtly wrong three
 * times.
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from '../../ui/Select'
import { ACTIVE_FILTERS, type ActiveFilter } from './masterData'

export interface SortOption {
  readonly id: string
  readonly label: string
}

export function PageHeading({
  title,
  subtitle,
  action,
}: {
  readonly title: string
  readonly subtitle: string
  readonly action?: ReactNode
}) {
  return (
    <header className="page__header">
      <div className="page__heading">
        <h1 className="page__title">{title}</h1>
        <p className="page__subtitle">{subtitle}</p>
      </div>
      {action}
    </header>
  )
}

export function ListToolbar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  sortOptions,
  searchLabel,
}: {
  readonly search: string
  readonly onSearchChange: (value: string) => void
  readonly filter: ActiveFilter
  readonly onFilterChange: (value: ActiveFilter) => void
  readonly sort: string
  readonly onSortChange: (value: string) => void
  readonly sortOptions: readonly SortOption[]
  readonly searchLabel: string
}) {
  const { t } = useTranslation()

  const filterLabel: Record<ActiveFilter, string> = {
    ALL: t('list.filterAll'),
    ACTIVE: t('list.filterActive'),
    INACTIVE: t('list.filterInactive'),
  }

  return (
    <div className="toolbar">
      <div className="field toolbar__search">
        <label className="field__label" htmlFor="master-search">
          {searchLabel}
        </label>
        <input
          id="master-search"
          className="input"
          type="search"
          value={search}
          placeholder={t('list.searchPlaceholder')}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>

      <div className="field">
        <span className="field__label" id="master-filter-label">
          {t('list.filterLabel')}
        </span>
        {/* A group of toggles rather than a <select>: three mutually exclusive
            options are faster to reach with one click than with two, and
            `aria-pressed` states them without needing a live region. */}
        <div className="segmented" role="group" aria-labelledby="master-filter-label">
          {ACTIVE_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className="segmented__option"
              aria-pressed={filter === option}
              onClick={() => onFilterChange(option)}
            >
              {filterLabel[option]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="master-sort">
          {t('list.sortLabel')}
        </label>
        <Select
          id="master-sort"
          value={sort}
          onChange={onSortChange}
          options={sortOptions.map((option) => ({ value: option.id, label: option.label }))}
        />
      </div>
    </div>
  )
}

/**
 * The row-count line under a list.
 *
 * Rendered in a polite live region so that a keyboard user who narrows the
 * search hears "Showing 3 of 41 records" instead of having to go hunting for
 * whether anything changed.
 */
export function ResultCount({ shown, total }: { readonly shown: number; readonly total: number }) {
  const { t } = useTranslation()
  return (
    <p className="text-sm text-muted" role="status" aria-live="polite">
      {t('list.showing', { count: shown, total })}
    </p>
  )
}
