import { defineConfig } from 'astro/config';

// Fully static output: no server, no database. Every tool runs in the visitor's browser.
export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  vite: {
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    build: { chunkSizeWarningLimit: 4000 },
  },
});
