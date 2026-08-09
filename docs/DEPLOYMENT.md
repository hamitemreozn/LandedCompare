# Deployment

## Planned path

```text
Local Git
  -> GitHub
  -> Static Production Build
  -> Cloudflare Pages
  -> Custom Domain
  -> DNS
  -> HTTPS
```

## Phase 0 status

No deployment has been performed. The app produces a static production build via
`npm run build` (output in `dist/`), which is the artifact that will eventually be
deployed to Cloudflare Pages. Setting up hosting, DNS, and HTTPS is out of scope
for this phase.
