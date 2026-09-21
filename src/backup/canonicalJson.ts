/**
 * Deterministic JSON, and prototype-safe parsing of untrusted JSON.
 *
 * ## Why canonical serialisation exists
 *
 * The backup's integrity value is a SHA-256 over the payload
 * (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §7). A hash is only useful if the
 * same logical payload always produces the same bytes, and `JSON.stringify`
 * does not promise that: it emits object keys in property-insertion order, so
 * two databases holding identical data would checksum differently purely
 * because their records were written in a different sequence.
 *
 * So `canonicalize()` fixes the one thing that is arbitrary — object key order
 * — and refuses everything whose serialisation would be ambiguous:
 *
 * | Input | Treatment |
 * | --- | --- |
 * | object keys | sorted by code unit; the value's own order is never used |
 * | arrays | order preserved — it is data, not incidental |
 * | `undefined` | rejected; "absent" is an absent key, never a present `undefined` |
 * | `NaN` / `±Infinity` | rejected; `JSON.stringify` turns them into `null` |
 * | functions, symbols, `bigint` | rejected |
 * | class instances (`Money`, `Date`, `Map`, …) | rejected — only plain objects |
 * | cycles | rejected |
 * | `__proto__` / `constructor` / `prototype` keys | rejected |
 *
 * Rejecting a class instance matters more than it looks. `Money` and
 * `Quantity` have a `toJSON()`, so `JSON.stringify` would silently accept them
 * and the checksum would then depend on decimal.js internals. The persisted
 * contract is the decimal *string*; refusing the instance is what keeps it
 * that way.
 *
 * Financial values need no special handling here precisely because they are
 * already strings by the time they reach this file — a string is copied
 * character for character, so `"3.335"` never becomes `3.335`.
 *
 * ## Why parsing is in the same file
 *
 * Canonicalisation and parsing share one rule set (the forbidden keys, the
 * depth bound), and keeping them apart is how the two drift.
 */

import { BackupError } from './errors'
import { MAX_JSON_DEPTH, MAX_BACKUP_BYTES, utf8ByteLength } from './limits'

/**
 * Keys that may not appear in stored or transported data, matching
 * `src/persistence/validation.ts`.
 *
 * `JSON.parse` does not itself pollute `Object.prototype` — it creates
 * `__proto__` as an own data property — but a later spread, `Object.assign`,
 * or a `for…in` copy of that object does. Prototype pollution is the realistic
 * attack on a JSON importer, and the cheapest place to close it is the one
 * gate every byte passes through.
 */
export const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype']

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.includes(key)
}

export function forbiddenKeyFailure(path: string, key: string): BackupError {
  return new BackupError('BACKUP_FORBIDDEN_KEY', `Forbidden key "${key}" at "${path}"`, {
    details: { path, key },
  })
}

/**
 * The single rejection used by everything that enforces this file's rule set.
 *
 * Exported because `canonicalize` is not the only place the rules apply.
 * `normaliseStoredValue` in `businessData.ts` enforces the same table one step
 * earlier — on the values read out of IndexedDB, before a payload is assembled
 * — and it has to refuse for the same reasons with the same code, or the two
 * boundaries would disagree about what "serialisable" means.
 */
export function canonicalizationFailure(path: string, reason: string): BackupError {
  return new BackupError(
    'CANONICALIZATION_FAILED',
    `Value at "${path}" cannot be serialised deterministically: ${reason}`,
    { details: { path, reason } },
  )
}

/**
 * True only for `{}`-shaped objects: `Object.prototype` or no prototype.
 *
 * Everything else — `Date`, `Map`, `Set`, `RegExp`, `ArrayBuffer`, a typed
 * array, a `Money`, any class instance — is false, and that is the check that
 * keeps a structured value from being read as data it is not.
 */
export function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function write(value: unknown, path: string, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_JSON_DEPTH) {
    throw new BackupError(
      'BACKUP_TOO_DEEP',
      `Value at "${path}" nests deeper than ${MAX_JSON_DEPTH} levels`,
      { details: { path, maxDepth: MAX_JSON_DEPTH } },
    )
  }

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) {
        throw canonicalizationFailure(path, 'expected a finite number')
      }
      // `JSON.stringify` produces the shortest round-tripping representation
      // of a double, which is stable across engines for a given value.
      return JSON.stringify(value)
    case 'undefined':
      throw canonicalizationFailure(path, 'undefined has no canonical form; omit the key instead')
    case 'function':
      throw canonicalizationFailure(path, 'functions are not data')
    case 'symbol':
      throw canonicalizationFailure(path, 'symbols are not data')
    case 'bigint':
      throw canonicalizationFailure(path, 'bigint has no JSON form')
    default:
      break
  }

  if (value === null) {
    return 'null'
  }

  const object = value as object
  if (ancestors.has(object)) {
    throw canonicalizationFailure(path, 'cyclic reference')
  }
  ancestors.add(object)
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        write(item, `${path}[${index}]`, depth + 1, ancestors),
      )
      return `[${items.join(',')}]`
    }

    if (!isPlainObject(object)) {
      throw canonicalizationFailure(
        path,
        'expected a plain object; class instances are never serialised',
      )
    }

    const keys = Object.keys(object).sort()
    const entries = keys.map((key) => {
      if (isForbiddenKey(key)) {
        throw forbiddenKeyFailure(path, key)
      }
      const child = (object as Record<string, unknown>)[key]
      return `${JSON.stringify(key)}:${write(child, `${path}.${key}`, depth + 1, ancestors)}`
    })
    return `{${entries.join(',')}}`
  } finally {
    ancestors.delete(object)
  }
}

/**
 * The deterministic serialisation of a plain data value.
 *
 * Two structurally equal values always produce the same string, regardless of
 * the order their keys were assigned in.
 */
export function canonicalize(value: unknown, path = '$'): string {
  return write(value, path, 0, new Set<object>())
}

/**
 * Counts JSON nesting depth on the raw text, before `JSON.parse` allocates
 * anything.
 *
 * `JSON.parse` has no depth limit, and a reviver cannot impose one — it is
 * called on the way *out*, after the structure already exists. Scanning the
 * text is O(n) with no allocation, so a `[[[[…]]]]` bomb is refused for the
 * cost of one pass instead of being built in full first.
 */
export function assertJsonDepthWithin(text: string, maxDepth = MAX_JSON_DEPTH): void {
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === '{' || character === '[') {
      depth += 1
      if (depth > maxDepth) {
        throw new BackupError(
          'BACKUP_TOO_DEEP',
          `JSON nests deeper than ${maxDepth} levels`,
          { details: { maxDepth, offset: index } },
        )
      }
    } else if (character === '}' || character === ']') {
      depth -= 1
    }
  }
}

/**
 * Rejects a payload larger than the pilot cap.
 *
 * Deliberately a byte count, not a character count: a file is bounded by what
 * it occupies, and a multi-byte character must not let a file past the limit
 * that a plain-ASCII one of the same size would fail.
 */
export function assertWithinSizeLimit(byteLength: number, maxBytes = MAX_BACKUP_BYTES): void {
  if (byteLength > maxBytes) {
    throw new BackupError('BACKUP_TOO_LARGE', 'Backup payload exceeds the maximum supported size', {
      details: { byteLength, maxBytes },
    })
  }
}

export function assertTextWithinSizeLimit(text: string, maxBytes = MAX_BACKUP_BYTES): void {
  assertWithinSizeLimit(utf8ByteLength(text), maxBytes)
}

/**
 * `JSON.parse` with a reviver that **rejects** the whole file when it meets a
 * prototype-polluting key.
 *
 * The canonical document originally described dropping those keys. Rejecting
 * is the stronger reading of the same intent and is what this implementation
 * does, for a reason the rest of §9 already states: *silently dropping a field
 * is how a restore "succeeds" with less data than it was given.* A backup
 * written by this application can never contain `__proto__`, `constructor` or
 * `prototype` as a key — `canonicalize()` refuses to emit one — so a file that
 * does is either corrupt or hostile, and neither deserves a partial import.
 *
 * No `eval`, no `Function`, no dynamic import, no YAML: `JSON.parse` is the
 * only parser in this path.
 */
export function parseUntrustedJson(text: string): unknown {
  try {
    return JSON.parse(text, function reviver(key: string, value: unknown): unknown {
      if (isForbiddenKey(key)) {
        throw new BackupError(
          'BACKUP_FORBIDDEN_KEY',
          `Backup file contains the forbidden key "${key}"`,
          { details: { key } },
        )
      }
      return value
    })
  } catch (cause) {
    if (cause instanceof BackupError) {
      throw cause
    }
    throw new BackupError('BACKUP_MALFORMED_JSON', 'Backup file is not valid JSON', { cause })
  }
}
