/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // The behavioural security suite is excluded from `npm run test` on
    // purpose. Those tests make real HTTP requests to a local Supabase stack,
    // so they need Docker running — and a developer who cannot run Docker must
    // still be able to run the unit suite, the engine, and the whole of Phases
    // 0–9. `npm run test:security` runs them with their own config.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.security.test.ts'],
  },
})
