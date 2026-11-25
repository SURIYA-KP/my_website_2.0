// Detect a file type from its first bytes ("magic numbers"), with a text fallback.
import { utf8OrNull, isPrintable } from './util';

export interface FileType {
  mime: string;
  ext: string;
  label: string;
  image?: boolean;
}

const at = (b: Uint8Array, off: number, sig: (number | null)[]) => sig.every((v, i) => v === null || b[off + i] === v);
const ascii = (b: Uint8Array, off: number, s: string) => at(b, off, [...s].map((c) => c.charCodeAt(0)));

const SIGS: [(b: Uint8Array) => boolean, FileType][] = [
  [(b) => at(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { mime: 'image/png', ext: 'png', label: 'PNG image', image: true }],
  [(b) => at(b, 0, [0xff, 0xd8, 0xff]), { mime: 'image/jpeg', ext: 'jpg', label: 'JPEG image', image: true }],
  [(b) => ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a'), { mime: 'image/gif', ext: 'gif', label: 'GIF image', image: true }],
  [(b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP'), { mime: 'image/webp', ext: 'webp', label: 'WebP image', image: true }],
  [(b) => ascii(b, 4, 'ftypavif') || ascii(b, 4, 'ftypavis'), { mime: 'image/avif', ext: 'avif', label: 'AVIF image', image: true }],
  [(b) => ascii(b, 4, 'ftypheic') || ascii(b, 4, 'ftypheix') || ascii(b, 4, 'ftypmif1'), { mime: 'image/heic', ext: 'heic', label: 'HEIC image' }],
  [(b) => ascii(b, 0, 'BM') && b.length > 14, { mime: 'image/bmp', ext: 'bmp', label: 'BMP image', image: true }],
  [(b) => at(b, 0, [0x00, 0x00, 0x01, 0x00]) && b.length > 6, { mime: 'image/x-icon', ext: 'ico', label: 'ICO icon', image: true }],
  [(b) => at(b, 0, [0x49, 0x49, 0x2a, 0x00]) || at(b, 0, [0x4d, 0x4d, 0x00, 0x2a]), { mime: 'image/tiff', ext: 'tif', label: 'TIFF image' }],
  [(b) => ascii(b, 0, '%PDF-'), { mime: 'application/pdf', ext: 'pdf', label: 'PDF document' }],
  [(b) => at(b, 0, [0x50, 0x4b, 0x03, 0x04]) || at(b, 0, [0x50, 0x4b, 0x05, 0x06]), { mime: 'application/zip', ext: 'zip', label: 'ZIP archive (also .docx, .xlsx, .jar…)' }],
  [(b) => at(b, 0, [0x1f, 0x8b]), { mime: 'application/gzip', ext: 'gz', label: 'Gzip archive' }],
  [(b) => at(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), { mime: 'application/x-7z-compressed', ext: '7z', label: '7-Zip archive' }],
  [(b) => ascii(b, 0, 'Rar!'), { mime: 'application/vnd.rar', ext: 'rar', label: 'RAR archive' }],
  [(b) => ascii(b, 0, 'BZh'), { mime: 'application/x-bzip2', ext: 'bz2', label: 'Bzip2 archive' }],
  [(b) => at(b, 0, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), { mime: 'application/x-xz', ext: 'xz', label: 'XZ archive' }],
  [(b) => at(b, 0, [0x28, 0xb5, 0x2f, 0xfd]), { mime: 'application/zstd', ext: 'zst', label: 'Zstandard archive' }],
  [(b) => ascii(b, 0, 'ID3') || at(b, 0, [0xff, 0xfb]) || at(b, 0, [0xff, 0xf3]), { mime: 'audio/mpeg', ext: 'mp3', label: 'MP3 audio' }],
  [(b) => ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE'), { mime: 'audio/wav', ext: 'wav', label: 'WAV audio' }],
  [(b) => ascii(b, 0, 'OggS'), { mime: 'audio/ogg', ext: 'ogg', label: 'Ogg media' }],
  [(b) => ascii(b, 0, 'fLaC'), { mime: 'audio/flac', ext: 'flac', label: 'FLAC audio' }],
  [(b) => ascii(b, 4, 'ftyp'), { mime: 'video/mp4', ext: 'mp4', label: 'MP4 / QuickTime media' }],
  [(b) => at(b, 0, [0x1a, 0x45, 0xdf, 0xa3]), { mime: 'video/webm', ext: 'webm', label: 'WebM / Matroska media' }],
  [(b) => ascii(b, 0, 'wOFF'), { mime: 'font/woff', ext: 'woff', label: 'WOFF font' }],
  [(b) => ascii(b, 0, 'wOF2'), { mime: 'font/woff2', ext: 'woff2', label: 'WOFF2 font' }],
  [(b) => at(b, 0, [0x00, 0x01, 0x00, 0x00, 0x00]), { mime: 'font/ttf', ext: 'ttf', label: 'TrueType font' }],
  [(b) => ascii(b, 0, 'OTTO'), { mime: 'font/otf', ext: 'otf', label: 'OpenType font' }],
  [(b) => at(b, 0, [0x00, 0x61, 0x73, 0x6d]), { mime: 'application/wasm', ext: 'wasm', label: 'WebAssembly module' }],
  [(b) => at(b, 0, [0x7f, 0x45, 0x4c, 0x46]), { mime: 'application/x-elf', ext: 'elf', label: 'ELF executable' }],
  [(b) => ascii(b, 0, 'MZ'), { mime: 'application/vnd.microsoft.portable-executable', ext: 'exe', label: 'Windows executable' }],
  [(b) => ascii(b, 0, 'SQLite format 3'), { mime: 'application/vnd.sqlite3', ext: 'sqlite', label: 'SQLite database' }],
];

export const BINARY: FileType = { mime: 'application/octet-stream', ext: 'bin', label: 'Binary data' };

export function detectType(bytes: Uint8Array): FileType {
  for (const [test, type] of SIGS) if (test(bytes)) return type;
  // Text formats: look at the decoded text (only the start for big inputs).
  const head = bytes.subarray(0, 64 * 1024);
  let text = utf8OrNull(head);
  if (text === null && head.length < bytes.length) text = utf8OrNull(head.subarray(0, head.length - 3)); // cut mid-character
  if (text === null || !isPrintable(text.replace(/�/g, ''))) return BINARY;
  const t = text.replace(/^﻿/, '').trimStart();
  if (/^<\?xml[^>]*>\s*(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(t) || /^<svg[\s>]/i.test(t)) return { mime: 'image/svg+xml', ext: 'svg', label: 'SVG image', image: true };
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return { mime: 'text/html', ext: 'html', label: 'HTML document' };
  if (/^<\?xml/i.test(t)) return { mime: 'application/xml', ext: 'xml', label: 'XML document' };
  if (/^[[{]/.test(t) && head.length === bytes.length) {
    try {
      JSON.parse(text);
      return { mime: 'application/json', ext: 'json', label: 'JSON' };
    } catch {}
  }
  if (/^%!PS/.test(t)) return { mime: 'application/postscript', ext: 'ps', label: 'PostScript' };
  return { mime: 'text/plain', ext: 'txt', label: 'Text (UTF-8)' };
}
