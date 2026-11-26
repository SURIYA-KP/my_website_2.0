// CSV / JSON export of a view (visible columns, filtered + sorted rows).
import { rawText, rawValue } from './format';
import type { DataView } from './view';

function csvCell(s: string, delim: string) {
  return s.includes(delim) || /["\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function viewToCsv(view: DataView, delim = ','): string {
  const cols = view.visibleColumns.map((c) => view.ds.columns[c]);
  const out: string[] = [cols.map((c) => csvCell(c.name, delim)).join(delim)];
  const idx = view.indices;
  for (let i = 0; i < idx.length; i++) {
    const r = idx[i];
    let line = '';
    for (let k = 0; k < cols.length; k++) {
      if (k) line += delim;
      line += csvCell(rawText(cols[k], r), delim);
    }
    out.push(line);
  }
  return out.join('\r\n') + '\r\n';
}

export function viewToJson(view: DataView): string {
  const cols = view.visibleColumns.map((c) => view.ds.columns[c]);
  const idx = view.indices;
  const parts: string[] = [];
  for (let i = 0; i < idx.length; i++) {
    const r = idx[i];
    const o: Record<string, unknown> = {};
    for (const c of cols) o[c.name] = rawValue(c, r);
    parts.push('  ' + JSON.stringify(o));
  }
  return parts.length ? `[\n${parts.join(',\n')}\n]\n` : '[]\n';
}

/** File-name friendly base name: "Sales orders.csv" -> "sales-orders". */
export function baseName(name: string) {
  return (
    name
      .replace(/\.[a-z0-9]{1,8}$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'data'
  );
}
