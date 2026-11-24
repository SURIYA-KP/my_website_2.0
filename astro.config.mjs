import { defineConfig } from 'astro/config';

// Fully static output: no server, no database. Every tool runs in the visitor's browser.
// Deployed to https://suriya-kp.github.io/my_website_2.0/ (GitHub Pages project site).
// If you move to a custom domain or <user>.github.io, set base to '/'.
export default defineConfig({
  site: 'https://suriya-kp.github.io',
  base: '/my_website_2.0',
  output: 'static',
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  vite: {
    optimizeDeps: { exclude: ['pdfjs-dist'] },
    build: { chunkSizeWarningLimit: 4000 },
  },
});
