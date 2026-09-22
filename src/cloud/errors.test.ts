import { describe, expect, it } from 'vitest'
import { CLOUD_ERROR_TRANSLATION_KEY } from '../i18n/persistenceText'
import en from '../i18n/resources/en'
import tr from '../i18n/resources/tr'
import { CloudError, cloudErrorFromPostgrest, cloudErrorFromTransport } from './errors'

function codeOf(failure: Parameters<typeof cloudErrorFromPostgrest>[0]): string {
  return cloudErrorFromPostgrest(failure).code
}

describe('cloudErrorFromPostgrest', () => {
  it('maps the RPC detail rather than the message text', () => {
    // The RPCs raise with a `detail` naming the code, because message text is
    // the thing that gets reworded — and a client that pattern-matched on
    // English prose would break the first time somebody improved a sentence.
    expect(codeOf({ code: 'P0001', details: 'STALE_WRITE', message: 'anything at all' })).toBe(
      'STALE_WRITE',
    )
    expect(codeOf({ code: 'P0001', details: 'RECORD_INVALID', message: '' })).toBe('RECORD_INVALID')
    expect(codeOf({ code: 'P0001', details: 'FORBIDDEN', message: '' })).toBe('FORBIDDEN')
    expect(codeOf({ code: 'P0001', details: 'DUPLICATE_KEY', message: '' })).toBe('DUPLICATE_KEY')
  })

  it('maps the write gate to its own state, not to a generic failure', () => {
    // 55006 is `object_in_use`, chosen deliberately over a bare raise: it is a
    // standard class meaning "come back later", and it is the ONLY state in
    // which reading still works. Folding it into UNEXPECTED would tell a user
    // the system is down while they can still look things up.
    expect(codeOf({ code: '55006', message: 'organization is locked for maintenance' })).toBe(
      'ORGANIZATION_LOCKED',
    )
  })

  it('maps SQLSTATE classes the database raises without our help', () => {
    expect(codeOf({ code: '42501', message: '' })).toBe('FORBIDDEN')
    expect(codeOf({ code: '23505', message: '' })).toBe('DUPLICATE_KEY')
    expect(codeOf({ code: '23514', message: '' })).toBe('RECORD_INVALID')
    expect(codeOf({ code: '23502', message: '' })).toBe('RECORD_INVALID')
    expect(codeOf({ code: '23503', message: '' })).toBe('RECORD_NOT_FOUND')
  })

  it('treats an invalid or expired JWT as a session problem', () => {
    expect(codeOf({ code: 'PGRST301', message: 'JWT expired' })).toBe('SESSION_EXPIRED')
  })

  it('treats a missing route as a server fault, not a puzzling permission message', () => {
    // If `PGRST106` ever happens in production it means the exposed-schema list
    // drifted from the repository — a deployment fault. The user cannot act on
    // "invalid schema", and their administrator can act on "the server is not
    // what this build expects".
    expect(codeOf({ code: 'PGRST106', message: '' })).toBe('SERVER_UNAVAILABLE')
    expect(codeOf({ code: 'PGRST205', message: '' })).toBe('SERVER_UNAVAILABLE')
  })

  it('never lets an unrecognised message through as a message', () => {
    const mapped = cloudErrorFromPostgrest({
      code: '42P01',
      message: 'relation "app_data.products" does not exist',
    })
    expect(mapped.code).toBe('UNEXPECTED')
    // The developer-facing message exists; what matters is that the code — not
    // the message — is what the UI renders from, so a schema name never
    // reaches a screen.
    expect(CLOUD_ERROR_TRANSLATION_KEY[mapped.code]).toBe('cloudError.unexpected')
  })
})

describe('cloudErrorFromTransport', () => {
  it('distinguishes no network from an unreachable server', () => {
    // `TypeError: Failed to fetch` means both, so the two honest messages are
    // chosen with the browser's own connectivity signal — which is used ONLY to
    // pick a sentence, never to decide whether to attempt a request.
    expect(cloudErrorFromTransport(new TypeError('Failed to fetch'), false).code).toBe('OFFLINE')
    expect(cloudErrorFromTransport(new TypeError('Failed to fetch'), true).code).toBe(
      'SERVER_UNAVAILABLE',
    )
  })

  it('passes an already-classified error through unchanged', () => {
    const original = new CloudError('ORGANIZATION_LOCKED', 'locked')
    expect(cloudErrorFromTransport(original, true)).toBe(original)
  })
})

describe('the translation boundary', () => {
  it('maps every cloud code to a key that exists in both catalogues', () => {
    for (const [code, key] of Object.entries(CLOUD_ERROR_TRANSLATION_KEY)) {
      const resolve = (catalog: unknown) =>
        key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog)

      expect(typeof resolve(tr), `tr is missing ${key} for ${code}`).toBe('string')
      expect(typeof resolve(en), `en is missing ${key} for ${code}`).toBe('string')
    }
  })

  it('reuses the existing persistence sentences for the four shared codes', () => {
    // §24: `persistenceText.ts` EXTENDS rather than being replaced. "Bu kayıt
    // başka bir yerde değiştirildi" was written for two tabs on one machine and
    // is, if anything, more true for two people on two machines — so the
    // user-facing contract for a concurrent edit does not change at all when
    // the data moves to a server.
    expect(CLOUD_ERROR_TRANSLATION_KEY.STALE_WRITE).toBe('dataError.staleWrite')
    expect(CLOUD_ERROR_TRANSLATION_KEY.DUPLICATE_KEY).toBe('dataError.duplicateKey')
    expect(CLOUD_ERROR_TRANSLATION_KEY.RECORD_NOT_FOUND).toBe('dataError.recordNotFound')
    expect(CLOUD_ERROR_TRANSLATION_KEY.RECORD_INVALID).toBe('dataError.recordInvalid')
  })
})
