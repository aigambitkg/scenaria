import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// The landing page: a static page with the real Simple view as a live example.
// `npm run build:site` writes it to dist-site/ — plain files for any static host (GitHub Pages, Netlify, …).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist-site", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
