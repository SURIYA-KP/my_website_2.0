# Browser Tools: ground rules

These rules apply to every mini app in this repo.

1. **Runs in the browser only.** No backend, no API routes, no serverless functions. Astro builds to plain static files (`output: 'static'`).
2. **No storage.** Tools never write to localStorage, sessionStorage, IndexedDB, cookies, or any server. Closing the tab erases everything. State that a user wants to keep is exported by the user as a file (download) or, where it fits, encoded in the URL `#hash`, which browsers never send to the server.
3. **No third-party network calls.** All libraries and fonts are bundled from `node_modules` and served from your own domain. A Content-Security-Policy (`connect-src 'self'`) in `src/layouts/Base.astro` makes the browser block any attempt to send data elsewhere.
4. **Useful for everyone.** Easy to use, interactive, works with mouse, keyboard and touch, readable in light and dark themes, usable on a phone.
5. **Verified.** Each tool has a Playwright test in `tests/<slug>.test.mjs`. The shared harness fails the test on external requests, page errors, or anything left in browser storage.
