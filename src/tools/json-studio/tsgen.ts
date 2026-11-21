// JSON → TypeScript declarations. Infers one merged "shape" per position (array elements are
// merged together), marks fields optional when some objects lack them, builds unions, names
// nested interfaces after their keys (singular for array items) and reuses identical shapes.

export interface TsOptions {
  rootName?: string;
  style?: 'interface' | 'type';
  readonly?: boolean;
}

type Prim = 'string' | 'number' | 'boolean' | 'null';
interface ObjShape {
  fields: Map<string, Shape>;
  counts: Map<string, number>;
  total: number;
}
interface Shape {
  prims: Set<Prim>;
  obj: ObjShape | null;
  arr: Shape | null; // merged element shape (present when some value was an array)
}

const emptyShape = (): Shape => ({ prims: new Set(), obj: null, arr: null });

function addValue(s: Shape, v: unknown) {
  if (v === null) s.prims.add('null');
  else if (Array.isArray(v)) {
    s.arr ??= emptyShape();
    for (const e of v) addValue(s.arr, e);
  } else if (typeof v === 'object') {
    const o = (s.obj ??= { fields: new Map(), counts: new Map(), total: 0 });
    o.total++;
    for (const k of Object.keys(v as object)) {
      let f = o.fields.get(k);
      if (!f) {
        f = emptyShape();
        o.fields.set(k, f);
        o.counts.set(k, 0);
      }
      o.counts.set(k, o.counts.get(k)! + 1);
      addValue(f, (v as Record<string, unknown>)[k]);
    }
  } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') s.prims.add(typeof v as Prim);
}

const PRIM_ORDER: Prim[] = ['string', 'number', 'boolean', 'null'];
const RESERVED = ['String', 'Number', 'Boolean', 'Object', 'Array', 'Date', 'Record', 'Map', 'Set', 'Promise', 'Error', 'Function', 'Symbol', 'RegExp', 'JSON', 'Math', 'Partial', 'Readonly', 'Required', 'Pick', 'Omit'];

export function pascalCase(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let s = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  if (!s) s = 'Item';
  if (/^\d/.test(s)) s = 'T' + s;
  return s;
}

export function singular(name: string) {
  let s = name;
  if (/[^aeiou]ies$/i.test(s)) s = s.slice(0, -3) + 'y';
  else if (/(ss|sh|ch|x|z)es$/i.test(s)) s = s.slice(0, -2);
  else if (/[^s]s$/i.test(s) && !/(us|is)$/i.test(s)) s = s.slice(0, -1);
  return s === name || !s ? name + 'Item' : s;
}

const propName = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

export function generateTypeScript(value: unknown, opts: TsOptions = {}): string {
  const style = opts.style ?? 'interface';
  const ro = opts.readonly ? 'readonly ' : '';
  const rootName = pascalCase(opts.rootName?.trim() || 'Root');

  const shape = emptyShape();
  addValue(shape, value);

  const used = new Set<string>(RESERVED);
  const decls: string[] = [];
  const byBody = new Map<string, string>();

  const reserve = (hint: string, parent: string) => {
    if (!used.has(hint)) return used.add(hint), hint;
    const prefixed = parent && !hint.startsWith(parent) ? parent + hint : hint;
    if (!used.has(prefixed)) return used.add(prefixed), prefixed;
    for (let k = 2; ; k++) if (!used.has(prefixed + k)) return used.add(prefixed + k), prefixed + k;
  };

  const arrayOf = (t: string) => `${ro}${/[\s|]/.test(t) ? `(${t})` : t}[]`;

  const typeStr = (s: Shape, hint: string, parent: string): string => {
    const parts: string[] = [];
    if (s.obj) parts.push(emitObject(s.obj, hint, parent));
    if (s.arr) parts.push(arrayOf(typeStr(s.arr, singular(hint), parent)));
    for (const p of PRIM_ORDER) if (s.prims.has(p)) parts.push(p);
    return parts.length ? parts.join(' | ') : 'unknown';
  };

  const emitObject = (o: ObjShape, hint: string, parent: string, forceName?: string): string => {
    if (!o.fields.size && !forceName) return 'Record<string, unknown>';
    const name = forceName ?? reserve(hint, parent);
    const slot = decls.length;
    decls.push('');
    const lines: string[] = [];
    for (const [k, f] of o.fields) {
      const opt = o.counts.get(k)! < o.total ? '?' : '';
      lines.push(`  ${ro}${propName(k)}${opt}: ${typeStr(f, pascalCase(k), name)};`);
    }
    const body = lines.join('\n');
    const existing = forceName ? undefined : byBody.get(body);
    if (existing) {
      decls.splice(slot, 1);
      used.delete(name);
      return existing;
    }
    byBody.set(body, name);
    const inner = body ? `{\n${body}\n}` : '{}';
    decls[slot] = style === 'interface' ? `export interface ${name} ${inner}` : `export type ${name} = ${inner};`;
    return name;
  };

  used.add(rootName);
  if (shape.obj && !shape.arr && !shape.prims.size) {
    emitObject(shape.obj, rootName, '', rootName);
  } else {
    const slot = decls.length;
    decls.push('');
    const t = typeStr(shape, rootName, '');
    decls[slot] = `export type ${rootName} = ${t};`;
  }
  return decls.join('\n\n') + '\n';
}
