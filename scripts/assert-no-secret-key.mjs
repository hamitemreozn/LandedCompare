/**
 * Fails the build if a secret key reached the production bundle.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §19, threat 6.
 *
 * ## Why this exists, when the rule is already written down
 *
 * The rule — a publishable key may be in the bundle, a secret key never — is
 * the kind that is obvious, agreed by everybody, and broken exactly once, by
 * somebody in a hurry pasting the wrong value into a `.env` at 18:40. The
 * mistake is catastrophic and it is SILENT: a bundle carrying `sb_secret_…`
 * works perfectly. Every screen loads, every save succeeds, every test passes.
 * It simply also hands unrestricted, RLS-bypassing database access to anyone
 * who opens the network tab.
 *
 * So this is not a lint rule about style. It is a check that the one mistake
 * that cannot be detected by its consequences is detected by its cause, and it
 * costs a few lines and a second of build time.
 *
 * ## What it looks for
 *
 * - a current secret credential beginning with `sb_secret_` (the Supabase
 *   client library itself contains the public format marker, so a bare marker
 *   is not evidence that a credential was embedded).
 * - `service_role` — the legacy key's role claim. Supabase is deprecating the
 *   legacy anon/service_role JWT pair by the end of 2026, but a legacy secret
 *   in a bundle is exactly as dangerous as a new one, and a build that only
 *   looked for the new prefix would wave through the old one.
 *
 * Both markers are also refused at runtime by `readCloudConfig`, which catches
 * the same mistake in a development server where no production bundle exists.
 * Two checks, because the window between them is the window the mistake lives
 * in.
 *
 * ## What it deliberately does NOT do
 *
 * It does not scan the repository — `.env.local` is gitignored and is supposed
 * to hold real values on a developer's machine, and a check that failed on
 * those would be turned off within a week. It scans the SHIPPED OUTPUT, which
 * is the only place the rule actually matters.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const FORBIDDEN = [
  {
    marker: 'sb_secret_',
    pattern: /sb_secret_[A-Za-z0-9_-]{8,}/,
    what: 'a Supabase secret key',
  },
  {
    marker: 'service_role',
    pattern: /service_role/,
    what: 'a legacy service-role key or claim',
  },
]

/** Text-bearing output. A font or an image cannot contain a pasted key. */
const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.txt']

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      yield* walk(path)
    } else {
      yield path
    }
  }
}

const root = process.argv[2] ?? 'dist'

let scanned = 0
const hits = []

try {
  statSync(root)
} catch {
  console.error(`assert-no-secret-key: "${root}" does not exist; run the build first.`)
  process.exit(1)
}

for (const path of walk(root)) {
  if (!SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    continue
  }
  scanned += 1
  const content = readFileSync(path, 'utf8')
  for (const { marker, pattern, what } of FORBIDDEN) {
    if (pattern.test(content)) {
      hits.push({ path: relative(process.cwd(), path), marker, what })
    }
  }
}

if (hits.length > 0) {
  console.error('')
  console.error('  BUILD REFUSED — secret key material found in the client bundle')
  console.error('')
  for (const hit of hits) {
    // The marker, never the value. Printing the key would move it from a build
    // artefact into a CI log, which is a worse place for it to be.
    console.error(`    ${hit.path}`)
    console.error(`      contains "${hit.marker}" — ${hit.what}`)
  }
  console.error('')
  console.error('  A secret key bypasses every row-level policy in the database.')
  console.error('  The client bundle may contain the project URL and the PUBLISHABLE')
  console.error('  key (sb_publishable_…) and nothing else.')
  console.error('')
  console.error('  Nothing in this product needs a secret key on the client. The Edge')
  console.error('  Functions read theirs from the platform-injected SUPABASE_SECRET_KEYS,')
  console.error('  so there is no project secret to place anywhere by hand.')
  console.error('')
  console.error('  Check VITE_SUPABASE_PUBLISHABLE_KEY in your .env / CI environment.')
  console.error('')
  process.exit(1)
}

console.log(`assert-no-secret-key: ${scanned} bundle files scanned, no secret key material found.`)
