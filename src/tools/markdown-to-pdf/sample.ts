// Sample document that shows every feature of the tool.
const logo =
  'data:image/svg+xml;base64,' +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="140" viewBox="0 0 560 140"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#4f46e5"/><stop offset="1" stop-color="#0891b2"/></linearGradient></defs><rect width="560" height="140" rx="14" fill="url(#g)"/><text x="280" y="68" fill="#fff" font-family="Inter, Arial, sans-serif" font-size="30" font-weight="700" text-anchor="middle">Markdown → PDF</text><text x="280" y="102" fill="#e0e7ff" font-family="Inter, Arial, sans-serif" font-size="16" text-anchor="middle">embedded as a data URL, so it prints anywhere</text></svg>`,
  );

export const SAMPLE = `---
title: Quarterly Engineering Report
---

# Quarterly Engineering Report

*Prepared with **Markdown → PDF**. Everything here is rendered in your browser and nothing is uploaded.*

[TOC]

## Highlights

- Shipped **three** major releases and ~~two~~ one hotfix
- Cut median build time from 9m 40s to **4m 05s**
- Visit https://example.com or read the [style guide](https://example.com/style) (autolinks work)
- Inline code like \`npm run build\`, keyboard keys like <kbd>Ctrl</kbd> + <kbd>P</kbd> and <mark>highlights</mark>

> Good documentation is a love letter to your future self.
> — Damian Conway

### Release checklist

- [x] Write release notes
- [x] Tag version \`v2.4.0\`
- [ ] Update the public roadmap
- [ ] Announce in the changelog

## Metrics

| Area          | Q2      | Q3      | Change  |
| :------------ | ------: | ------: | :-----: |
| Build time    | 9m 40s  | 4m 05s  | −58%    |
| Test coverage | 71.2%   | 83.9%   | +12.7   |
| Open bugs     | 148     | 92      | −38%    |
| Deploys/week  | 6       | 19      | ×3.2    |

## Code

\`\`\`typescript
// Debounce any function: handy for live previews
export function debounce<T extends (...args: unknown[]) => void>(fn: T, ms = 200) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
\`\`\`

\`\`\`python
from statistics import mean

def summarize(samples: list[float]) -> dict[str, float]:
    """Return basic stats for a list of build times (seconds)."""
    return {"min": min(samples), "mean": round(mean(samples), 1), "max": max(samples)}
\`\`\`

\`\`\`bash
git tag -a v2.4.0 -m "Release 2.4.0" && git push --tags
\`\`\`

## Math

Inline math such as $E = mc^2$ or $\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$ flows with the text,
while prices like $5 and $10 stay plain. Display math gets its own line:

$$
\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi} \\, dx
$$

$$
\\mathbf{A} = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}, \\qquad \\det \\mathbf{A} = a_{11}a_{22} - a_{12}a_{21}
$$

<!-- pagebreak -->

## Diagrams

\`\`\`mermaid
flowchart LR
  A[Write Markdown] --> B{Preview looks good?}
  B -- Yes --> C[Download PDF]
  B -- No --> A
  C --> D((Share))
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant You
  participant Browser
  You->>Browser: Type Markdown
  Browser-->>You: Live preview
  You->>Browser: Download PDF
  Browser-->>You: report.pdf (never uploaded)
\`\`\`

## Images

![Banner](${logo})

Remote images are blocked by the page's privacy policy and shown as a placeholder:

![Team photo](https://images.example.com/team.jpg)

## Tips

1. Put \`<!-- pagebreak -->\` or \`\\pagebreak\` on its own line to start a new page.
2. Add \`[TOC]\` where you want a table of contents.
3. Open **Page setup** to choose paper size, margins, theme, header and page numbers.
4. Click **Download PDF** and choose *Save as PDF* in the print dialog.

<details>
<summary>Raw HTML works too (sanitized)</summary>

Scripts and event handlers are stripped, so pasted content can't run code.

</details>

---

*End of report.*
`;
