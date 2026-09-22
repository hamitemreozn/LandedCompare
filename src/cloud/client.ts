/**
 * The Supabase client, constructed once.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §4, §18, §19.
 *
 * Two configuration choices here are architecture rather than preference.
 *
 * **`db.schema = 'api'`.** This module and `gateway.ts` are the only places in
 * the codebase that name a database schema. Every feature service asks the
 * gateway for what it wants and never mentions `api`, `app_data` or a table, so
 * reorganising the API surface changes one module. It is also the client half
 * of the §7 separation: the exposed-schema list on the server means nothing
 * else is reachable, and this means nothing else is even asked for.
 *
 * **`persistSession` with the default `localStorage`.** The session is a
 * credential, not business data, and §2's table says so explicitly. It lives at
 * a stable origin so it survives a restart — in a browser tab, in a Tauri
 * webview on Windows, and in a Tauri webview on macOS, identically, because
 * e-mail and password needs no redirect, no custom URL scheme and no deep-link
 * registration. That is the second independent reason §4 chose it.
 */

import { createClient } from '@supabase/supabase-js'
import { readCloudConfig, type CloudConfig, type CloudEnvironment } from './config'

/**
 * The `localStorage` key holding the session.
 *
 * Named explicitly rather than left to the library's project-ref default, so
 * that it is greppable, so that a future project migration does not silently
 * orphan a session under a key nobody remembers, and so that it sits beside
 * `landedcompare.locale` in the same namespace the application already owns.
 */
export const CLOUD_SESSION_STORAGE_KEY = 'landedcompare.session'

/**
 * The client type, inferred rather than annotated.
 *
 * `SupabaseClient` defaults its schema parameter to `'public'`, so writing that
 * type by hand would produce a handle the compiler believes talks to a schema
 * this project does not expose — and every gateway call would then be checked
 * against the wrong surface. Inferring from `createClient` keeps `'api'` in the
 * type, which is the point of setting it.
 */
export type CloudClient = ReturnType<typeof createCloudClient>

export function createCloudClient(config: CloudConfig) {
  return createClient(config.url, config.publishableKey, {
    db: { schema: 'api' },
    auth: {
      storageKey: CLOUD_SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      // No redirect-based flow exists in this product, so there is no callback
      // fragment to detect. Leaving it on would make the client inspect the URL
      // of every page load for an OAuth response it can never receive.
      detectSessionInUrl: false,
    },
  })
}

/**
 * Builds the client from build-time environment values, or refuses.
 *
 * `import.meta.env` is read by the caller and passed in, so this module stays
 * testable without Vite and so the one place that touches build-time
 * configuration is visible.
 */
export function createCloudClientFromEnvironment(environment: CloudEnvironment): CloudClient {
  return createCloudClient(readCloudConfig(environment))
}
