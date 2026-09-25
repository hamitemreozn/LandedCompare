/**
 * The LandedCompare brand mark.
 *
 * The mark is inline JSX, not an `<img src>` of the files under
 * `src/assets/brand/` — those files are the frozen source of truth (also used
 * for `public/favicon.svg` and future PNG/app-icon exports), duplicated here
 * so the mark can sit inline next to the "LandedCompare" wordmark without an
 * extra network request. The wordmark itself is always plain text (IBM Plex
 * Sans 600), never an SVG with live `<text>` — see docs/DESIGN_SYSTEM.md.
 */

// The master monogram geometry (docs/DESIGN_SYSTEM.md, "Master mark"). Every
// other rendering of the mark — including the app-icon tile below — is this
// exact `d`, scaled, never redrawn independently: that is what keeps the tile
// optically identical to the standalone mark instead of merely similar.
const MASTER_L_PATH = 'M15 16 L15 44 L29 44'
const MASTER_C_PATH = 'M29 28.06 A12 12 0 1 1 29 43.94'
const MASTER_DOT = { cx: 29, cy: 44, r: 3.2 } as const

export type BrandMarkVariant = 'standard' | 'small' | 'mono' | 'dark'

const VARIANT_STROKE: Record<BrandMarkVariant, { primary: string; arc: string; dot?: string }> = {
  standard: { primary: '#1B2A55', arc: '#3557F3', dot: '#C99A3D' },
  small: { primary: '#1B2A55', arc: '#3557F3' },
  mono: { primary: '#12172B', arc: '#12172B', dot: '#12172B' },
  dark: { primary: '#FFFFFF', arc: '#8FA3FF', dot: '#C99A3D' },
}

/**
 * Below ~24px, use `variant="small"`: no dot, thicker optical stroke so the
 * mark does not disappear at favicon/nav-rail sizes.
 */
export function BrandMark({
  variant = 'standard',
  size = 24,
  title,
}: {
  readonly variant?: BrandMarkVariant
  readonly size?: number
  readonly title?: string
}) {
  const { primary, arc, dot } = VARIANT_STROKE[variant]
  const strokeWidth = variant === 'small' ? 9 : 8

  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title !== undefined ? 'img' : undefined}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      <path
        d={MASTER_L_PATH}
        stroke={primary}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d={MASTER_C_PATH} stroke={arc} strokeWidth={strokeWidth} strokeLinecap="round" fill="none" />
      {dot !== undefined ? <circle cx={MASTER_DOT.cx} cy={MASTER_DOT.cy} r={MASTER_DOT.r} fill={dot} /> : null}
    </svg>
  )
}

/**
 * The app-icon tile variant: a rounded square carrying the mark, used where a
 * self-contained badge is needed (the sidebar's brand slot, browser tab
 * icons). It is the master monogram (`MASTER_L_PATH`/`MASTER_C_PATH`/
 * `MASTER_DOT` above) placed in a scaled, translated `<g>` — a proportional
 * instance of the master geometry, not an independent redraw — so the L/C
 * join and the gold dot line up optically with the standalone mark. Only the
 * padding/centring inside the square (the `transform`) and the tile-specific
 * colours (white/light-blue for contrast on navy) are tile-specific.
 */
export function AppIconTile({ size = 34, title }: { readonly size?: number; readonly title?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role={title !== undefined ? 'img' : undefined}
      aria-hidden={title === undefined ? true : undefined}
      aria-label={title}
    >
      <rect width="64" height="64" rx="14" fill="#1B2A55" />
      <g transform="translate(9.6,8) scale(0.8)">
        <path
          d={MASTER_L_PATH}
          stroke="#FFFFFF"
          strokeWidth={8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <path d={MASTER_C_PATH} stroke="#8FA3FF" strokeWidth={8} strokeLinecap="round" fill="none" />
        <circle cx={MASTER_DOT.cx} cy={MASTER_DOT.cy} r={MASTER_DOT.r} fill="#C99A3D" />
      </g>
    </svg>
  )
}
