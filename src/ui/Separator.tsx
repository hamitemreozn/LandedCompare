/**
 * A locally-owned Separator — a visual divider with the correct ARIA
 * semantics, so it reads as structure rather than decoration when it carries
 * meaning, or is hidden entirely when it does not.
 */
export function Separator({
  orientation = 'horizontal',
  decorative = true,
}: {
  readonly orientation?: 'horizontal' | 'vertical'
  readonly decorative?: boolean
}) {
  return (
    <div
      role={decorative ? 'none' : 'separator'}
      aria-orientation={decorative ? undefined : orientation}
      className={orientation === 'vertical' ? 'separator separator--vertical' : 'separator'}
    />
  )
}
