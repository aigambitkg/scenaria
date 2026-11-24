# The landing page

A static page that shows what Scenaria does: the drawings of the introduction and the real Simple view
as a live example (the same code as the dashboard: `ui/src/Demo.tsx`, `ui/src/TourArt.tsx`).

```bash
npm run dev:site     # work on it with live reload
npm run build:site   # writes plain files to dist-site/
```

- **Texts:** `site/src/text.ts`, German and English with the same keys. Few words on purpose. Only claims the
  product keeps today; the status line names the limits.
- **Links** (repository, guide, imprint, privacy): `LINKS` in `site/src/text.ts`.
- **Install lines:** `INSTALL` in the same file. They install from source, which works without a release.
  After the first release they can become the one-line installer.
- **Nothing from other servers:** fonts and scripts are part of the build; the page sets no cookies.
- **Publishing:** `dist-site/` runs on any static host. For GitHub Pages: Settings → Pages → Source
  "GitHub Actions", then Actions → "Landing page" → Run workflow. It never publishes by itself.
