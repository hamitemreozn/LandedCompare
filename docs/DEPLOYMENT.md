# Deployment

## Current status — no deployment, by design

The next milestone is a **local pilot on a single company computer**
([Product Scope](PRODUCT_SCOPE.md) §3). It has no server, no API, no hosting, no
DNS and no HTTPS requirement: the application is built with `npm run build` and
run from the local machine, and all data lives in that machine's IndexedDB.

This is why backup and restore are MVP features rather than deployment concerns
— there is no infrastructure to take a nightly dump. See
[Local Persistence & Backup](LOCAL_PERSISTENCE_AND_BACKUP.md).

Two consequences for the pilot machine:

- The app must be served from a **stable origin**. IndexedDB is scoped per
  origin, so moving between `file://`, a changing localhost port, or a different
  hostname makes the existing database invisible. Pick one local origin and keep
  it.
- Browser data for that origin must not be cleared. "Clear browsing data"
  destroys the working database and every internal snapshot in one action; only
  exported backup files survive it.

## Later — public hosting

Unchanged from the original plan, and not scheduled:

```text
Local Git
  -> GitHub
  -> Static Production Build
  -> Cloudflare Pages
  -> Custom Domain
  -> DNS
  -> HTTPS
```

Static hosting stays sufficient for as long as the product is local-first: there
is no server-side component to deploy. A backend would only enter the picture
with the multi-user migration described in [Data Model](DATA_MODEL.md) §13,
which is explicitly not being built.
