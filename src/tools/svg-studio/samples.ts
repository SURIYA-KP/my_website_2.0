// Built-in sample SVGs, written the way AI assistants typically produce them:
// grouped, id-labelled parts, gradients in <defs>, a <style> block, comments.

export interface Sample {
  id: string;
  name: string;
  description: string;
  code: string;
}

const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="200" viewBox="0 0 480 200">
  <title>Lumen Labs logo</title>
  <defs>
    <linearGradient id="markGradient" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#06b6d4"/>
    </linearGradient>
  </defs>
  <!-- Background card -->
  <rect id="background" width="480" height="200" rx="24" fill="#0f172a"/>
  <!-- Logo mark: a stylised light bulb made of two shapes -->
  <g id="mark" transform="translate(48 40)">
    <circle id="bulb" cx="60" cy="52" r="52" fill="url(#markGradient)"/>
    <path id="spark" d="M60 18 L70 46 L98 52 L70 60 L60 88 L50 60 L22 52 L50 46 Z" fill="#ffffff" opacity="0.92"/>
    <rect id="base" x="38" y="108" width="44" height="12" rx="6" fill="#94a3b8"/>
  </g>
  <!-- Wordmark -->
  <g id="wordmark">
    <text id="name" x="190" y="106" font-family="Inter, Helvetica, Arial, sans-serif" font-size="46" font-weight="700" fill="#f8fafc">Lumen Labs</text>
    <text id="tagline" x="192" y="138" font-family="Inter, Helvetica, Arial, sans-serif" font-size="16" letter-spacing="3" fill="#94a3b8">IDEAS, ILLUMINATED</text>
  </g>
</svg>`;

const illustration = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="640" height="400">
  <title>Mountain cabin at sunset</title>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fde68a"/>
      <stop offset="0.55" stop-color="#fdba74"/>
      <stop offset="1" stop-color="#f472b6"/>
    </linearGradient>
  </defs>
  <style>
    .tree-top { fill: #166534; }
    .tree-trunk { fill: #78350f; }
  </style>
  <rect id="sky-background" width="640" height="400" fill="url(#sky)"/>
  <circle id="sun" cx="470" cy="150" r="56" fill="#fff7ed" opacity="0.9"/>
  <g id="mountains">
    <path id="mountain-back" d="M0 290 L140 150 L260 260 L380 120 L560 280 L640 230 L640 400 L0 400 Z" fill="#a855f7" opacity="0.55"/>
    <path id="mountain-front" d="M0 320 L120 230 L230 300 L360 210 L500 310 L640 270 L640 400 L0 400 Z" fill="#7c3aed"/>
    <path id="snow-cap" d="M380 120 L414 150 L396 146 L380 160 L364 146 L348 152 Z" fill="#faf5ff"/>
  </g>
  <rect id="ground" y="330" width="640" height="70" fill="#4d7c0f"/>
  <g id="cabin" transform="translate(250 262)">
    <rect id="cabin-wall" x="0" y="30" width="120" height="70" fill="#b45309"/>
    <path id="cabin-roof" d="M-12 34 L60 -12 L132 34 Z" fill="#7f1d1d"/>
    <rect id="door" x="48" y="58" width="24" height="42" rx="3" fill="#451a03"/>
    <rect id="window-left" x="14" y="48" width="22" height="20" fill="#fde047"/>
    <rect id="window-right" x="84" y="48" width="22" height="20" fill="#fde047"/>
    <rect id="chimney" x="88" y="-4" width="14" height="26" fill="#57534e"/>
  </g>
  <g id="trees">
    <g id="tree-1" transform="translate(90 268)">
      <rect class="tree-trunk" x="-5" y="50" width="10" height="20"/>
      <path class="tree-top" d="M0 0 L28 54 L-28 54 Z"/>
    </g>
    <g id="tree-2" transform="translate(150 286) scale(0.75)">
      <rect class="tree-trunk" x="-5" y="50" width="10" height="20"/>
      <path class="tree-top" d="M0 0 L28 54 L-28 54 Z"/>
    </g>
    <g id="tree-3" transform="translate(540 272)">
      <rect class="tree-trunk" x="-5" y="50" width="10" height="20"/>
      <path class="tree-top" d="M0 0 L28 54 L-28 54 Z"/>
    </g>
  </g>
  <g id="birds" fill="none" stroke="#7c2d12" stroke-width="3" stroke-linecap="round">
    <path d="M150 90 q10 -10 20 0 q10 -10 20 0"/>
    <path d="M200 120 q8 -8 16 0 q8 -8 16 0"/>
  </g>
</svg>`;

const icons = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260" fill="none" stroke="#1e293b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <title>Icon set</title>
  <rect id="canvas" width="400" height="260" rx="16" fill="#f8fafc" stroke="none"/>
  <!-- Each icon is drawn on a 24x24 grid and scaled 2.5x -->
  <g id="icon-home" transform="translate(40 40) scale(2.5)">
    <path d="M3 10.5 L12 3 L21 10.5"/>
    <path d="M5 9.5 V20 H19 V9.5"/>
    <path d="M10 20 V14 H14 V20"/>
  </g>
  <g id="icon-search" transform="translate(160 40) scale(2.5)">
    <circle cx="11" cy="11" r="7"/>
    <path d="M20 20 L16 16"/>
  </g>
  <g id="icon-heart" transform="translate(280 40) scale(2.5)">
    <path d="M12 20 C5 15 3 12 3 8.5 A4.5 4.5 0 0 1 12 6.5 A4.5 4.5 0 0 1 21 8.5 C21 12 19 15 12 20 Z" fill="#fecdd3" stroke="#e11d48"/>
  </g>
  <g id="icon-bell" transform="translate(40 150) scale(2.5)">
    <path d="M6 16 V11 A6 6 0 0 1 18 11 V16 L20 18 H4 Z"/>
    <path d="M10 21 H14"/>
  </g>
  <g id="icon-settings" transform="translate(160 150) scale(2.5)">
    <circle cx="12" cy="12" r="3"/>
    <path d="M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9"/>
  </g>
  <g id="icon-mail" transform="translate(280 150) scale(2.5)">
    <rect x="3" y="5" width="18" height="14" rx="2"/>
    <path d="M3 7 L12 13 L21 7"/>
  </g>
</svg>`;

const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="360" viewBox="0 0 560 360" font-family="Inter, Helvetica, Arial, sans-serif">
  <title>Quarterly revenue infographic</title>
  <rect id="card" width="560" height="360" rx="20" fill="#ffffff" stroke="#e2e8f0"/>
  <g id="header">
    <text id="title" x="32" y="48" font-size="22" font-weight="700" fill="#0f172a">Revenue by quarter</text>
    <text id="subtitle" x="32" y="72" font-size="13" fill="#64748b">Millions of USD, fiscal year 2026</text>
  </g>
  <g id="axis" stroke="#cbd5e1" stroke-width="1">
    <line id="baseline" x1="60" y1="300" x2="528" y2="300"/>
    <line x1="60" y1="240" x2="528" y2="240" stroke-dasharray="4 4"/>
    <line x1="60" y1="180" x2="528" y2="180" stroke-dasharray="4 4"/>
    <line x1="60" y1="120" x2="528" y2="120" stroke-dasharray="4 4"/>
  </g>
  <g id="bars">
    <rect id="bar-q1" x="90" y="210" width="72" height="90" rx="6" fill="#93c5fd"/>
    <rect id="bar-q2" x="204" y="174" width="72" height="126" rx="6" fill="#60a5fa"/>
    <rect id="bar-q3" x="318" y="150" width="72" height="150" rx="6" fill="#3b82f6"/>
    <rect id="bar-q4" x="432" y="108" width="72" height="192" rx="6" fill="#1d4ed8"/>
  </g>
  <g id="values" font-size="14" font-weight="600" fill="#0f172a" text-anchor="middle">
    <text x="126" y="200">3.0</text>
    <text x="240" y="164">4.2</text>
    <text x="354" y="140">5.0</text>
    <text x="468" y="98">6.4</text>
  </g>
  <g id="labels" font-size="13" fill="#64748b" text-anchor="middle">
    <text x="126" y="322">Q1</text>
    <text x="240" y="322">Q2</text>
    <text x="354" y="322">Q3</text>
    <text x="468" y="322">Q4</text>
  </g>
  <g id="callout" transform="translate(396 34)">
    <rect width="132" height="44" rx="22" fill="#dcfce7"/>
    <text x="66" y="28" font-size="14" font-weight="700" fill="#15803d" text-anchor="middle">+113% YoY</text>
  </g>
</svg>`;

const loader = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <title>Animated loader</title>
  <style>
    .pulse { animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.6; } }
  </style>
  <rect id="backdrop" width="240" height="240" rx="32" fill="#111827"/>
  <circle id="halo" class="pulse" cx="120" cy="120" r="78" fill="#4f46e5"/>
  <circle id="track" cx="120" cy="120" r="54" fill="none" stroke="#374151" stroke-width="12"/>
  <g id="spinner">
    <circle id="arc" cx="120" cy="120" r="54" fill="none" stroke="#a5b4fc" stroke-width="12" stroke-linecap="round" stroke-dasharray="90 250"/>
    <animateTransform attributeName="transform" type="rotate" from="0 120 120" to="360 120 120" dur="1.2s" repeatCount="indefinite"/>
  </g>
  <g id="dots" fill="#e0e7ff">
    <circle cx="96" cy="196" r="6">
      <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite" begin="0s"/>
    </circle>
    <circle cx="120" cy="196" r="6">
      <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite" begin="0.2s"/>
    </circle>
    <circle cx="144" cy="196" r="6">
      <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite" begin="0.4s"/>
    </circle>
  </g>
</svg>`;

export const SAMPLES: Sample[] = [
  { id: 'illustration', name: 'Flat illustration', description: 'Cabin scene with grouped trees, cabin and mountains', code: illustration },
  { id: 'logo', name: 'Logo with text', description: 'Gradient mark and wordmark', code: logo },
  { id: 'icons', name: 'Icon set', description: 'Six stroke icons on a 24px grid', code: icons },
  { id: 'chart', name: 'Infographic', description: 'Bar chart with labels and a callout', code: chart },
  { id: 'loader', name: 'Animated loader', description: 'SMIL spinner + CSS pulse', code: loader },
];

export const AI_PROMPT = `Create an SVG of: [describe what you want, e.g. "a flat illustration of a lighthouse at night"].

Requirements:
- Output only one complete <svg> element in a single \`\`\`svg code block.
- Include xmlns="http://www.w3.org/2000/svg", a viewBox, and width/height.
- Group related parts in <g> elements and give every meaningful part a short, descriptive id (for example id="roof", id="left-window", id="title").
- Use plain shapes (rect, circle, ellipse, line, polygon, path) and real <text> elements for words.
- Put gradients and reusable parts in <defs>; prefer presentation attributes (fill, stroke) or one small <style> block.
- No scripts, no external images or web fonts, no <foreignObject>.

If the subject is a diagram (flowchart, sequence, timeline, org chart, mind map), you may instead answer with Mermaid code in a \`\`\`mermaid block.`;
