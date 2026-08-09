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

## Commands

```bash
npm run dev        # start local dev server
npm run test       # run test suite
npm run lint       # run oxlint
npm run typecheck  # run TypeScript project check (no emit)
npm run build      # production build (tsc -b && vite build)
npm run preview    # preview the production build locally
```

## Documentation

- [Product Requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Calculation Rules](docs/CALCULATION_RULES.md)
- [Implementation Plan](docs/IMPLEMENTATION_PLAN.md)
- [Testing](docs/TESTING.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Roadmap](docs/ROADMAP.md)
