# Design System

**Phase 12.6 — Brand & Design System Foundation.** This document records the
foundation this phase installed: brand assets, typography, the token layer,
the icon convention, and the small primitive set. It is a foundation, not a
redesign — see "What Phase 12.6 deliberately did not do" below.

**Phase 12.7 — Application Shell Modernization** consumes this foundation in
the sidebar, topbar and breadcrumb — see
["Phase 12.7 — Application Shell Modernization"](#phase-127--application-shell-modernization)
below, and [Implementation Plan](IMPLEMENTATION_PLAN.md)'s Phase 12.7 entry
for its status (implemented in the working tree, not yet committed or
reviewed).

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

**Phase 12.7 migrated the shell** (topbar, breadcrumb, and the shell-scoped
controls that sit on the light content area) onto `styles/tokens.css`'s names
directly — `--surface-card`, `--border-default`, `--text-secondary`,
`--state-row-hover`, `--focus-ring` — where a distinct new-system name exists.
The sidebar keeps `ui/tokens.css`'s `--surface-nav`/`--text-on-nav`/
`--border-nav`: those are specific to a dark rail and have no counterpart in
`styles/tokens.css`, which was never asked to describe one. The rest of
`components.css` — buttons, cards, forms, tables, page headers — is
**still** on `ui/tokens.css`'s colliding names; migrating those, and then
deleting the superseded declarations from `ui/tokens.css`, remains future
screen-by-screen work, not a Phase 12.7 deliverable.

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
lives in one place. Phase 12.7 wired it into the navigation rail —
[`src/features/shell/navigation.ts`](../src/features/shell/navigation.ts)
assigns one icon per route and per future/"coming soon" entry, and both the
expanded and collapsed sidebar render from that same assignment.

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

**Sidebar, Topbar, Breadcrumb, AccountMenu and Select are Phase 12.7** — see
["Phase 12.7 — Application Shell Modernization"](#phase-127--application-shell-modernization)
below. Phase 12.6 proved the architecture with the smallest useful primitive
set, not the full shadcn/ui catalogue; Phase 12.7 is the first thing built on
top of it. `Select` (Visual Polish Round 3) is the first of these primitives
built on a headless behaviour dependency (`@radix-ui/react-select`) rather
than hand-rolled — see "Select primitive" below for why a native `<select>`'s
open popup specifically needed one.

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
- Focus ring colour → brand blue (`--focus-ring: var(--action-primary)`), as
  of this phase. Phase 12.7 later repointed `--action-primary` itself from
  blue onto the calm brand navy ("Primary action colour and interaction
  accent" below) and added a second, dark-surface-only focus token ("Final
  audit remediation" below) — this section describes what changed at the
  time, not the colour's current value.
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
  teal accent to the brand blue (at the time — see the current value's own
  note above), on every interactive element (this remediation extended that
  to three selectors — nav link, locale switch, choice-list option — that
  still used the legacy accent; see "Focus ring consistency" below).

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

## Phase 12.7 — Application Shell Modernization

**Status: implemented in the working tree, not yet committed or reviewed**
(see [Implementation Plan](IMPLEMENTATION_PLAN.md)). Business logic, routing,
auth, and every existing screen's inner content are unchanged — this phase is
scoped to the chrome visible on every screen.

This section covers the shell's current shape after three Visual Polish
rounds refined the first pass — read it as the end state, not a chronological
log; each round's own rationale is kept only where it explains a
non-obvious decision (why the collapse control ended up where it did, why
`Select.tsx` exists).

### Shell architecture

The shell is composed from files under
[`src/features/shell/`](../src/features/shell/), each owning one concern:

- **`navigation.ts`** — the one declarative model (`NAV_GROUPS`,
  `FUTURE_NAV_ITEMS`) of route, label key, and `Icons` entry, plus
  `groupHeadingKeyForRoute`. The sidebar's expanded state, its collapsed
  state, and the breadcrumb's group/current labels all read from this same
  model — there is no second copy of the route list anywhere.
- **`Sidebar.tsx`** — the brand row (mark + wordmark, nothing else — see
  below), primary navigation, and the edge-mounted collapse handle, which is
  a sibling of both rather than part of either. Identity/organisation/locale/
  sign-out live in `AccountMenu`, not here.
- **`AccountMenu.tsx`** — the top-right disclosure: name, company, role,
  switch-company (if applicable), language, sign-out. A hand-built
  button+panel (not `role="menu"` — content is a mix of a real action list
  and a language *group*, not a set of equivalent commands), with the panel
  kept in the DOM via the native `hidden` attribute rather than unmounted, so
  `shell-organization`/`shell-user` stay queryable without opening it first.
  No letter-initial avatar — text-only trigger (name, then company, smaller),
  falling back to a plain `Icons.user` glyph only where the text can't fit
  (narrow viewports).
- **`Topbar.tsx`** — the breadcrumb, full stop, on desktop; the mobile
  drawer's menu trigger is the one thing that joins it, and only under 900px.
  `.topbar__inner` mirrors `.page`'s own
  `max-width`/`margin-inline`/`padding-inline` exactly, so the breadcrumb and
  the page title share a left edge at every viewport width (see "Shared
  content grid" below).
- **`Breadcrumbs.tsx`** — the current route's nav-group heading (subdued,
  never a link — none of the groups is itself a route) followed by the
  current page (strongest, `aria-current="page"`). The application has no
  real deeper hierarchy above its top-level screens (`src/app/routes.ts`), so
  nothing beyond that two-level shape was invented.
- **`AppShell.tsx`** — composes the above, and owns what belongs to none of
  them individually: the desktop collapse preference
  (`useSidebarCollapsed.ts`) and the mobile drawer's open/close/focus/Escape
  lifecycle.

### Sidebar: one navigation model, two widths

Collapsing the sidebar never swaps in a second, icon-only navigation list.
Every `.nav__label` element stays in the DOM in both states; collapsing only
clips it visually, the same technique `.visually-hidden` uses elsewhere
(`src/ui/components.css`, "Collapsed desktop sidebar"). That keeps every
control's accessible name correct without a second source of truth, and
`Tooltip` (already built in Phase 12.6) surfaces that same label on
hover/focus once collapsed. Expanded is ~244px (`--sidebar-width`), collapsed
is ~72px (`--sidebar-width-collapsed`); both are CSS custom properties in
`src/ui/tokens.css`.

The collapse preference is local UI state, not business data: it persists
under its own namespaced `localStorage` key
(`landedcompare.sidebarCollapsed`, distinct from the business keys under
`landedcompare.*` — see `useSidebarCollapsed.ts`'s header comment), defaults
to expanded, and a storage failure (private mode, a full quota) is caught and
treated as "not collapsed" rather than breaking the shell.

**The collapse control's final home is an edge-mounted handle on the
sidebar's own boundary** (`.sidebar__collapse-toggle`), after three earlier
placements didn't hold up to review: docked to the boundary as a *dark*
control (Round 1) blended into the dark rail and was easy to miss; the
topbar, before the breadcrumb (Round 2), pushed the breadcrumb rightward and
broke its alignment with the page title below it; inside the brand row
itself (Round 3) truncated "LandedCompare" to make room for it and, collapsed,
stacked awkwardly under the mark. Round 4 kept Round 1's *position* — docked
to the sidebar/content boundary, a sibling of `.sidebar__scroll` so it can
neither affect the brand row's layout nor be clipped by the nav column's own
scroll container — and fixed the actual problem instead: it's a light
`--surface-elevated` disc, which reads clearly against both the dark sidebar
and the light content it overlaps, rather than a dark control on a dark
background. Icon-only (`PanelLeftClose`/`PanelLeftOpen`), `Tooltip`-wrapped,
labelled "Kenar çubuğunu daralt"/"genişlet". The brand row itself, both
states, is now untouched by any of this — `[LC mark] LandedCompare` expanded,
`[LC mark]` alone collapsed, nothing else in either.

The active-state treatment is a soft tint plus a narrow accent bar on
`.nav__link[aria-current='page']` — not a solid block, heavy gradient, or gold
fill, per this phase's restrained-active-state brief. The accent bar's colour
moved in Round 4 from `--palette-blue-500` to `--text-on-nav` — see "Primary
action colour and interaction accent" below for why.

### Shared content grid

The breadcrumb, the page title/subtitle, and every card/table/form below them
share one left edge and one horizontal ceiling, driven by two tokens in
`src/ui/tokens.css`:

- **`--shell-gutter`** — the one horizontal padding both `.topbar__inner` and
  `.page` read, instead of each carrying its own value (they used to: the
  topbar's `--space-4` against `.page`'s `--space-8`, which is why they
  didn't align). Redeclared once inside the `900px` media query to renarrow
  both at once on small screens.
- **`--content-max`** — raised from 1180px to 1440px, and made
  collapse-aware: `.shell:has(.sidebar--collapsed)` redeclares it to 1600px.
  Below whichever value is active, `.page`/`.topbar__inner` already fill
  whatever width the grid gives them (their own `width: 100%`) — the cap only
  ever binds on wide/ultrawide displays, which is exactly where collapsing
  the rail previously had no visible effect (the page was capped at the same
  width in both states, just re-centred). Collapsing now visibly gains
  workspace there too, not only on narrower screens where it already did.

### Responsive / mobile

Below 900px the persistent rail becomes an off-canvas drawer (closed by
default), rather than either the old horizontal-strip degradation or a
permanently cramped rail. Opened from the topbar's menu button (the desktop
collapse control hides here — collapsing is a rail concept, and the drawer is
always full width while open); closed by Escape, the backdrop, or selecting a
route. Focus moves into the drawer (to its close button) on open, and back to
the trigger button on close — a minimal, locally-owned lifecycle in
`AppShell.tsx`, not a full modal focus trap and not a new dependency.

### Removed: the sidebar tagline

The `common.appTagline` translation key and its rendering
(`AppShell`'s former `.brand__tagline`) were removed. The authenticated
shell's brand area is now `[LC mark] LandedCompare`, nothing else; the boot
screens (`BootScreens.tsx`) never rendered the tagline and are unchanged.

### Semantic token migration boundary

See "Coexistence with the existing token file" above: the topbar, breadcrumb,
and the account menu are consumers of `styles/tokens.css`'s semantic names
directly (`--surface-card`/`--surface-elevated`, `--border-default`,
`--text-secondary`, `--state-row-hover`, `--state-selected-bg`,
`--action-primary`). The sidebar's dark-rail tokens
(`--surface-nav`/`--text-on-nav`/`--border-nav`) are untouched — they have no
counterpart in the new system. `Select.tsx` (below) is a new primitive built
entirely on this layer. Everything else in `components.css` (buttons, cards,
non-select form fields, tables, page headers) remains a mix of both systems;
migrating the rest is future, screen-by-screen work.

### Primary action colour and interaction accent — now one navy system

This took three rounds to settle:

- **Round 1** made `--accent-*` (buttons, focus ring, links, selected states,
  active-nav accent) resolve to `--action-primary` = `#3557F3` — the brand's
  bright interaction blue, at the time still distinct from `--cta-primary`
  (below).
- **Round 2** split high-emphasis buttons off that scale — `#3557F3` read as
  loud/generic for a primary CTA — onto a separate `--cta-primary`/
  `--cta-primary-hover` pair wired to the frozen brand navy (`--brand-primary`
  = `--palette-indigo-700` = `#1B2A55`, hover `--palette-indigo-900` =
  `#101B33`). `--accent-*` stayed blue for everything else.
- **Round 4** found `#3557F3` still reading as too bright/generic even
  outside buttons — segmented controls, dropdown selected states, checks,
  links, the active-nav accent, focus rings — and made a final, explicit
  product decision: **`#3557F3` is reserved for the frozen logo artwork
  (`Brand.tsx`, `src/assets/brand/lc-mark*.svg`) and never appears as an
  application-UI colour again.** `--action-primary`/`--action-primary-hover`/
  `--focus-ring` (`src/styles/tokens.css`) now resolve to the same navy
  anchors `--cta-primary` already used — so `--accent-*` and `--cta-primary`
  converge on one calm navy system rather than remaining two, and every
  consumer of `--accent-*` moved with it automatically: no component CSS
  needed touching for the segmented filter's selected text, the Select
  primitive's selected item/check icon, links, the ghost-button hover, or the
  focus-visible border colour on inputs/selects. Two things Round 4 fixed at
  the component level, because the token remap alone would have produced the
  wrong shade for them:
  - **`--state-selected-bg`** (`styles/tokens.css`) moved from a light-blue
    tint (`#E8EDFF`) to the low-saturation neutral `--palette-neutral-100`
    (`#EEF1F5`) — the "selected surface" direction Round 4 asked for.
  - **The active-nav accent bar** (`.nav__link[aria-current='page']`) moved
    off `--palette-blue-500` (a *different*, lighter blue than `#3557F3`, but
    part of the same bright-blue family) onto `--text-on-nav` — on the dark
    sidebar, navy itself has too little contrast against `--surface-nav` to
    read as an accent, so this reuses the sidebar's own existing light
    on-dark colour rather than inventing a new light-indigo token.
  - **Hover borders that weren't focus/selected states** (`a.stat:hover`,
    `.choice-list__option:hover`) moved from the (now-navy) `--accent-500` to
    the ordinary neutral `--border-strong` — a plain hover state getting the
    interaction-navy treatment would read as more "selected" than it is.
  - **`.banner--info`** moved *off* `--accent-*` entirely, onto the
    dedicated, WCAG-checked `--status-info-*` family it should have used from
    the start — "info" is a semantic state like warning/danger, not a shade
    of the app's action colour, and riding on the accent scale meant it would
    have gone grey the moment that scale stopped being blue.
  - **The segmented filter's selected border** moved from the (now-navy)
    `--accent-500` to `--border-strong` — matching the task's "restrained
    neutral border" direction, distinct from the navy *text*.

  `--palette-blue-600` (`#3557F3`) and `--palette-blue-500` themselves are
  still declared in `styles/tokens.css` — palette primitives, not deleted —
  but nothing in the light theme resolves through either any more (verified
  by `src/ui/visualPolishRound4.test.ts`, which resolves every light-theme
  token through both files' `:root` blocks the way the real cascade does).
  Focus rings stay clearly visible: `--focus-ring` is very dark navy on the
  app's light surfaces, which is high-contrast, not a visibility trade-off.
  On the dark sidebar itself, that same dark navy is nearly invisible — see
  `--focus-ring-on-dark` under "Final audit remediation" below (F12.7-02).

Semantic status colours (`--green-*`/`--status-*`) remain a separate,
untouched family — `.badge--active`/`.badge--inactive` never read from either
the accent or the CTA scale, in any round.

**Deliberately not touched**: dark-theme `--action-primary`/`--focus-ring`
(`:root[data-theme='dark']` in `styles/tokens.css`) still reference
`--palette-blue-500`. Dark mode is inert — nothing in the application sets
`data-theme="dark"` — so this isn't currently "visible interactive UI
colour," and choosing its real replacement is design work for whenever dark
mode actually ships, not a safe mechanical substitution today.

### Select primitive

[`src/ui/Select.tsx`](../src/ui/Select.tsx) replaces a plain `<select>`'s
*open* popup — the one part of the design system a native select could never
actually join, since that surface is drawn by the OS/browser, not the page —
with a listbox built on **`@radix-ui/react-select`** (added this round; the
only new dependency, and the only file that imports it). Radix supplies
behaviour only (keyboard nav, focus management, positioning/collision,
`aria-*` wiring); every visual rule is this project's own CSS
(`components.css`, "Select (Radix)"), built on the same semantic-token layer
the shell already uses. Selected items use the light `--state-selected-bg`
surface with `--action-primary` text and a `Check` indicator — never gold.

`SelectField` (`Field.tsx`) now renders `Select` internally, so every caller
that already used it (the invite-role select, the customer-status select)
migrated for free. The per-row member-role select in
[`OrganizationScreen.tsx`](../src/features/organization/OrganizationScreen.tsx)
and the sort select in
[`MasterDataPage.tsx`](../src/features/shared/MasterDataPage.tsx) were
migrated directly. **One documented exception**: `UnitSelectField`
(`Field.tsx`) stays a native `<select>` — it isn't really a plain select, it
turns into a free-text field mid-flight and can show an option that isn't in
its own list (a company's typed-in unit), and reproducing that in `Select.tsx`
would mean inventing new behaviour for one caller rather than migrating
existing behaviour.

Radix reserves `Select.Root`'s `value=""` to mean "show the placeholder", so
`Select.tsx` cannot pass an option's real `value: ''` straight through where
one exists (the customer-status field's "no status", a genuine persisted
selection, not a placeholder) — an internal sentinel stands in for `''` only
in the props Radix itself sees, activated only when an option list actually
contains one; `onChange` and the rendered value always use the caller's real
`''`. No domain value is converted for display; see the file's own header
comment.

jsdom implements neither the Pointer Capture methods nor `scrollIntoView`,
which Radix's item-selection handling calls — `src/test/setup.ts` adds
behaviourless stand-ins for both, environment gaps rather than anything this
codebase owns.

### Form action footers

`.form-actions` (the right-aligned button row under a form's fields) carries
no background and no border — Round 2 removed a `--slate-50` tinted strip
that read as visually disconnected from the card; Round 3 then removed the
hairline top border that replaced it too, on review that it still fragmented
the form unnecessarily. Whitespace and right alignment separate the actions
from the fields; nothing is drawn between them.

### Final audit remediation (F12.7-01–03)

An independent audit of the finished Phase 12.7 shell, run after Round 4,
accepted exactly three findings — all fixed without touching any of the
visual work above (colour system, Select, tooltip placement, collapse handle
position, account menu, breadcrumb, workspace sizing all unchanged):

- **F12.7-01 — mobile drawer accessibility.** The off-canvas drawer
  (`Sidebar`/`AppShell.tsx`, "Responsive / mobile" above) closed purely via
  CSS (`transform: translateX(-100%)`), which left it fully present in the
  tab order and the accessibility tree while visually hidden, and left the
  page behind it reachable by keyboard while the drawer was open. Fixed with
  the native `inert` attribute — no focus-trap dependency, no `role="dialog"`
  reframing of what is semantically a navigation landmark, not a modal:
  `<aside id="app-sidebar">` becomes `inert` while closed, and `.shell__main`
  (topbar + page content) becomes `inert` while the drawer is open, which
  contains keyboard focus inside the drawer as a side effect (an inert
  subtree cannot take focus at all) rather than needing a hand-rolled
  sentinel-based trap. Both are gated by a new `useIsMobileViewport`
  hook (`src/features/shell/useIsMobileViewport.ts`, a narrow
  `matchMedia('(max-width: 900px)')` subscription — the same breakpoint the
  CSS drawer rule already uses) — `inert` is never applied on desktop, where
  the rail is a permanent part of the layout, not a drawer. The topbar's
  menu trigger now also carries `aria-expanded`, reflecting `mobileOpen`,
  alongside its existing `aria-controls="app-sidebar"`. Escape, backdrop
  click, and route-selection still close it, and focus still returns to the
  trigger — unified into one effect keyed on the previous open state, since
  restoring focus synchronously (the previous approach) is a silent no-op
  once the region it targets has just become `inert`.
- **F12.7-02 — dark-surface focus contrast.** `--focus-ring` (the navy brand
  colour) reads at roughly 1.32:1 against the dark sidebar
  (`--surface-nav`/`--ink-900` = `#0B1524`) — both are dark, so a keyboard
  user could barely see it there, even though the same colour is
  high-contrast on the app's light surfaces (see the note at the end of
  "Primary action colour and interaction accent" above). Fixed with one new
  token, **`--focus-ring-on-dark`** (`src/ui/tokens.css`), reusing the
  sidebar's own already-approved light foreground, `--text-on-nav`, rather
  than inventing a new colour — it's already proven to read clearly there.
  Applied only to the two controls whose focus ring actually lands on the
  dark rail itself: `.nav__link:focus-visible` and (mobile)
  `.sidebar__mobile-close:focus-visible`. `--focus-ring` is untouched
  everywhere else, including `.sidebar__collapse-toggle`, whose own
  background is the light `--surface-elevated`, not the dark rail, so it
  never had this problem. `src/ui/focusContrast.test.ts` asserts the
  contextual pair (the new token against `--surface-nav`) clears WCAG
  1.4.11's 3:1 non-text threshold, reproduces the audit's cited failure for
  the plain token against the same surface (documenting *why* a second token
  was necessary), and confirms `--focus-ring` on light surfaces is untouched.
- **F12.7-03 — documentation consistency.** This document and
  [Implementation Plan](IMPLEMENTATION_PLAN.md) had drifted in three places:
  Phase 12.6's plan-time risk note still read "purely additive" after it
  shipped otherwise (now cross-referenced to the accurate account above);
  the collapse control was still described as living in the sidebar's brand
  row after Round 4 moved it to an edge-mounted handle outside both the
  brand row and the topbar; and the CTA/interaction-colour description
  hadn't caught up with Round 4 retiring the separate "blue interaction
  accent" entirely. Corrected in place; historical round-by-round narrative
  (Round 1 → Round 4) is kept as history, not deleted, since it explains
  *why* the current state looks the way it does.

### Tests

- `src/features/shell/AppShell.test.tsx` — sidebar collapse (starts expanded,
  every link keeps its accessible name once collapsed, persists across a
  remount, expands again), the edge-handle collapse control (sits on the
  sidebar boundary, outside both `.brand` and `.sidebar__scroll`, not the
  topbar; the wordmark is never truncated; collapsed, nothing is stacked
  under the mark), the breadcrumb's group + current-page label, the account
  menu (shows name/company without opening it, no avatar, opens/closes on
  trigger/Escape, language switch, sign-out), collapsed-tooltip behaviour
  (does not stick after a pointer click, still works on keyboard focus), the
  mobile drawer (opens from the trigger, closes on the backdrop, closes on
  Escape with focus returned to the trigger, closes on route selection), and
  that organisation/user context still renders with unchanged meaning.
- `src/features/shell/AppShell.test.tsx`, describe block "F12.7-01 — mobile
  drawer accessibility" — the sidebar/content are never `inert` on desktop
  regardless of drawer state; at the mobile breakpoint a closed drawer is
  genuinely `inert` (unfocusable, not just visually hidden); the trigger's
  `aria-expanded`/`aria-controls` track drawer state; open, the background is
  `inert` and neither a direct `.focus()` call nor repeated Tab/Shift+Tab
  ever lands focus there; and resizing from mobile to desktop mid-session
  lifts `inert` from the sidebar and leaves it usable.
- `src/ui/focusContrast.test.ts` — F12.7-02's contextual contrast pair, above.
- `src/ui/Select.test.tsx` — renders the current value, opens and lists
  options (including a disabled one), `onChange` on pick, disabled options
  and a disabled select are inert, keyboard open/navigate/select, Escape
  closes and returns focus, label-by-`id` association, and the empty-value
  sentinel round-trip.
- `src/ui/visualPolishRound2.test.ts` / `visualPolishRound3.test.ts` /
  `visualPolishRound4.test.ts` — stylesheet-level facts with no DOM to
  observe them through (which token a class resolves to, that a rule was
  actually removed): the CTA/accent split then their Round 4 convergence onto
  one navy system, the segmented filter's and Select's selected states,
  status badges untouched throughout, `.form-actions`'s background and
  border both absent, the select caret (native) and the Select primitive's
  tokens, `--content-max`'s collapse-aware value, that no
  `.topbar__collapse-trigger` rule remains, and — Round 4 specifically —
  that every light-theme token resolved through *both* token files the way
  the real cascade does (`--action-primary`, `--focus-ring`, the whole
  `--accent-*` scale, `--cta-primary`, `--state-selected-bg`) terminates
  somewhere other than `#3557F3`, while the raw palette anchor stays declared
  for brand artwork.
- `src/App.test.tsx`, `OrganizationScreen.test.tsx`, `PartyScreens.test.tsx`,
  `multiOrganization*.test.ts(x)`, `ProductsScreen.test.tsx` — updated where
  a control's interaction pattern changed (a `<select>`'s `selectOptions` vs.
  Radix's click-to-open-then-click-an-option; sign-out/language now behind
  the account menu) or its DOM location moved; no assertion was weakened to
  make a new component pass.

## Deferred beyond Phase 12.7

- Any dark-mode toggle.
- TanStack Table, when the first complex operational table needs it.
- Screen-by-screen adoption of the new primitives and semantic tokens in
  cards, non-select form fields, tables, and page headers — and the rest of
  `components.css`'s migration off `ui/tokens.css`'s colliding names, begun
  but not finished by Phase 12.7 (shell, buttons, and select fields only).
- A `.button--danger` variant exists in the shared button system
  (Visual Polish Round 2) but is unused — nothing in the current screens was
  reclassified onto it; it's there for the first genuinely destructive action
  that needs it.
