// Built-in synthetic sample datasets (generated deterministically, no network).

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const csvCell = (v: string | number | boolean | null) => {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (head: string[], rows: (string | number | boolean | null)[][]) =>
  [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');

function sales(): string {
  const r = rng(42);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const regions: Record<string, string[]> = {
    North: ['Maya Lindqvist', 'Tomás Herrera'],
    South: ['Aisha Bello', 'Daniel Okafor'],
    East: ['Mei Chen', 'Lukas Novak'],
    West: ['Sofia Rossi', 'Jamal Carter'],
    Central: ['Priya Nair', 'Ethan Brooks'],
  };
  const products: [string, string, number][] = [
    ['Trail Backpack', 'Outdoor', 89],
    ['Camping Stove', 'Outdoor', 64],
    ['Headlamp', 'Outdoor', 29],
    ['Water Filter', 'Outdoor', 45],
    ['Desk Lamp', 'Home', 39],
    ['Ceramic Mug Set', 'Home', 24],
    ['Linen Throw', 'Home', 58],
    ['Wireless Earbuds', 'Electronics', 129],
    ['Smart Plug', 'Electronics', 19],
    ['USB-C Hub', 'Electronics', 49],
    ['Yoga Mat', 'Fitness', 35],
    ['Kettlebell 12kg', 'Fitness', 54],
  ];
  const start = Date.UTC(2024, 0, 1);
  const days = 547; // through mid-2025
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 0; i < 2000; i++) {
    const day = Math.floor(r() * days);
    const t = start + day * 86400000;
    const month = new Date(t).getUTCMonth();
    const region = pick(Object.keys(regions));
    const rep = pick(regions[region]);
    const [product, category, base] = pick(products);
    const season = month === 10 || month === 11 ? 1.6 : month >= 5 && month <= 7 && category === 'Outdoor' ? 1.4 : 1;
    const units = Math.max(1, Math.round((1 + r() * r() * 14) * season));
    const price = Math.round(base * (0.92 + r() * 0.16) * 100) / 100;
    const discount = pick([0, 0, 0, 0.05, 0.05, 0.1, 0.15, 0.2]);
    const revenue = Math.round(units * price * (1 - discount) * 100) / 100;
    const returned = r() < 0.05;
    const rating = r() < 0.15 ? null : Math.max(1, Math.min(5, Math.round(3.9 + (r() - 0.5) * 3 - (returned ? 1.5 : 0))));
    rows.push([10001 + i, isoDay(t), region, rep, product, category, units, price, discount, revenue, returned, rating]);
  }
  rows.sort((a, b) => (a[1] as string).localeCompare(b[1] as string) || (a[0] as number) - (b[0] as number));
  return toCsv(['Order ID', 'Order Date', 'Region', 'Sales Rep', 'Product', 'Category', 'Units', 'Unit Price', 'Discount', 'Revenue', 'Returned', 'Rating'], rows);
}

function weather(): string {
  const r = rng(7);
  const cities: [string, number, number, number, number][] = [
    // name, mean temp, seasonal amplitude, rain probability, humidity base
    ['Oslo', 6, 11, 0.42, 72],
    ['Lisbon', 17.5, 6, 0.28, 68],
    ['Toronto', 9, 14, 0.36, 70],
    ['Singapore', 28, 0.8, 0.55, 82],
  ];
  const rows: (string | number | boolean | null)[][] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let d = 0; d < 366; d++) {
    const t = start + d * 86400000;
    const season = -Math.cos(((d - 15) / 366) * 2 * Math.PI);
    for (const [city, mean, amp, pRain, hum] of cities) {
      const tmax = Math.round((mean + amp * season + 4 + (r() - 0.5) * 6) * 10) / 10;
      const tmin = Math.round((tmax - 5 - r() * 5) * 10) / 10;
      const rains = r() < pRain;
      const precip = r() < 0.03 ? null : rains ? Math.round(r() * r() * 30 * 10) / 10 : 0;
      const snow = rains && tmax < 1;
      const condition = snow ? 'Snow' : rains ? (precip !== null && precip > 18 ? 'Storm' : 'Rain') : r() < 0.45 ? 'Cloudy' : 'Sunny';
      const humidity = Math.round(Math.min(100, hum + (rains ? 12 : -4) + (r() - 0.5) * 16));
      const wind = Math.round((8 + r() * 18 + (rains ? 6 : 0)) * 10) / 10;
      rows.push([isoDay(t), city, tmax, tmin, precip, humidity, wind, condition]);
    }
  }
  return toCsv(['date', 'city', 'temp_max_c', 'temp_min_c', 'precip_mm', 'humidity_pct', 'wind_kmh', 'condition'], rows);
}

function traffic(): string {
  const r = rng(2025);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const pages = ['/', '/', '/pricing', '/features', '/blog/csv-tips', '/blog/sql-basics', '/docs/getting-started', '/docs/api', '/signup'];
  const devices = ['desktop', 'desktop', 'mobile', 'mobile', 'mobile', 'tablet'];
  const browsers = ['Chrome', 'Chrome', 'Chrome', 'Safari', 'Safari', 'Firefox', 'Edge'];
  const countries = ['US', 'US', 'US', 'DE', 'GB', 'IN', 'BR', 'JP', 'FR', 'CA', 'NG', 'AU'];
  const rows: (string | number | boolean | null)[][] = [];
  const start = Date.UTC(2025, 2, 1);
  for (let i = 0; i < 3000; i++) {
    const hour = Math.floor(Math.abs(((r() + r() + r()) / 3 - 0.5) * 2) * 12 + 8) % 24;
    const t = start + Math.floor(r() * 31) * 86400000 + hour * 3600000 + Math.floor(r() * 3600) * 1000;
    const d = new Date(t);
    const ts = `${isoDay(t)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const page = pick(pages);
    const device = pick(devices);
    const pagesViewed = Math.max(1, Math.round(-Math.log(1 - r()) * 3));
    const duration = Math.round(Math.exp(3 + r() * 2.2) * Math.sqrt(pagesViewed));
    const converted = r() < 0.02 + pagesViewed * 0.025 + (page === '/pricing' || page === '/signup' ? 0.08 : 0);
    const revenue = converted ? Math.round((19 + r() * 180) * 100) / 100 : null;
    rows.push([`s-${(100000 + i).toString(36)}`, ts, page, device, pick(browsers), pick(countries), duration, pagesViewed, converted, revenue]);
  }
  rows.sort((a, b) => (a[1] as string).localeCompare(b[1] as string));
  return toCsv(['session_id', 'timestamp', 'landing_page', 'device', 'browser', 'country', 'duration_s', 'pages_viewed', 'converted', 'revenue_usd'], rows);
}

export const SAMPLES = [
  { id: 'sales', label: 'Sales orders', name: 'sales-orders.csv', detail: '2,000 orders · 12 columns', make: sales },
  { id: 'weather', label: 'Daily weather', name: 'weather-2024.csv', detail: '4 cities × 366 days', make: weather },
  { id: 'traffic', label: 'Web sessions', name: 'web-sessions.csv', detail: '3,000 sessions with timestamps', make: traffic },
] as const;
