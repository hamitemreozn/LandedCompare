/**
 * The product record form.
 *
 * ## Written for the person who will actually use it
 *
 * The pilot user runs a purchasing department, not a database. Three things in
 * this form used to be correct and unreadable, and the fix in each case was
 * wording and shape rather than data:
 *
 * - **"Stok Birimi"** reads to a non-technical user as a *place* — a warehouse,
 *   a shelf. It is a counting unit, so it is now a dropdown of the units a
 *   warehouse actually counts in (Adet, Kutu, Koli, Metre…) with "Diğer…" for
 *   anything else, and a hint that asks the question directly.
 * - **"Satın Alma Birimi Başına Stok Birimi"** is a schema field name. The
 *   question it asks is "1 satın alma biriminde kaç stok birimi var?", and
 *   once both units are chosen the form reads the answer back — *1 Kutu = 50
 *   Adet* — which is the form of the sentence the user already thinks in.
 * - **"Açıklama" vs "Not"** were indistinguishable. They are now "Ürün
 *   Açıklaması" (what the product is) and "İç Not" (what the company needs to
 *   remember about it), each with a one-line hint, sitting next to each other
 *   so the contrast is visible.
 *
 * None of this changes a persisted field. `stockUnit` is still a string,
 * `unitsPerPurchaseUnit` is still an exact `Quantity`, `description` and `note`
 * are still the same two optional strings.
 *
 * ## Explicit Save, not autosave
 *
 * Phase 7 built an autosave engine and this form does not use it. That is a
 * decision, not an omission. Autosave is right for a long-lived working
 * document — a project with its requirements and quotes, where losing ten
 * minutes of typing to a closed tab is the failure mode worth engineering
 * against. A master record is a handful of fields, entered once, and its SKU is
 * unique: autosaving it would mean a half-typed SKU racing the uniqueness
 * check on every keystroke, and a `DUPLICATE_KEY` error appearing and
 * disappearing while the user is still typing the code. Explicit Save is what
 * a professional business form does, and it is what the stale-write contract
 * is shaped for — one save, one `previousUpdatedAt`, one answer.
 *
 * ## The three ways a save can fail, and why they are shown differently
 *
 * - **A field is invalid.** Shown on the field, which is where it can be
 *   fixed. The form validates before it submits, so this is usually caught
 *   without touching the database at all.
 * - **The SKU is taken.** Also shown on the field, because it *is* a field
 *   problem — but it can only be discovered by the store, inside the
 *   transaction, which is the only place the answer cannot be raced.
 * - **The record changed elsewhere.** A banner with a reload action, never a
 *   field error and never a silent merge. `docs/LOCAL_PERSISTENCE_AND_BACKUP.md`
 *   §5 is explicit: detect and refuse; resolving the conflict is the user's
 *   job, and the UI's job is to say so and offer the fresh copy.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppRuntime } from '../../app/runtime'
import type { ProductRecord } from '../../persistence'
import { formatInstant } from '../../i18n/format'
import { getLocale, type SupportedLocale } from '../../i18n'
import {
  CheckboxField,
  FormSection,
  TextAreaField,
  TextField,
  UnitSelectField,
} from '../../ui/Field'
import { Banner } from '../../ui/Feedback'
import { formatDecimalForInput, parseDecimalInput } from '../shared/decimalInput'
import { isFormValidationError } from '../shared/formError'
import { CANONICAL_UNITS, unitLabel, UNIT_TRANSLATION_KEY } from '../shared/units'
import {
  errorCodeOf,
  isDuplicateKey,
  isStaleWrite,
  useDataErrorMessage,
} from '../shared/useDataErrorMessage'
import {
  createProduct,
  loadProduct,
  productDraftFrom,
  updateProduct,
  type ProductDraft,
} from './productService'

export function ProductForm({
  existing,
  initialDraft,
  locale,
  onCancel,
  onSaved,
}: {
  readonly existing?: ProductRecord
  readonly initialDraft: ProductDraft
  readonly locale: SupportedLocale
  readonly onCancel: () => void
  readonly onSaved: () => void
}) {
  const { t } = useTranslation()
  const { database } = useAppRuntime()
  const describeError = useDataErrorMessage()

  const [record, setRecord] = useState(existing)
  const [draft, setDraft] = useState(initialDraft)
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({})
  const [failure, setFailure] = useState<unknown>(undefined)
  const [busy, setBusy] = useState(false)

  // The predefined units: a locale-independent code to store, a translated
  // label to read. Ordered by how often a trading company reaches for them
  // rather than alphabetically — the first three are the answer most of the
  // time.
  const unitOptions = useMemo(
    () => CANONICAL_UNITS.map((unit) => ({ value: unit, label: t(UNIT_TRANSLATION_KEY[unit]) })),
    [t],
  )

  /**
   * Re-expresses the half-typed pack factor when the interface language
   * changes underneath an open form.
   *
   * Without this, a Turkish `1,500` — one and a half — stays on screen when
   * the user switches to English, where a comma before three digits is the one
   * shape the parser refuses. The value was entered correctly and would be
   * rejected for a reason that has nothing to do with it. Nothing is stored
   * here and nothing is recomputed: the text is read with the locale it was
   * typed in and written back in the new one.
   */
  const draftLocale = useRef(locale)
  useEffect(() => {
    const previous = draftLocale.current
    if (previous === locale) {
      return
    }
    draftLocale.current = locale
    setDraft((current) => {
      const text = current.unitsPerPurchaseUnit.trim()
      if (text === '') {
        return current
      }
      const parsed = parseDecimalInput(text, previous)
      // An unreadable value is left exactly as the user typed it; rewriting it
      // would be this function guessing at something it just failed to read.
      return parsed.ok
        ? { ...current, unitsPerPurchaseUnit: formatDecimalForInput(parsed.canonical, locale) }
        : current
    })
  }, [locale])

  const set = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setFieldErrors((current) => {
      if (!(key in current)) {
        return current
      }
      const next = { ...current }
      delete next[key as string]
      return next
    })
  }

  /** Cheap, local checks. The authoritative ones run inside the transaction. */
  const validate = (): boolean => {
    const errors: Record<string, string> = {}
    if (draft.sku.trim() === '') {
      errors.sku = t('form.requiredField')
    }
    if (draft.name.trim() === '') {
      errors.name = t('form.requiredField')
    }
    if (draft.stockUnit.trim() === '') {
      errors.stockUnit = t('form.requiredField')
    }
    const factor = draft.unitsPerPurchaseUnit.trim()
    if (factor !== '') {
      // The same parser the service uses, so what the form accepts and what
      // the service can build never drift apart. A Turkish "12,5" is read as
      // the decimal it is; the one genuinely two-way shape is named rather
      // than guessed at.
      const parsed = parseDecimalInput(factor, locale)
      if (!parsed.ok) {
        errors.unitsPerPurchaseUnit =
          parsed.reason === 'AMBIGUOUS_SEPARATOR'
            ? t('form.ambiguousSeparator', { value: factor })
            : t('form.mustBeNumber')
      } else if (Number(parsed.canonical) === 0) {
        errors.unitsPerPurchaseUnit = t('form.mustBePositive')
      }
    }
    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setFailure(undefined)
    if (!validate()) {
      return
    }

    setBusy(true)
    try {
      if (record === undefined) {
        await createProduct(database, draft, { locale })
      } else {
        await updateProduct(database, record, draft, { locale })
      }
      // Only now — the transaction has committed.
      onSaved()
    } catch (cause) {
      if (isDuplicateKey(cause)) {
        setFieldErrors({ sku: t('product.duplicateSku') })
      } else if (isFormValidationError(cause)) {
        setFieldErrors({ [cause.field]: t(cause.messageKey) })
      } else {
        setFailure(cause)
      }
    } finally {
      setBusy(false)
    }
  }

  /** Replaces the form's baseline with the copy that is actually stored. */
  const reloadRecord = async () => {
    if (record === undefined) {
      return
    }
    setBusy(true)
    try {
      const fresh = await loadProduct(database, record.id)
      setRecord(fresh)
      setDraft(productDraftFrom(fresh, locale))
      setFailure(undefined)
    } catch (cause) {
      setFailure(cause)
    } finally {
      setBusy(false)
    }
  }

  const code = errorCodeOf(failure)

  /**
   * The read-back sentence — "1 Kutu = 50 Adet" — shown only when all three
   * parts of it are real.
   *
   * The units are rendered through `unitLabel`, so a canonical `BOX` reads as
   * "Kutu" or "Box" and a company's own "Rulo" reads as "Rulo" in both. The
   * amount is echoed exactly as typed, which makes this the place a
   * misunderstood separator becomes visible before the record is saved: an
   * input the parser refuses produces no sentence at all.
   */
  const conversionExample = useMemo(() => {
    const factor = draft.unitsPerPurchaseUnit.trim()
    if (draft.stockUnit.trim() === '' || draft.defaultPurchaseUnit.trim() === '' || factor === '') {
      return undefined
    }
    const parsed = parseDecimalInput(factor, locale)
    if (!parsed.ok || Number(parsed.canonical) === 0) {
      return undefined
    }
    return t('product.conversionExample', {
      purchaseUnit: unitLabel(draft.defaultPurchaseUnit.trim(), t),
      amount: factor,
      stockUnit: unitLabel(draft.stockUnit.trim(), t),
    })
  }, [draft.stockUnit, draft.defaultPurchaseUnit, draft.unitsPerPurchaseUnit, locale, t])

  return (
    <form className="card" onSubmit={(event) => void onSubmit(event)} noValidate>
      <div className="card__header">
        <h2 className="card__title">
          {record === undefined ? t('product.newProduct') : t('form.editRecord')}
        </h2>
        {record !== undefined ? (
          <span className="text-sm text-muted">
            {t('form.updatedAt')}: {formatInstant(record.updatedAt, getLocale())}
          </span>
        ) : null}
      </div>

      <div className="card__body">
        {failure !== undefined ? (
          <Banner
            tone="danger"
            label={t('form.saveFailed')}
            note={code === undefined ? undefined : `${t('boot.errorCode')}: ${code}`}
            actions={
              isStaleWrite(failure) ? (
                <button
                  type="button"
                  className="button button--small"
                  onClick={() => void reloadRecord()}
                  disabled={busy}
                >
                  {t('form.reloadRecord')}
                </button>
              ) : undefined
            }
          >
            {describeError(failure)}
          </Banner>
        ) : null}

        <p className="form-note">{t('form.requiredNote')}</p>

        <FormSection title={t('product.sectionDetails')}>
          <TextField
            label={t('product.sku')}
            hint={t('product.skuHint')}
            value={draft.sku}
            error={fieldErrors.sku}
            required
            onChange={(value) => set('sku', value)}
            autoFocus
          />
          <TextField
            label={t('product.name')}
            value={draft.name}
            error={fieldErrors.name}
            required
            onChange={(value) => set('name', value)}
          />
          <UnitSelectField
            label={t('product.stockUnit')}
            hint={t('product.stockUnitHint')}
            value={draft.stockUnit}
            error={fieldErrors.stockUnit}
            required
            options={unitOptions}
            chooseLabel={t('unitField.choose')}
            otherLabel={t('unitField.other')}
            customLabel={t('unitField.customLabel')}
            customPlaceholder={t('unitField.customPlaceholder')}
            onChange={(value) => set('stockUnit', value)}
          />
          <TextField
            label={t('product.manufacturer')}
            value={draft.manufacturer}
            onChange={(value) => set('manufacturer', value)}
          />
          <TextField
            label={t('product.manufacturerRef')}
            value={draft.manufacturerRef}
            onChange={(value) => set('manufacturerRef', value)}
          />
          <TextAreaField
            label={t('product.description')}
            hint={t('product.descriptionHint')}
            value={draft.description}
            rows={3}
            wide
            onChange={(value) => set('description', value)}
          />
          <TextAreaField
            label={t('product.internalNote')}
            hint={t('product.internalNoteHint')}
            value={draft.note}
            rows={3}
            wide
            onChange={(value) => set('note', value)}
          />
        </FormSection>

        <FormSection title={t('product.sectionPurchasing')}>
          <UnitSelectField
            label={t('product.defaultPurchaseUnit')}
            hint={t('product.defaultPurchaseUnitHint')}
            value={draft.defaultPurchaseUnit}
            options={unitOptions}
            chooseLabel={t('unitField.choose')}
            otherLabel={t('unitField.other')}
            customLabel={t('unitField.customLabel')}
            customPlaceholder={t('unitField.customPlaceholder')}
            onChange={(value) => set('defaultPurchaseUnit', value)}
          />
          <TextField
            label={t('product.unitsPerPurchaseUnit')}
            hint={t('product.unitsPerPurchaseUnitHint')}
            value={draft.unitsPerPurchaseUnit}
            error={fieldErrors.unitsPerPurchaseUnit}
            inputMode="decimal"
            onChange={(value) => set('unitsPerPurchaseUnit', value)}
            extra={
              conversionExample === undefined ? undefined : (
                // Announced politely: it changes as the user types, and a
                // silent read-back helps nobody who cannot see it.
                <span className="conversion-example" role="status" aria-live="polite">
                  {conversionExample}
                </span>
              )
            }
          />
        </FormSection>

        {/*
          The Active control appears only when editing. A product being created
          is active — nobody adds one to the catalogue in order to have it
          hidden — and a checkbox whose answer is always the same is a question
          that should not be asked. Deactivation stays available from the list.
        */}
        {record !== undefined ? (
          <CheckboxField
            label={t('common.active')}
            hint={t('lifecycle.notADeletion')}
            checked={draft.active}
            onChange={(checked) => set('active', checked)}
          />
        ) : null}

        <p className="field__hint">{t('product.noStockHere')}</p>
      </div>

      <div className="form-actions">
        <span className="form-actions__spacer" />
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </form>
  )
}
