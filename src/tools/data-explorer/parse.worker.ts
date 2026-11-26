/// <reference lib="webworker" />
// Parses CSV / delimited text / JSON / NDJSON off the main thread, infers column
// types and posts back column arrays (typed arrays are transferred, not copied).
import Papa from 'papaparse';
import { buildColumn, columnsFromObjects, flatten, uniqueNames } from './infer';
import type { Column, Dataset } from './types';

export interface ParseRequest {
  id: number;
  source: File | string;
  name: string;
  /** 'auto' or a literal delimiter character/string. */
  delimiter: string;
  header: boolean;
  /** 'auto' | 'csv' | 'json' */
  format?: string;
}

export type ParseMessage =
  | { id: number; type: 'progress'; phase: 'read' | 'parse' | 'types'; ratio: number }
  | { id: number; type: 'done'; dataset: Dataset }
  | { id: number; type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const DELIMS = [',', '\t', ';', '|', ':', '^', '~', Papa.RECORD_SEP, Papa.UNIT_SEP];

ctx.onmessage = async (e: MessageEvent<ParseRequest>) => {
  const req = e.data;
  const post = (m: ParseMessage, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);
  try {
    const ds = await parse(req, (phase, ratio) => post({ id: req.id, type: 'progress', phase, ratio }));
    const transfer: Transferable[] = [];
    for (const c of ds.columns) if (!Array.isArray(c.data)) transfer.push(c.data.buffer as ArrayBuffer);
    post({ id: req.id, type: 'done', dataset: ds }, transfer);
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

type Progress = (phase: 'read' | 'parse' | 'types', ratio: number) => void;

async function parse(req: ParseRequest, progress: Progress): Promise<Dataset> {
  const { source, name } = req;
  const bytes = typeof source === 'string' ? new Blob([source]).size : source.size;
  if (bytes === 0) throw new Error('The file is empty.');
  const lower = name.toLowerCase();
  let format = req.format && req.format !== 'auto' ? req.format : '';
  if (!format) {
    if (/\.(json|ndjson|jsonl|geojson)$/.test(lower)) format = 'json';
    else if (/\.(csv|tsv|tab|txt|psv|dat)$/.test(lower)) format = 'csv';
    else {
      const head = typeof source === 'string' ? source.slice(0, 2048) : await source.slice(0, 2048).text();
      format = /^\s*[[{]/.test(head.replace(/^﻿/, '')) ? 'json' : 'csv';
    }
  }
  if (format === 'json') {
    progress('read', 0);
    const text = typeof source === 'string' ? source : await source.text();
    progress('parse', 0.3);
    const rows = parseJson(text);
    progress('types', 0.6);
    const columns = columnsFromObjects(rows, (r) => progress('types', 0.6 + 0.4 * r));
    if (!columns.length) throw new Error('No fields found in the JSON data.');
    return { name, columns, rowCount: rows.length, meta: { format: 'json', bytes, warnings: [] } };
  }
  return parseDelimited(req, bytes, progress);
}

function parseJson(text: string): Record<string, unknown>[] {
  const t = text.replace(/^﻿/, '').trim();
  let data: unknown;
  try {
    data = JSON.parse(t);
  } catch (err) {
    // Not one JSON document: try newline-delimited JSON (unless it clearly is one broken array).
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && !t.startsWith('[') && lines.every((l) => /^\s*[{[]/.test(l))) {
      return lines.map((l, i) => {
        try {
          return flatten(JSON.parse(l));
        } catch {
          throw new Error(`Invalid JSON on line ${i + 1} of NDJSON input: ${l.slice(0, 60)}${l.length > 60 ? '…' : ''}`);
        }
      });
    }
    throw new Error(`This doesn't look like valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(data) && data && typeof data === 'object') {
    // { "rows": [...] } style wrapper: use the first array of objects found.
    const arr = Object.values(data as Record<string, unknown>).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
    data = arr ?? [data];
  }
  if (!Array.isArray(data)) throw new Error('JSON must be an array of objects (or newline-delimited objects).');
  if (data.length && Array.isArray(data[0])) {
    // Array of arrays: first row is the header.
    const [head, ...body] = data as unknown[][];
    const names = uniqueNames(head.map(String));
    return body.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
  }
  return data.map((r) => flatten(r));
}

function parseDelimited(req: ParseRequest, bytes: number, progress: Progress): Promise<Dataset> {
  return new Promise((resolve, reject) => {
    const rows: string[][] = [];
    const warnings: string[] = [];
    let errorCount = 0;
    let delimiter = '';
    const auto = !req.delimiter || req.delimiter === 'auto';
    Papa.LocalChunkSize = 1024 * 1024;
    Papa.parse<string[]>(req.source as File, {
      delimiter: auto ? '' : req.delimiter,
      delimitersToGuess: DELIMS,
      skipEmptyLines: 'greedy',
      chunkSize: 1024 * 1024,
      chunk(res) {
        if (!delimiter) delimiter = res.meta.delimiter;
        for (const r of res.data) rows.push(r);
        for (const err of res.errors) {
          if (err.code === 'UndetectableDelimiter') continue; // single-column data: comma default is fine
          errorCount++;
          if (warnings.length < 5) warnings.push(`Row ${(err.row ?? 0) + 1}: ${err.message}`);
        }
        progress('parse', Math.min(1, (res.meta.cursor || 0) / bytes) * 0.75);
      },
      complete() {
        try {
          if (!rows.length) throw new Error('No rows found.');
          if (errorCount > warnings.length) warnings.push(`…and ${errorCount - warnings.length} more parse warnings`);
          let width = 0;
          for (const r of rows) if (r.length > width) width = r.length;
          const head = req.header ? rows.shift()! : [];
          const rawNames = Array.from({ length: width }, (_, i) => (req.header ? head[i] ?? '' : `Column ${i + 1}`));
          const names = uniqueNames(rawNames);
          const n = rows.length;
          const allowComma = delimiter !== ',';
          let decimalComma = false;
          const columns: Column[] = names.map((nm, c) => {
            const col = buildColumn(nm, n, (r) => rows[r][c], allowComma);
            if (col.decimalComma) decimalComma = true;
            progress('types', 0.75 + (0.25 * (c + 1)) / width);
            return { name: col.name, type: col.type, data: col.data, hasTime: col.hasTime };
          });
          resolve({ name: req.name, columns, rowCount: n, meta: { format: 'csv', delimiter, bytes, warnings, decimalComma } });
        } catch (err) {
          reject(err);
        }
      },
      error(err: Error) {
        reject(err);
      },
    });
  });
}
