/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

/**
 * The behavioural security suite.
 *
 * Canonical design: docs/CLOUD_MULTIUSER_ARCHITECTURE.md §7, "Part 2 —
 * behavioural, and two of these need HTTP".
 *
 * ## Why this is a separate command rather than part of `npm run test`
 *
 * These tests make real HTTP requests against a running local Supabase stack.
 * They prove things pgTAP structurally cannot see, because
 *
 * > pgTAP runs INSIDE the database and therefore cannot see PostgREST's
 * > exposed-schema configuration at all.
 *
 * — which means the single control that makes the exact-decimal contract and
 * the stale-write guarantee invariants, that `app_data` has no route, is not
 * provable by any in-database test. It needs a real request.
 *
 * The cost is a Docker dependency, and it is paid here rather than by the whole
 * test suite: `npm run test` must stay runnable on a machine with no container
 * runtime, because Phases 0–9 — the engine, the calculations, the comparison,
 * the persistence layer and every screen — have nothing to do with the cloud
 * and must not become un-testable because of it.
 *
 * ## Environment
 *
 * `node`, not `jsdom`: these are HTTP requests, and a DOM would add a fake
 * `fetch`, a fake `localStorage` and a set of behaviours that are not the ones
 * being tested. The suite talks to the server the way a client does and looks
 * at what comes back — including, where it matters, the RAW response body
 * rather than the parsed object, because a test that parses JSON and compares
 * numerically would pass while the data was being destroyed.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.security.test.ts'],
    globalSetup: ['./src/cloud/security/globalSetup.ts'],
    // Every file talks to one shared database and several of them change
    // membership rows to prove authorisation is live state. Running them in
    // parallel would make one file's "the member is disabled" another file's
    // mysterious failure.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
