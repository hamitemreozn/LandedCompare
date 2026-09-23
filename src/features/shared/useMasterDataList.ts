/**
 * The mechanics every master-data list needs: load, search, filter, sort,
 * reload.
 *
 * Three screens share this rather than each growing their own copy, and the
 * part worth being explicit about is **reload**, not the filtering.
 *
 * ## Persist first, then reflect
 *
 * After a create, an edit or a deactivation, the screen calls `reload()` and
 * the list is read back from the authoritative cloud view. It does **not** splice the returned
 * record into the array it already has.
 *
 * That is slower and it is correct. An optimistic update renders a success the
 * server may have refused — a stale write, a duplicate SKU, or a transaction
 * that rolled back — and
 * the screen would then be showing a row that does not exist. At pilot volume
 * the re-read is a single-digit-millisecond scan over records that are about
 * to be rendered anyway. The user sees what is stored, or they see the error;
 * never a third thing.
 *
 * The records themselves are held in React state and are **not** a cache: they
 * are the result of the last read, discarded and replaced by the next one.
 * PostgreSQL remains the only durable source of truth.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppRuntime } from '../../app/runtime'
import type { DataGateway } from '../../cloud'
import type { SupportedLocale } from '../../i18n'
import {
  countActive,
  matchesActiveFilter,
  matchesSearch,
  type ActiveCounts,
  type ActiveFilter,
} from './masterData'

export type ListStatus = 'LOADING' | 'READY' | 'ERROR'

export interface MasterDataRecord {
  readonly id: string
  readonly active: boolean
  readonly updatedAt: string
}

export type SortComparator<T> = (a: T, b: T, locale: SupportedLocale) => number

export interface MasterDataListOptions<T extends MasterDataRecord> {
  readonly load: (gateway: DataGateway, organizationId: string) => Promise<readonly T[]>
  /** The fields a search term is matched against, in display order. */
  readonly searchFields: (record: T) => readonly (string | undefined)[]
  readonly sorts: Readonly<Record<string, SortComparator<T>>>
  readonly defaultSort: string
  /** The active UI locale, so sorting and case folding follow it. */
  readonly locale: SupportedLocale
}

export interface MasterDataList<T extends MasterDataRecord> {
  readonly status: ListStatus
  readonly loadError: unknown
  /** Everything stored, unfiltered. The dashboard counts come from this. */
  readonly all: readonly T[]
  /** What the current search, filter and sort actually produce. */
  readonly visible: readonly T[]
  readonly counts: ActiveCounts
  readonly search: string
  readonly setSearch: (value: string) => void
  readonly filter: ActiveFilter
  readonly setFilter: (value: ActiveFilter) => void
  readonly sort: string
  readonly setSort: (value: string) => void
  readonly reload: () => Promise<void>
}

export function useMasterDataList<T extends MasterDataRecord>(
  options: MasterDataListOptions<T>,
): MasterDataList<T> {
  const { gateway, organization } = useAppRuntime()
  const { load, searchFields, sorts, defaultSort, locale } = options

  const [all, setAll] = useState<readonly T[]>([])
  const [status, setStatus] = useState<ListStatus>('LOADING')
  const [loadError, setLoadError] = useState<unknown>(undefined)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ActiveFilter>('ACTIVE')
  const [sort, setSort] = useState(defaultSort)

  const reload = useCallback(async () => {
    try {
      const records = await load(gateway, organization.id)
      setAll(records)
      setLoadError(undefined)
      setStatus('READY')
    } catch (cause) {
      setLoadError(cause)
      setStatus('ERROR')
    }
  }, [gateway, organization.id, load])

  useEffect(() => {
    void reload()
  }, [reload])

  const visible = useMemo(() => {
    const comparator = sorts[sort] ?? sorts[defaultSort]
    const filtered = all.filter(
      (record) =>
        matchesActiveFilter(record.active, filter) &&
        matchesSearch(searchFields(record), search, locale),
    )
    // Copied before sorting: `all` is state and sorting in place would mutate
    // the array React is holding, which makes the next render's comparison
    // meaningless.
    return comparator === undefined
      ? filtered
      : [...filtered].sort((a, b) => comparator(a, b, locale))
  }, [all, filter, search, sort, sorts, defaultSort, searchFields, locale])

  const counts = useMemo(() => countActive(all), [all])

  return {
    status,
    loadError,
    all,
    visible,
    counts,
    search,
    setSearch,
    filter,
    setFilter,
    sort,
    setSort,
    reload,
  }
}
