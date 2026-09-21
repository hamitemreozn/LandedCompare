/**
 * The backup integrity checksum.
 *
 * ## What it is
 *
 * SHA-256, computed with the browser's own `crypto.subtle.digest`, over the
 * canonical serialisation of the backup payload. No cryptography package was
 * added: Web Crypto is available in every browser this pilot could plausibly
 * run in and in Node, so a dependency would buy nothing but supply chain.
 *
 * ## What it proves, and what it does not
 *
 * It **detects corruption**: a truncated download, a byte flipped on a USB
 * stick, a file someone opened in an editor and re-saved, a payload that lost
 * a record in transit.
 *
 * It is **not authentication and not tamper-proofing.** There is no secret
 * anywhere in this scheme, so anyone who edits the payload can recompute the
 * hash and produce a file that verifies perfectly. Calling it "tamper-proof"
 * would be worse than having no checksum at all, because it would invite
 * trusting a file on the strength of a check that cannot carry that weight.
 * A backup file is exactly as trustworthy as the place it was stored.
 *
 * ## Scope
 *
 * The digest covers `data` and nothing else — the scope the canonical document
 * fixes (`docs/LOCAL_PERSISTENCE_AND_BACKUP.md` §7), recorded in the file
 * itself as `integrity.scope` so a future format can widen it without
 * ambiguity. The manifest is not inside the digest, which is precisely why
 * `entityCounts` is independently recomputed from `data` during a restore and
 * why `schemaVersion` is re-proven by validating every record against the
 * shapes that version defines. A manifest that disagrees with its payload is
 * caught by those checks, not by this one.
 *
 * Self-reference is avoided by construction: `integrity` is attached to the
 * envelope *after* the digest is computed, so verification recomputes over the
 * same bytes the writer hashed.
 */

import { BackupError } from './errors'

export const CHECKSUM_ALGORITHM = 'SHA-256'

/** The subset of `SubtleCrypto` this module uses, so tests can withhold it. */
export interface DigestProvider {
  digest(algorithm: string, data: BufferSource): Promise<ArrayBuffer>
}

function resolveProvider(provider?: DigestProvider): DigestProvider {
  const resolved =
    provider ?? (globalThis.crypto as { subtle?: DigestProvider } | undefined)?.subtle
  if (resolved === undefined || typeof resolved.digest !== 'function') {
    throw new BackupError(
      'CRYPTO_UNAVAILABLE',
      'Web Crypto is unavailable, so a backup checksum cannot be produced or verified',
    )
  }
  return resolved
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`. */
export async function sha256Hex(text: string, provider?: DigestProvider): Promise<string> {
  const subtle = resolveProvider(provider)
  const encoded = new TextEncoder().encode(text)
  return toHex(await subtle.digest(CHECKSUM_ALGORITHM, encoded))
}

export const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/

export function isChecksumShape(value: unknown): value is string {
  return typeof value === 'string' && CHECKSUM_PATTERN.test(value)
}
