// Single source of truth for the tool catalogue.
// Add a tool: add an entry here + create src/pages/tools/<slug>.astro.

export type Category = 'Documents' | 'Developer' | 'Media' | 'Data' | 'AI & ML';

export interface Tool {
  slug: string;
  name: string;
  tagline: string;
  category: Category;
  /** 1–2 character monogram shown on the card */
  glyph: string;
  keywords: string[];
  /** Finished and tested. Only ready tools are listed on the hub. */
  ready?: boolean;
}

export const categories: Category[] = ['Documents', 'Developer', 'Media', 'Data', 'AI & ML'];

export const tools: Tool[] = [
  {
    slug: 'svg-studio',
    ready: true,
    name: 'SVG Studio',
    tagline: 'Paste SVG from any AI (or write Mermaid), then click, drag and restyle each part visually, with the code kept in sync. Export SVG or PNG.',
    category: 'Documents',
    glyph: 'Sv',
    keywords: ['svg', 'editor', 'vector', 'ai', 'mermaid', 'flowchart', 'diagram', 'layers', 'png', 'animation'],
  },
  {
    slug: 'pdf-toolkit',
    ready: true,
    name: 'PDF Toolkit',
    tagline: 'Merge, split, reorder, rotate and delete pages, or turn images into a PDF.',
    category: 'Documents',
    glyph: 'Pd',
    keywords: ['pdf', 'merge', 'split', 'rotate', 'images to pdf', 'pages'],
  },
  {
    slug: 'json-studio',
    ready: true,
    name: 'JSON Studio',
    tagline: 'Format, validate and explore JSON as a tree. Convert between JSON, YAML and CSV, and generate TypeScript types.',
    category: 'Developer',
    glyph: '{}',
    keywords: ['json', 'yaml', 'csv', 'format', 'validate', 'typescript', 'tree'],
  },
  {
    slug: 'dev-toolkit',
    ready: true,
    name: 'Dev Toolkit',
    tagline: 'Base64, URL and HTML encoding, JWT decoding, hashes, UUIDs, timestamps and secure passwords.',
    category: 'Developer',
    glyph: '</>',
    keywords: ['base64', 'url encode', 'jwt', 'hash', 'sha256', 'uuid', 'timestamp', 'password'],
  },
  {
    slug: 'image-studio',
    ready: true,
    name: 'Image Studio',
    tagline: 'Compress, resize and convert images (JPEG, PNG, WebP), strip metadata and rasterize SVG, in batches.',
    category: 'Media',
    glyph: 'Im',
    keywords: ['image', 'compress', 'resize', 'convert', 'webp', 'png', 'jpeg', 'svg', 'exif'],
  },
  {
    slug: 'qr-studio',
    ready: true,
    name: 'QR Studio',
    tagline: 'Generate styled QR codes for links, Wi-Fi and contacts, or scan one from an image or your camera.',
    category: 'Media',
    glyph: 'QR',
    keywords: ['qr', 'qr code', 'wifi', 'vcard', 'scan', 'barcode'],
  },
  {
    slug: 'data-explorer',
    name: 'Data Explorer',
    tagline: 'Open a CSV, then sort, filter, profile columns, chart it and query it with SQL.',
    category: 'Data',
    glyph: 'Dx',
    keywords: ['csv', 'tsv', 'data', 'sql', 'chart', 'table', 'statistics'],
  },
  {
    slug: 'optimizer-viz',
    name: 'Optimizer Race',
    tagline: 'Watch SGD, Momentum, RMSProp and Adam race across classic loss landscapes. Tune and compare.',
    category: 'AI & ML',
    glyph: '∇',
    keywords: ['gradient descent', 'adam', 'sgd', 'optimizer', 'loss surface', 'visualization'],
  },
  {
    slug: 'ml-lab',
    name: 'ML Lab',
    tagline: 'Place points, then watch k-means cluster them and a small neural network learn a decision boundary live.',
    category: 'AI & ML',
    glyph: 'NN',
    keywords: ['neural network', 'k-means', 'clustering', 'classification', 'decision boundary', 'visualization'],
  },
];

/** Tools shown on the hub. */
export const readyTools = tools.filter((t) => t.ready);

export const toolBySlug = (slug: string) => {
  const t = tools.find((t) => t.slug === slug);
  if (!t) throw new Error(`Unknown tool slug: ${slug}`);
  return t;
};
