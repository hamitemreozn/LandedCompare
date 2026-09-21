/**
 * Handing a generated backup to the browser.
 *
 * Deliberately the *only* DOM-aware file in `src/backup/`, and deliberately
 * tiny. Everything that decides what a backup contains, how it is checksummed
 * and whether it is valid lives in files that never touch `document`, so the
 * entire backup path is testable without a browser and a missing API can never
 * cost the product its backup capability.
 *
 * ## The honest guarantee
 *
 * This function **initiates a download**. That is all a web page can do.
 *
 * There is no event, no promise and no API that tells a page whether the user
 * saved the file, renamed it, cancelled the dialog, or wrote it to the same
 * failing disk the backup is meant to survive. So this returns `void` on
 * success meaning "the browser accepted the download", and callers — including
 * `exportBackup()` — must not upgrade that into "the backup is safe on disk".
 * The wording in the UI follows the same rule: *exported*, never *saved*.
 *
 * ## File System Access API
 *
 * Not implemented, on purpose. A `FileSystemDirectoryHandle` can only be
 * obtained from a real user gesture in a real picker — that is a Settings
 * screen, which is Phase 9. Building half of it here would mean an untestable
 * code path guarded by a permission prompt that no test can grant. The
 * canonical design already requires the download path to remain available as
 * the fallback in every case, so adding the handle later changes nothing about
 * this file or about what a backup is.
 */

import type { BackupArtifact } from './externalBackup'
import { BackupError } from './errors'

interface DownloadHost {
  createElement(tag: 'a'): HTMLAnchorElement
  readonly body: { appendChild(node: Node): void; removeChild(node: Node): void }
}

interface ObjectUrlFactory {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

export interface DownloadOptions {
  readonly document?: DownloadHost
  readonly urlFactory?: ObjectUrlFactory
}

/** The file's bytes as a `Blob`, typed and UTF-8. Useful on its own for tests. */
export function toBackupBlob(artifact: BackupArtifact): Blob {
  return new Blob([artifact.json], { type: 'application/json' })
}

/**
 * Triggers a browser download of the artifact.
 *
 * Throws `CRYPTO_UNAVAILABLE`-style structured failure rather than a bare
 * `TypeError` when the environment has no DOM, so a caller can distinguish
 * "this browser cannot download" from "the backup could not be generated" —
 * two different problems with two different messages.
 */
export function downloadBackup(artifact: BackupArtifact, options: DownloadOptions = {}): void {
  const host =
    options.document ?? (globalThis as { document?: DownloadHost }).document ?? undefined
  const urls = options.urlFactory ?? (globalThis as { URL?: ObjectUrlFactory }).URL ?? undefined

  if (host === undefined || typeof host.createElement !== 'function') {
    throw new BackupError(
      'RESTORE_PRECONDITION_FAILED',
      'No document is available to initiate a download',
    )
  }
  if (urls === undefined || typeof urls.createObjectURL !== 'function') {
    throw new BackupError(
      'RESTORE_PRECONDITION_FAILED',
      'This environment cannot create object URLs, so a download cannot be started',
    )
  }

  const url = urls.createObjectURL(toBackupBlob(artifact))
  try {
    const anchor = host.createElement('a')
    anchor.href = url
    anchor.download = artifact.filename
    anchor.rel = 'noopener'
    host.body.appendChild(anchor)
    anchor.click()
    host.body.removeChild(anchor)
  } finally {
    // Released whatever happened; a leaked object URL pins the whole backup in
    // memory for the lifetime of the document.
    urls.revokeObjectURL(url)
  }
}
