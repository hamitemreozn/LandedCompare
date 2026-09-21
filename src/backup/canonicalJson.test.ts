/**
 * Canonical serialisation and prototype-safe parsing.
 *
 * The checksum is only worth having if the same logical payload always
 * produces the same bytes, so these tests attack determinism directly: the
 * same data assembled in a different order, the same keys assigned in reverse,
 * a value that `JSON.stringify` would happily mangle.
 */

import { describe, expect, it } from 'vitest'
import {
  assertJsonDepthWithin,
  assertTextWithinSizeLimit,
  canonicalize,
  parseUntrustedJson,
} from './canonicalJson'
import { BackupError } from './errors'
import { MAX_JSON_DEPTH, utf8ByteLength } from './limits'

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (cause) {
    return cause instanceof BackupError ? cause.code : `unexpected:${String(cause)}`
  }
  return 'did-not-throw'
}

describe('canonicalize', () => {
  it('sorts object keys so insertion order cannot reach the checksum', () => {
    const forwards = { alpha: 1, beta: 2, gamma: 3 }
    const backwards: Record<string, number> = {}
    backwards.gamma = 3
    backwards.beta = 2
    backwards.alpha = 1

    expect(canonicalize(forwards)).toBe('{"alpha":1,"beta":2,"gamma":3}')
    expect(canonicalize(backwards)).toBe(canonicalize(forwards))
  })

  it('preserves array order, because order is data', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 1, 2]))
  })

  it('sorts nested keys at every depth', () => {
    const value = { outer: { z: { b: 1, a: 2 }, a: [{ y: 1, x: 2 }] } }
    expect(canonicalize(value)).toBe('{"outer":{"a":[{"x":2,"y":1}],"z":{"a":2,"b":1}}}')
  })

  it('keeps decimal strings character-exact', () => {
    // The persisted contract for money and quantity. A serialiser that parsed
    // these into numbers would silently turn 3.335 into 3.3349999999999995.
    const value = { amount: '3.335', quantity: '12.345', trailing: '10.00' }
    expect(canonicalize(value)).toBe('{"amount":"3.335","quantity":"12.345","trailing":"10.00"}')
  })

  it('keeps timestamps character-exact', () => {
    expect(canonicalize({ at: '2026-09-19T18:32:11.482Z' })).toBe(
      '{"at":"2026-09-19T18:32:11.482Z"}',
    )
  })

  it('rejects undefined rather than guessing what it meant', () => {
    expect(codeOf(() => canonicalize({ a: undefined }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => canonicalize([undefined]))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects non-finite numbers, which JSON.stringify would turn into null', () => {
    expect(codeOf(() => canonicalize({ a: Number.NaN }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => canonicalize({ a: Number.POSITIVE_INFINITY }))).toBe(
      'CANONICALIZATION_FAILED',
    )
  })

  it('rejects functions and symbols', () => {
    expect(codeOf(() => canonicalize({ a: () => 1 }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => canonicalize({ a: Symbol('x') }))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects class instances, including ones with a toJSON', () => {
    class Wrapped {
      toJSON(): string {
        return 'looks-fine'
      }
    }
    expect(codeOf(() => canonicalize({ a: new Wrapped() }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => canonicalize({ a: new Date() }))).toBe('CANONICALIZATION_FAILED')
    expect(codeOf(() => canonicalize({ a: new Map() }))).toBe('CANONICALIZATION_FAILED')
  })

  it('rejects cycles instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    expect(codeOf(() => canonicalize(cyclic))).toBe('CANONICALIZATION_FAILED')
  })

  it('serialises the same value twice when it is shared but not cyclic', () => {
    const shared = { a: 1 }
    expect(canonicalize({ left: shared, right: shared })).toBe('{"left":{"a":1},"right":{"a":1}}')
  })

  it('rejects a forbidden key it is asked to emit', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}') as unknown
    expect(codeOf(() => canonicalize(hostile))).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('accepts an object with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.a = 1
    expect(canonicalize(bare)).toBe('{"a":1}')
  })

  it('refuses to serialise beyond the depth limit', () => {
    let deep: unknown = 1
    for (let level = 0; level <= MAX_JSON_DEPTH + 2; level += 1) {
      deep = { nested: deep }
    }
    expect(codeOf(() => canonicalize(deep))).toBe('BACKUP_TOO_DEEP')
  })

  it('is stable across a JSON round trip of the same logical value', () => {
    const value = { b: [1, '2', true, null], a: { z: '0.10', y: 3 } }
    const reparsed: unknown = JSON.parse(JSON.stringify(value))
    expect(canonicalize(reparsed)).toBe(canonicalize(value))
  })
})

describe('assertJsonDepthWithin', () => {
  it('accepts ordinary nesting', () => {
    expect(() => assertJsonDepthWithin('{"a":{"b":[{"c":1}]}}')).not.toThrow()
  })

  it('rejects a nesting bomb before JSON.parse ever sees it', () => {
    const bomb = '['.repeat(MAX_JSON_DEPTH + 5) + ']'.repeat(MAX_JSON_DEPTH + 5)
    expect(codeOf(() => assertJsonDepthWithin(bomb))).toBe('BACKUP_TOO_DEEP')
  })

  it('does not count brackets inside strings', () => {
    const text = `{"note":"${'['.repeat(MAX_JSON_DEPTH + 5)}"}`
    expect(() => assertJsonDepthWithin(text)).not.toThrow()
  })

  it('does not count a bracket after an escaped quote', () => {
    const text = '{"note":"he said \\"[[[[[\\" loudly"}'
    expect(() => assertJsonDepthWithin(text)).not.toThrow()
  })
})

describe('size limits', () => {
  it('rejects text beyond the cap', () => {
    expect(codeOf(() => assertTextWithinSizeLimit('x'.repeat(100), 10))).toBe('BACKUP_TOO_LARGE')
  })

  it('measures bytes, not characters, so multi-byte text cannot slip past', () => {
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('₺')).toBe(3)
    expect(utf8ByteLength('😀')).toBe(4)
    expect(utf8ByteLength('abc')).toBe(3)
    // Five characters, eleven bytes.
    expect(codeOf(() => assertTextWithinSizeLimit('a😀₺é', 8))).toBe('BACKUP_TOO_LARGE')
  })

  it('agrees with TextEncoder', () => {
    const text = 'Tedarikçi ₺ 12.345 😀 "quoted" \\ backslash'
    expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).byteLength)
  })
})

describe('parseUntrustedJson', () => {
  it('parses ordinary JSON', () => {
    expect(parseUntrustedJson('{"a":[1,2]}')).toEqual({ a: [1, 2] })
  })

  it('rejects malformed JSON with a specific code', () => {
    expect(codeOf(() => parseUntrustedJson('{"a":'))).toBe('BACKUP_MALFORMED_JSON')
    expect(codeOf(() => parseUntrustedJson('not json at all'))).toBe('BACKUP_MALFORMED_JSON')
    expect(codeOf(() => parseUntrustedJson(''))).toBe('BACKUP_MALFORMED_JSON')
  })

  it('rejects a __proto__ key anywhere in the document', () => {
    expect(codeOf(() => parseUntrustedJson('{"__proto__":{"polluted":true}}'))).toBe(
      'BACKUP_FORBIDDEN_KEY',
    )
    expect(
      codeOf(() => parseUntrustedJson('{"data":{"suppliers":[{"__proto__":{"x":1}}]}}')),
    ).toBe('BACKUP_FORBIDDEN_KEY')
  })

  it('rejects a constructor key', () => {
    expect(codeOf(() => parseUntrustedJson('{"constructor":{"prototype":{"x":1}}}'))).toBe(
      'BACKUP_FORBIDDEN_KEY',
    )
  })

  it('rejects a prototype key', () => {
    expect(codeOf(() => parseUntrustedJson('{"a":{"prototype":{"x":1}}}'))).toBe(
      'BACKUP_FORBIDDEN_KEY',
    )
  })

  it('leaves Object.prototype unpolluted after a rejected parse', () => {
    codeOf(() => parseUntrustedJson('{"__proto__":{"pollutedByBackup":true}}'))
    expect(({} as Record<string, unknown>).pollutedByBackup).toBeUndefined()
    expect(Object.prototype).not.toHaveProperty('pollutedByBackup')
  })

  it('accepts the strings "__proto__" and "constructor" as values', () => {
    // Only *keys* are dangerous. A supplier legitimately named "constructor"
    // must not make a backup unreadable.
    expect(parseUntrustedJson('{"displayName":"__proto__","note":"constructor"}')).toEqual({
      displayName: '__proto__',
      note: 'constructor',
    })
  })
})
