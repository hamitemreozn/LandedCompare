import { describe, expect, it } from 'vitest'
import { PersistenceError, classifyRequestFailure, isPersistenceError, toPersistenceError } from './errors'

/** A stand-in for the browser's DOMException; only `name` is ever read. */
function domException(name: string, message = 'browser text that must not reach the user'): Error {
  const error = new Error(message)
  error.name = name
  return error
}

describe('failure classification', () => {
  it('gives quota exhaustion its own code, separate from a generic failure', () => {
    // §2: "storage is full — export a backup and remove old snapshots" is a
    // different message with a different remedy, so it must be a different code.
    expect(classifyRequestFailure(domException('QuotaExceededError'))).toBe('QUOTA_EXCEEDED')
  })

  it('distinguishes a unique-index violation from an abort', () => {
    expect(classifyRequestFailure(domException('ConstraintError'))).toBe('DUPLICATE_KEY')
    expect(classifyRequestFailure(domException('AbortError'))).toBe('TRANSACTION_ABORTED')
  })

  it('maps a version downgrade onto the refusal code', () => {
    expect(classifyRequestFailure(domException('VersionError'))).toBe('SCHEMA_VERSION_TOO_NEW')
  })

  it('does not crash on a failure with no usable name', () => {
    expect(classifyRequestFailure(null)).toBe('TRANSACTION_ABORTED')
    expect(classifyRequestFailure('a string')).toBe('TRANSACTION_ABORTED')
    expect(classifyRequestFailure(undefined)).toBe('TRANSACTION_ABORTED')
  })
})

describe('error wrapping', () => {
  it('keeps an already-typed failure rather than flattening it', () => {
    const original = new PersistenceError('STALE_WRITE', 'refused', { details: { id: 'a' } })
    expect(toPersistenceError(original)).toBe(original)
  })

  it('keeps the raw browser failure as a cause, out of the structured details', () => {
    const raw = domException('QuotaExceededError', 'Quota exceeded: origin uses 11GB of 10GB')
    const wrapped = toPersistenceError(raw, { store: 'projects' })

    expect(wrapped.code).toBe('QUOTA_EXCEEDED')
    expect(wrapped.details).toEqual({ store: 'projects' })
    // The browser's own wording is locale- and vendor-specific and is not a
    // translatable string; it stays in `cause`, for a developer.
    expect(JSON.stringify(wrapped.details)).not.toContain('11GB')
    expect(wrapped.cause).toBe(raw)
  })

  it('carries only machine-readable details, never prose for the user', () => {
    const error = new PersistenceError('SCHEMA_VERSION_TOO_NEW', 'developer text', {
      details: { storedVersion: 4, supportedVersion: 1 },
    })
    expect(isPersistenceError(error)).toBe(true)
    for (const value of Object.values(error.details)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value)
    }
  })
})
