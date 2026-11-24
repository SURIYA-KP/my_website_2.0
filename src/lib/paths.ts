// Build links that respect Astro's `base` (the site is served from /my_website_2.0/ on GitHub Pages).
// Always use this for internal links instead of hard-coding "/tools/...".
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** url('tools/svg-studio/') -> '/my_website_2.0/tools/svg-studio/' */
export function url(path = '') {
  return `${BASE}/${path.replace(/^\/+/, '')}`;
}
