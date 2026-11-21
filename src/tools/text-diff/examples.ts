export interface Example {
  id: string;
  label: string;
  nameA: string;
  nameB: string;
  a: string;
  b: string;
}

const codeA = `import { readFile } from 'node:fs/promises';

const DEFAULT_RETRIES = 3;
const TIMEOUT_MS = 5000;

/**
 * Load the settings file and merge it with defaults.
 */
export async function loadConfig(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    retries: parsed.retries ?? DEFAULT_RETRIES,
    timeout: parsed.timeout ?? TIMEOUT_MS,
    verbose: false,
  };
}

export function formatUser(user) {
  return user.firstName + ' ' + user.lastName;
}

export function isAdult(age) {
  return age >= 18;
}

export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}

export function average(values) {
  return sum(values) / values.length;
}
`;

const codeB = `import { readFile } from 'node:fs/promises';

const DEFAULT_RETRIES = 5;
const TIMEOUT_MS = 5000;

/**
 * Load the settings file and merge it with defaults.
 * Throws a helpful error when the file is missing.
 */
export async function loadConfig(path) {
  const raw = await readFile(path, 'utf8').catch(() => {
    throw new Error(\`Config not found: \${path}\`);
  });
  const parsed = JSON.parse(raw);
  return {
    retries: parsed.retries ?? DEFAULT_RETRIES,
    timeout: parsed.timeout ?? TIMEOUT_MS,
    verbose: parsed.verbose === true,
  };
}

export function formatUser({ firstName, lastName }) {
  return \`\${firstName} \${lastName}\`.trim();
}

export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}

export function average(values) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}
`;

const yamlA = `# Service configuration
service:
  name: billing-api
  port: 8080
  replicas: 2
  log_level: info

database:
  host: db.internal
  port: 5432
  name: billing
  pool_size: 10
  ssl: false

cache:
  enabled: true
  ttl_seconds: 300
  backend: memory

features:
  invoices_v2: false
  dark_mode: true
  export_csv: true

allowed_origins:
  - https://app.example.com
  - https://admin.example.com
`;

const yamlB = `# Service configuration
service:
  name: billing-api
  port: 8443
  replicas: 4
  log_level: warn
  tls: true

database:
  host: db-primary.internal
  port: 5432
  name: billing
  pool_size: 25
  ssl: true

cache:
  enabled: true
  ttl_seconds: 600
  backend: redis
  redis_url: redis://cache.internal:6379

features:
  invoices_v2: true
  dark_mode: true

allowed_origins:
  - https://app.example.com
  - https://admin.example.com
  - https://partners.example.com
`;

const proseA = `Meeting notes – Product sync

Attendees: Ana, Ben, Chloe
Date: Tuesday, 3 March

1. The beta launch is planned for the end of April.
2. Ben will prepare the onboarding emails for new users.
3. Pricing stays at 9 dollars per month for the starter plan.

Open questions:
- Do we need a free tier?
- Who owns the help center articles?
`;

const proseB = `Meeting notes – Product sync

Attendees: Ana, Ben, Chloe, Dev
Date: Tuesday, 10 March

1. The beta launch is planned for the middle of May.
2. Chloe will prepare the onboarding emails for new users.
3. Pricing stays at 12 dollars per month for the starter plan.
4. Dev joins the team as a support engineer.

Open questions:
- Who owns the help center articles?
`;

export const EXAMPLES: Example[] = [
  { id: 'code', label: 'Code (JavaScript)', nameA: 'config.v1.js', nameB: 'config.v2.js', a: codeA, b: codeB },
  { id: 'yaml', label: 'Config file (YAML)', nameA: 'service.old.yaml', nameB: 'service.new.yaml', a: yamlA, b: yamlB },
  { id: 'prose', label: 'Prose (notes)', nameA: 'notes-draft.txt', nameB: 'notes-final.txt', a: proseA, b: proseB },
];
