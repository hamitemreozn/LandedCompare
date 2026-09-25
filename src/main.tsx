import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted IBM Plex, imported before index.css so the design-system font
// tokens (src/styles/tokens.css) resolve to already-registered @font-face
// rules. Only the weights the UI actually uses — see docs/DESIGN_SYSTEM.md.
//
// The `latin`/`latin-ext` subset files (not the combined `/400.css`, which
// also pulls cyrillic/greek/vietnamese @font-face blocks the app never
// serves) — `latin-ext` is required, not optional: Turkish letters such as
// ı ğ ş ö ç İ fall outside the plain `latin` subset.
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-ext-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-ext-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-ext-600.css'
import '@fontsource/ibm-plex-sans/latin-700.css'
import '@fontsource/ibm-plex-sans/latin-ext-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-ext-400.css'
import './index.css'
import './i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
