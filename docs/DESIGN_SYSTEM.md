# Design System

**Phase 12.6 — Brand & Design System Foundation.** This document records the
foundation this phase installed: brand assets, typography, the token layer,
the icon convention, and the small primitive set. It is a foundation, not a
redesign — see "What Phase 12.6 deliberately did not do" below, and
[Implementation Plan](IMPLEMENTATION_PLAN.md)'s Phase 12.7 entry for what
consumes this foundation next.

## Brand assets

Five frozen SVG marks live under `src/assets/brand/` (also duplicated as
inline JSX in [`src/ui/Brand.tsx`](../src/ui/Brand.tsx) — `BrandMark` and
`AppIconTile` — so they can render without a network request):

| File | Use |
| --- | --- |
| `lc-mark.svg` | Standard mark, ≥24px. |
| `lc-mark-small.svg` | ≈16–20px only. No dot; thicker optical stroke so the mark doesn't disappear at small sizes. Used for `public/favicon.svg`. |
| `lc-mark-mono.svg` | Single-colour contexts. |
| `lc-mark-dark.svg` | Dark surfaces. |
| `app-icon.svg` | A rounded-square tile carrying the **master mark's exact geometry** (see "Master mark" below), scaled and centred, not redrawn — used for the sidebar's brand slot (`AppShell`'s and `BootScreens`'s `.brand__mark`). |

The wordmark is **always plain text** — "LandedCompare" (PascalCase) in IBM
Plex Sans 600 — never an SVG with live `<text>`. There is no outlined
wordmark; it does not exist yet and this phase does not invent one.

### Master mark

`lc-mark.svg` (and `src/ui/Brand.tsx`'s `MASTER_L_PATH` / `MASTER_C_PATH` /
`MASTER_DOT`) is the **unquestioned master geometry** every other rendering
of the mark derives from:

- L: `M15 16 L15 44 L29 44`
- C: `M29 28.06 A12 12 0 1 1 29 43.94`
- Join point: ≈`(29, 44)`
- Gold dot: `cx=29 cy=44 r=3.2`

`app-icon.svg` and `AppIconTile` place this exact `d` inside a
`translate(9.6,8) scale(0.8)` group, not an independently redrawn L/C — that
is what keeps the tile's monogram optically identical to the standalone mark
(same join, same dot position, same proportions) rather than merely similar.
Only the padding/centring transform and the tile-specific colours (white L,
`#8FA3FF` C for contrast on the `#1B2A55` navy background, `#C99A3D` dot) are
tile-specific.

## Typography

Self-hosted via `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono`,
registered in [`src/main.tsx`](../src/main.tsx). No Google Fonts import, no
runtime font dependency.

- **IBM Plex Sans** — weights 400/500/600/700 — is `--font-ui`, the UI font
  for everything: forms, tables, buttons, headings, navigation, prices,
  percentages, ordinary numeric columns.
- **IBM Plex Mono** — weight 400 — is `--font-mono`, reserved for genuinely
  fixed-width identifiers: SKU, product codes, HS/tariff codes, external
  reference IDs. **Not** for prices or ordinary numeric columns — those use
  `.text-tabular` (`font-variant-numeric: tabular-nums`) instead, so digits
  align without forcing the whole cell into a monospace face.
- Only the **`latin` and `latin-ext` subset files** are imported (e.g.
  `ibm-plex-sans/latin-400.css` + `.../latin-ext-400.css`), not the combined
  `/400.css`, which also ships cyrillic/greek/vietnamese `@font-face` blocks
  this application never serves. `latin-ext` is required, not optional:
  Turkish letters (ı ğ ş ö ç İ) fall outside the plain `latin` subset —
  verified by rendering `docs/PRODUCT_REQUIREMENTS.md`-style Turkish copy
  through the app and confirming no fallback-font glyphs appear.

## Design tokens

[`src/styles/tokens.css`](../src/styles/tokens.css) is the canonical brand
token file: the raw `--palette-*` scale, then a semantic layer
(`--brand-primary`, `--surface-app`, `--text-primary`, `--action-primary`,
`--focus-ring`, status tokens, …) matching the frozen palette below, plus
`--font-ui` / `--font-mono` and the two typography utility classes.

### Coexistence with the existing token file

The codebase already had a working token system,
[`src/ui/tokens.css`](../src/ui/tokens.css) (palette named `ink`/`slate`/
`accent`, semantic roles `--surface-app`, `--text-primary`, `--focus-ring`,
plus a complete space/radius/shadow scale that `styles/tokens.css`
deliberately does **not** duplicate). Several semantic names are shared
between the two files. `src/index.css` imports `styles/tokens.css` **before**
`ui/tokens.css`, so — for any name both files declare — `ui/tokens.css`
(loaded second) wins. This is deliberate: it makes the new palette and full
semantic set available (and tested, see `src/styles/tokens.test.ts`) without
silently reskinning every screen's colours the moment this file lands. Two
names are the explicit, narrow exception, wired directly rather than through
cascade order:

- **`--font-sans`** in `ui/tokens.css` now reads `var(--font-ui)` — the
  application's font is IBM Plex Sans everywhere, immediately. This was named
  as in-scope minimal integration (Task 3/9) and is low risk: it changes a
  font, not a layout or a colour system.
- **`--font-mono`** in `ui/tokens.css` was removed rather than redeclared —
  it now falls through to `styles/tokens.css`'s IBM Plex Mono, which is
  exactly what the one existing consumer (`.detail-list__value--mono`, a
  technical-identifier display) wants.
- **`--focus-ring`** in `ui/tokens.css` now reads `var(--action-primary)` —
  the frozen brand blue. Focus styling was named explicitly as in-scope
  (Task 9/10); the general button/link accent colour was not touched.

**Phase 12.7's job** is to migrate `components.css` off `ui/tokens.css`'s
colliding names onto `styles/tokens.css`'s, then delete the superseded
declarations from `ui/tokens.css` — a rename, not a rewrite, because the
palettes were already close in spirit (both are a restrained navy/slate
system) before this phase started.

### Light/dark

The semantic tokens above are the light set. A dark set exists under
`:root[data-theme='dark']` in `styles/tokens.css` — prepared, not wired up.
Nothing sets that attribute anywhere in the application, and there is
deliberately **no `@media (prefers-color-scheme: dark)`** rule: `ui/tokens.css`
already states this project's position that a half-built dark mode (native
form controls and scrollbars following the OS setting while every custom
surface stays light) is worse than none, and this phase does not change that.
Dark activates only on a future, explicit, in-app toggle.

### Status token contrast (F12.6-03)

Every status state (`success`/`warning`/`error`/`info`) has four roles, named
identically in light and dark: `--status-X` (base/strong, for plain-background
emphasis), `--status-X-icon`, `--status-X-surface` (a tinted background), and
`--status-X-text` (the colour placed *on* `--status-X-surface`).

The original foundation shipped this inconsistently: light defined
`-icon` for every state but only one `-surface`/`-text` pair (warning), and
dark defined only `-surface` for every state. Worse, the one light
`-surface`/`-text` pair that did exist — `--status-warning-surface`
(`#DC7A0F`) with `--status-warning-text` (`#8A4A08`) — measures **~2.2:1**,
well under the WCAG AA minimum of 4.5:1 for normal text.

This was corrected by: (1) completing all four roles for all four states in
both themes, and (2) choosing light `-surface` tints and dark `-text` tones
that were contrast-checked against their paired text/surface colour —
`src/styles/tokens.test.ts` computes the actual WCAG contrast ratio for every
pair (light and dark) from the token file's own declared values and fails
under 4.5:1, so this can't silently regress. `#8A4A08` itself was not
deleted — it's kept as `--palette-orange-900`, available for a context that
needs that darker tone but is *not* rendered on top of
`--status-warning-surface`.



## Icon system

[`src/ui/icons.ts`](../src/ui/icons.ts) is a curated re-export of
`lucide-react`, keyed by product concept (`Icons.dashboard`,
`Icons.suppliers`, …) rather than by the upstream icon name, so the mapping
lives in one place. Nothing in the existing navigation consumes it yet — the
rail is still text-only (`AppShell.tsx`); wiring icons into the nav is Phase
12.7's job. Because nothing imports it in application code today, it
contributes ~0 to the shipped JS bundle (see "Bundle impact" in the phase
report) until it's wired in.

Convention for future call sites: an icon is always decorative
(`aria-hidden`); an icon-only control gets its accessible name from
`aria-label` on the control itself, never from the icon.

## UI primitive strategy

Two new primitives were added — [`Tooltip`](../src/ui/Tooltip.tsx) and
[`Separator`](../src/ui/Separator.tsx) — because nothing in the codebase
covered them. Everything else on the "preferred smallest useful core" list
(Button, Input, Label) already has a robust, i18n-integrated equivalent —
`.button`/`.button--primary`/`.button--small` in `components.css`, and
[`Field.tsx`](../src/ui/Field.tsx)'s `TextField`/`SelectField` family — so
this phase does **not** duplicate them. Duplicating a working Button/Input
just to say "shadcn-style" would be exactly the "Frankenstein stack" the
brief warns against.

Both new primitives are locally owned (own the source, style with tokens,
not a component library dependency), which is the shadcn/ui pattern this
project is adopting incrementally:

- **Tooltip** — shows on hover *and* keyboard focus (never hover-only),
  wired to its trigger via `aria-describedby`. It supplements an
  `aria-label`, it does not replace the requirement for one.
- **Separator** — `role="none"` when decorative (the default) so it isn't
  announced as structure; `role="separator"` with `aria-orientation` when it
  carries meaning.

`Badge` was considered and skipped: `StatusBadge` in
[`Feedback.tsx`](../src/ui/Feedback.tsx) already exists and already follows
the "colour never carries meaning alone" rule this system wants; adopting it
onto semantic tokens is Phase 12.7 work, not a new component.

**Existing and reused, unchanged this phase:** Button (`.button` family in
`components.css`), Input/Label (`Field.tsx`'s `TextField`/`SelectField`
family), `StatusBadge` and the rest of `Feedback.tsx` (banners, empty
states).

**New in Phase 12.6:** `Tooltip`, `Separator`, the brand components
(`BrandMark`, `AppIconTile` in `Brand.tsx`), and the icon convention
(`icons.ts`).

**Sidebar, Breadcrumb, and the rest of the shell-composition primitives are
explicitly Phase 12.7.** This phase proves the architecture with the smallest
useful set, not the full shadcn/ui catalogue.

## Table strategy

TanStack Table is the intended long-term engine for complex operational
tables, but every table in the codebase today
(`ProductsScreen`, `DashboardScreen`, `OrganizationScreen`,
`CustomerStatusesScreen`, `PartyScreen`) is a plain HTML `<table>` with no
sorting, filtering, or virtualization — there is no foundational use for it
yet. Installing it now would be a dependency with nothing exercising it.
**Deferred**, per the brief's explicit permission, to the first screen that
actually needs sorting/filtering/virtualization (Phase 13 onward). One table
engine, adopted when it has a real job — not before.

## Minimal brand application (this phase)

- Root UI font → IBM Plex Sans (`--font-sans: var(--font-ui)`).
- Technical-identifier mono font → IBM Plex Mono (`--font-mono` fallthrough).
- Focus ring colour → brand blue (`--focus-ring: var(--action-primary)`).
- Browser favicon → `lc-mark-small.svg`.
- Sidebar brand slot (`AppShell.tsx`'s `.brand__mark`) → `AppIconTile`,
  replacing the plain-text "LC" monogram tile. The wordmark next to it is
  unchanged markup — it already rendered `{t('common.appName')}` as plain
  text, and `common.appName` is already the frozen casing, `LandedCompare`,
  in both locales.

### What Phase 12.6 changed globally, and what it deliberately did not touch

This phase is **not** "purely additive" — it changes four things everywhere
in the running application, on every existing screen:

- **Typography** — every screen now renders in IBM Plex Sans instead of
  Inter (`--font-sans: var(--font-ui)`), and technical-identifier mono text
  in IBM Plex Mono. This is a real, visible, global font-rendering change.
- **Branding** — the browser favicon and the sidebar/boot-screen brand mark
  changed (`AppIconTile` replacing the plain-text "LC" monogram).
- **Focus styling** — the keyboard-focus ring colour changed from the legacy
  teal accent to the brand blue, on every interactive element (this
  remediation extended that to three selectors — nav link, locale switch,
  choice-list option — that still used the legacy accent; see "Focus ring
  consistency" below).

What did **not** change on any existing screen: **layout structure and
workflows** — sidebar layout, table layouts, forms, cards, filters, and page
headers keep their existing DOM structure, spacing, and interaction
behaviour; nothing was rearranged, added, or removed. **Shell structure
itself was not modernized** — the sidebar/topbar/breadcrumb/navigation
architecture is unchanged, and general button/link accent colour was not
swapped to the brand blue (only the focus ring was) — a whole-application
recolour belongs with Phase 12.7's shell modernization, not this token
foundation.

## Accessibility

- Keyboard focus remains visible everywhere; `:focus-visible` styling in
  `components.css` is unchanged in mechanism, only recoloured (see
  "Focus ring consistency" below).
- `BrandMark`/`AppIconTile` are `aria-hidden` by default; a `title` prop opts
  a specific instance into `role="img"` + `aria-label` when the mark is used
  standalone without adjacent text.
- `Tooltip` follows the WAI-ARIA "hover or focus" tooltip pattern (WCAG
  1.4.13) — **dismissible** (Escape hides it without moving focus, and it
  reappears on the next fresh hover/focus interaction), **hoverable** (the
  pointer can move from the trigger onto the tooltip content itself, across
  the visual gap between them, without it disappearing — via a short hide
  delay, not `pointer-events: none`), and **persistent** (stays open for as
  long as the trigger or the tooltip content is hovered or focused). It
  merges into, rather than replacing, any `aria-describedby` the trigger
  already carries. It does not substitute for an `aria-label` on an
  icon-only control.
- `Separator` defaults to `role="none"` (no false structural announcement)
  and only claims `role="separator"` when explicitly marked non-decorative.
- The one new CSS transition (`Tooltip`'s fade) is wrapped in
  `@media (prefers-reduced-motion: no-preference)`.
- Existing form labels (`Field.tsx`) were not touched.

### Focus ring consistency (F12.6-06)

Three `:focus-visible` selectors still used the legacy teal accent tokens
directly (`.nav__link`, `.locale-switch__option` → `var(--accent-500)`;
`.choice-list__option` → `var(--accent-600)`) instead of `--focus-ring` —
missed when the rest of `components.css`'s focus-visible selectors were
routed through it. All three are generic interaction focus styling with no
contextual reason to differ, so all three now read `var(--focus-ring)`,
matching every other focus-visible selector in the file. Normal hover/active
colours on these elements were not touched.

## Tests

- `src/ui/Brand.test.tsx` — mark variants, decorative-vs-labelled rendering,
  the frozen `LandedCompare` casing, and per-variant colour regression
  (`#8FA3FF` never drifting to `#6C86FF`).
- `src/assets/brand/brandAssets.test.ts` — the frozen source SVG *files*
  (not just the JSX) carry the exact master L/C paths, the small-variant
  rules (stroke-width 9, no dot), and never substitute the dark-theme action
  blue for the approved optical C colour.
- `src/ui/Tooltip.test.tsx` — `aria-describedby` merge (not replace);
  visibility on keyboard focus (not hover-only); Escape dismissal without
  moving focus, reappearing on the next interaction; hoverable persistence
  when the pointer moves onto the tooltip content.
- `src/ui/Separator.test.tsx` — decorative vs. semantic roles.
- `src/ui/icons.test.tsx` — every entry in the `Icons` map renders an
  `<svg>`.
- `src/styles/tokens.test.ts` — the semantic token names Phase 12.7 will
  consume are present in both themes; dark tokens are scoped to the explicit
  opt-in selector, never to `prefers-color-scheme`; every status
  `-text`/`-surface` pair (light and dark) is checked programmatically
  against the actual WCAG contrast formula and must be ≥4.5:1.
- `src/App.test.tsx` (pre-existing, unmodified) still passes: boot gate,
  navigation and the language switch are unaffected.

## Deferred to Phase 12.7

- Sidebar / topbar / breadcrumb / navigation restructuring.
- Wiring `Icons` into the navigation rail.
- Migrating `components.css` off `ui/tokens.css`'s colliding names onto
  `styles/tokens.css`, then deleting the superseded declarations.
- Recolouring the general button/link accent to the brand blue.
- Any dark-mode toggle.
- TanStack Table, when the first complex operational table needs it.
- Screen-by-screen adoption of the new primitives and semantic tokens in
  tables, forms, cards, filters, and page headers.
