# LandedCompare

Local-first, desktop-first responsive web app that lets importers and distributors
compare supplier quotations by calculated landed cost, not just unit price.

This repository is in early foundation stage (Phase 0). No business functionality
is implemented yet. See [docs/](docs/) for product and architecture details.

## Stack

- React + TypeScript
- Vite (build & dev server)
- Vitest + React Testing Library (tests)
- oxlint (linting)
- i18next + react-i18next (internationalization)

## Commands

```bash
npm run dev        # start local dev server
npm run test       # run test suite
npm run lint       # run oxlint
npm run typecheck  # run TypeScript project check (no emit)
npm run build      # production build (tsc -b && vite build)
npm run preview    # preview the production build locally
```

## Internationalization

Supported languages: Turkish (`tr`) and English (`en`).

- Resources and setup live in [`src/i18n/`](src/i18n/): `locale.ts` (supported-locale
  type, browser-language normalization, the `landedcompare.locale` preference),
  `index.ts` (i18next wiring, the `setLocale`/`getLocale` API), and
  `resources/en.ts` / `resources/tr.ts` (translation catalogs, typed against a
  shared shape so a key missing from one is a compile error).
- Initial language: a stored `landedcompare.locale` preference wins; otherwise
  the browser language is matched to `tr`/`en`; otherwise it falls back to
  English. An invalid or corrupted stored value is ignored, not thrown.
- The financial engine (`domain`, `calculation`, `comparison`) stays
  language-agnostic: it returns machine-readable codes only. `src/i18n/engineText.ts`
  is the one place those codes are mapped to translation keys.
- `src/i18n/format.ts` provides `Intl.NumberFormat`-based number/currency/percentage
  formatting. These are presentation only — they never round or feed back into a
  financial calculation; `Money`/`Decimal` results remain authoritative.

## Documentation

- [Product Requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Calculation Rules](docs/CALCULATION_RULES.md)
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Roadmap](docs/ROADMAP.md)
