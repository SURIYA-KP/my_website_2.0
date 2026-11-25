import { debounce, escapeHtml, toast } from '../../../lib/ui';
import { $, bytesToBase64, base64ToBytes, hexToBytes, enc, utf8OrNull, highlightJson, setStatus, relativeTime } from '../util';

const b64url = (b: Uint8Array) => bytesToBase64(b, true, false);
const jsonPart = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

// ---------------------------------------------------------------- signing / verifying
const HS: Record<string, string> = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' };

export async function signHS(alg: string, headerB64: string, payloadB64: string, secret: Uint8Array) {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: HS[alg] }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${headerB64}.${payloadB64}`));
  return b64url(new Uint8Array(sig));
}

interface PkAlg {
  import: RsaHashedImportParams | EcKeyImportParams;
  verify: AlgorithmIdentifier | RsaPssParams | EcdsaParams;
}
function pkAlgorithm(alg: string): PkAlg | null {
  const bits = alg.slice(2);
  const hash = `SHA-${bits}`;
  if (/^RS(256|384|512)$/.test(alg)) return { import: { name: 'RSASSA-PKCS1-v1_5', hash }, verify: 'RSASSA-PKCS1-v1_5' };
  if (/^PS(256|384|512)$/.test(alg)) return { import: { name: 'RSA-PSS', hash }, verify: { name: 'RSA-PSS', saltLength: Number(bits) / 8 } };
  if (/^ES(256|384|512)$/.test(alg)) {
    const curve = bits === '512' ? 'P-521' : `P-${bits}`;
    return { import: { name: 'ECDSA', namedCurve: curve }, verify: { name: 'ECDSA', hash } };
  }
  return null;
}

// Minimal DER helpers to wrap a PKCS#1 "BEGIN RSA PUBLIC KEY" into SPKI.
function derLen(n: number) {
  if (n < 128) return [n];
  const out: number[] = [];
  while (n) {
    out.unshift(n & 255);
    n >>= 8;
  }
  return [0x80 | out.length, ...out];
}
const der = (tag: number, body: Uint8Array) => new Uint8Array([tag, ...derLen(body.length), ...body]);
function pkcs1ToSpki(pkcs1: Uint8Array) {
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const bitStr = der(0x03, new Uint8Array([0, ...pkcs1]));
  return der(0x30, new Uint8Array([...algId, ...bitStr]));
}

async function importPublicKey(text: string, a: PkAlg): Promise<CryptoKey> {
  const t = text.trim();
  if (t.startsWith('{')) {
    let jwk: JsonWebKey;
    try {
      jwk = JSON.parse(t);
    } catch {
      throw new Error('The key looks like JSON but does not parse.');
    }
    if ((jwk as any).keys) throw new Error('This is a JWK Set. Paste just one key from its "keys" array.');
    return crypto.subtle.importKey('jwk', { ...jwk, alg: undefined, key_ops: undefined, use: undefined } as JsonWebKey, a.import, false, ['verify']);
  }
  const m = t.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error('Paste a PEM public key (-----BEGIN PUBLIC KEY-----) or a JWK.');
  if (/PRIVATE/.test(m[1])) throw new Error('That is a private key. Paste the public key instead; never share private keys.');
  if (/CERTIFICATE/.test(m[1])) throw new Error('Certificates are not supported. Extract the public key first, e.g. openssl x509 -pubkey -noout -in cert.pem');
  let der = base64ToBytes(m[2]);
  if (m[1] === 'RSA PUBLIC KEY') der = pkcs1ToSpki(der);
  return crypto.subtle.importKey('spki', der as BufferSource, a.import, false, ['verify']);
}

// ---------------------------------------------------------------- decoding
interface Decoded {
  header: any;
  payload: any;
  payloadText: string;
  parts: string[];
}
function decodeToken(token: string): Decoded {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length === 5) throw new Error('This looks like an encrypted JWE (5 parts). Its payload cannot be read without the decryption key.');
  if (parts.length !== 3) throw new Error(`A JWT has 3 parts separated by dots; this has ${parts.length}.`);
  const part = (i: number, name: string) => {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(parts[i]);
    } catch (e: any) {
      throw new Error(`The ${name} is not valid Base64URL: ${e.message}`);
    }
    const text = utf8OrNull(bytes);
    if (text === null) throw new Error(`The ${name} is not UTF-8 text.`);
    return text;
  };
  const headerText = part(0, 'header');
  let header: any;
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new Error('The header is not valid JSON.');
  }
  const payloadText = part(1, 'payload');
  let payload: any = payloadText;
  try {
    payload = JSON.parse(payloadText);
  } catch {}
  return { header, payload, payloadText, parts };
}

function colorize(parts: string[]) {
  const [h, p, s] = parts.map(escapeHtml);
  return `<span class="dt-jwt-h">${h}</span><span class="dt-jwt-dot">.</span><span class="dt-jwt-p">${p}</span><span class="dt-jwt-dot">.</span><span class="dt-jwt-s">${s}</span>`;
}

export function exampleClaims(now = Math.floor(Date.now() / 1000)) {
  return { sub: '1234567890', name: 'Ada Lovelace', role: 'admin', iat: now, nbf: now, exp: now + 3600 };
}

export async function init() {
  const inp = $<HTMLTextAreaElement>('#jwt-in');
  const colored = $('#jwt-colored');
  const status = $('#jwt-status');
  const headerEl = $('#jwt-header');
  const payloadEl = $('#jwt-payload');
  const claims = $('#jwt-claims');
  const claimsEmpty = $('#jwt-claims-empty');
  const timeBadge = $('#jwt-time-badge');
  const algBadge = $('#jwt-alg');
  const hsBox = $('#jwt-hs');
  const pkBox = $('#jwt-pk');
  const secret = $<HTMLInputElement>('#jwt-secret');
  const secretEnc = $<HTMLSelectElement>('#jwt-secret-enc');
  const keyEl = $<HTMLTextAreaElement>('#jwt-key');
  const verifyEl = $('#jwt-verify');
  let decoded: Decoded | null = null;
  let verifySeq = 0;

  const badge = (cls: string, text: string, note = '') =>
    `<span class="badge ${cls}">${escapeHtml(text)}</span>${note ? `<span class="small muted">${escapeHtml(note)}</span>` : ''}`;

  const verify = async () => {
    const seq = ++verifySeq;
    const set = (html: string) => seq === verifySeq && (verifyEl.innerHTML = html);
    if (!decoded) return set(badge('', 'Not checked'));
    const alg = String(decoded.header.alg ?? '');
    const signingInput = enc.encode(`${decoded.parts[0]}.${decoded.parts[1]}`);
    let sig: Uint8Array;
    try {
      sig = base64ToBytes(decoded.parts[2]);
    } catch {
      return set(badge('badge-danger', 'Invalid signature', 'The signature part is not valid Base64URL.'));
    }
    try {
      if (alg.toLowerCase() === 'none') return set(badge('badge-danger', 'Unsigned token', 'alg "none" means anyone could have written it. Never accept it.'));
      if (HS[alg]) {
        if (!secret.value) return set(badge('', 'Enter the secret to verify'));
        let key: Uint8Array;
        try {
          key = secretEnc.value === 'base64' ? base64ToBytes(secret.value) : secretEnc.value === 'hex' ? hexToBytes(secret.value) : enc.encode(secret.value);
        } catch (e: any) {
          return set(badge('badge-danger', 'Bad secret', e.message));
        }
        if (!key.length) return set(badge('', 'Enter the secret to verify'));
        const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: HS[alg] }, false, ['verify']);
        const ok = await crypto.subtle.verify('HMAC', k, sig as BufferSource, signingInput);
        return set(ok ? badge('badge-success', 'Signature verified', `${alg} with this secret.`) : badge('badge-danger', 'Invalid signature', 'Wrong secret, or the token was changed.'));
      }
      const a = pkAlgorithm(alg);
      if (!a) return set(badge('badge-warning', `Unsupported alg “${alg}”`, 'Supported: HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512.'));
      if (!keyEl.value.trim()) return set(badge('', 'Paste the public key to verify'));
      const key = await importPublicKey(keyEl.value, a);
      const ok = await crypto.subtle.verify(a.verify, key, sig as BufferSource, signingInput);
      set(ok ? badge('badge-success', 'Signature verified', `${alg} with this public key.`) : badge('badge-danger', 'Invalid signature', 'Wrong key, or the token was changed.'));
    } catch (e: any) {
      set(badge('badge-danger', 'Cannot verify', e?.message || 'The key could not be imported for this algorithm.'));
    }
  };
  const verifyLater = debounce(verify, 150);
  // Show "Checking…" right away so a stale result never sits next to new input.
  const verifySoon = () => {
    verifySeq++;
    verifyEl.innerHTML = badge('', 'Checking…');
    verifyLater();
  };

  const renderClaims = () => {
    claims.replaceChildren();
    timeBadge.innerHTML = '';
    const p = decoded?.payload;
    if (!p || typeof p !== 'object') {
      claimsEmpty.hidden = !decoded;
      return;
    }
    const now = Date.now() / 1000;
    const rows: [string, string, number][] = [];
    for (const [k, label] of [['iat', 'Issued at (iat)'], ['nbf', 'Not before (nbf)'], ['exp', 'Expires (exp)']] as const) {
      if (p[k] === undefined) continue;
      rows.push([label, k, Number(p[k])]);
    }
    claimsEmpty.hidden = rows.length > 0;
    for (const [label, k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'dt-kv-row';
      const ok = Number.isFinite(v);
      const d = new Date(v * 1000);
      row.innerHTML = ok && !isNaN(+d)
        ? `<div class="dt-kv-key">${label}</div><div class="dt-kv-val">${escapeHtml(d.toISOString().replace('.000Z', 'Z'))}<span class="dt-kv-sub muted">${escapeHtml(d.toLocaleString('en', { dateStyle: 'medium', timeStyle: 'long' }))} · <strong>${escapeHtml(relativeTime(v * 1000))}</strong> · ${v}</span></div><span></span>`
        : `<div class="dt-kv-key">${label}</div><div class="dt-kv-val"><span class="muted">Not a valid number: ${escapeHtml(String(p[k]))}</span></div><span></span>`;
      row.dataset.claim = k;
      claims.append(row);
    }
    const exp = Number(p.exp);
    const nbf = Number(p.nbf);
    let html: string;
    if (p.exp !== undefined && Number.isFinite(exp) && exp <= now) html = badge('badge-danger', 'Expired');
    else if (p.nbf !== undefined && Number.isFinite(nbf) && nbf > now) html = badge('badge-warning', 'Not yet valid');
    else if (p.exp === undefined) html = badge('badge-warning', 'Valid · never expires');
    else html = badge('badge-success', 'Valid');
    timeBadge.innerHTML = html;
    timeBadge.title = 'Based on exp and nbf compared with this device’s clock. This says nothing about the signature.';
  };

  const decode = () => {
    const t = inp.value.trim();
    decoded = null;
    setStatus(status, null);
    colored.innerHTML = '';
    headerEl.textContent = '';
    payloadEl.textContent = '';
    algBadge.textContent = 'alg: –';
    if (t) {
      try {
        decoded = decodeToken(t);
        colored.innerHTML = colorize(decoded.parts);
        headerEl.innerHTML = highlightJson(decoded.header);
        payloadEl.innerHTML = typeof decoded.payload === 'string' ? escapeHtml(decoded.payload) : highlightJson(decoded.payload);
        if (typeof decoded.payload === 'string') setStatus(status, 'info', 'The payload is not JSON; showing it as text.');
        const alg = String(decoded.header.alg ?? '?');
        algBadge.textContent = `alg: ${alg}`;
        const isHS = !!HS[alg];
        hsBox.hidden = !isHS;
        pkBox.hidden = isHS || alg.toLowerCase() === 'none';
      } catch (e: any) {
        setStatus(status, 'error', e.message);
      }
    }
    renderClaims();
    if (decoded) verifyEl.innerHTML = badge('', 'Checking…');
    verify();
  };
  inp.addEventListener('input', decode);
  secret.addEventListener('input', verifySoon);
  secretEnc.addEventListener('change', verifySoon);
  keyEl.addEventListener('input', verifySoon);

  const example = async () => {
    secret.value = 'dev-toolkit-secret';
    secretEnc.value = 'utf8';
    const h = jsonPart({ alg: 'HS256', typ: 'JWT' });
    const p = jsonPart(exampleClaims());
    inp.value = `${h}.${p}.${await signHS('HS256', h, p, enc.encode(secret.value))}`;
    decode();
  };
  $('#jwt-example').addEventListener('click', example);
  $('#jwt-clear').addEventListener('click', () => {
    inp.value = '';
    decode();
    inp.focus();
  });

  // ---------------------------------------------------------------- create & sign
  const mkAlg = $<HTMLSelectElement>('#jwt-make-alg');
  const mkHeader = $<HTMLTextAreaElement>('#jwt-make-header');
  const mkPayload = $<HTMLTextAreaElement>('#jwt-make-payload');
  const mkSecret = $<HTMLInputElement>('#jwt-make-secret');
  const mkOut = $('#jwt-make-out');
  const mkStatus = $('#jwt-make-status');
  let token = '';
  let signSeq = 0;
  const sign = async () => {
    const seq = ++signSeq;
    let header: any, payload: any;
    try {
      header = JSON.parse(mkHeader.value);
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('must be a JSON object');
    } catch (e: any) {
      token = '';
      mkOut.textContent = '';
      return setStatus(mkStatus, 'error', `Header: ${e.message}`);
    }
    try {
      payload = JSON.parse(mkPayload.value);
    } catch (e: any) {
      token = '';
      mkOut.textContent = '';
      return setStatus(mkStatus, 'error', `Payload: ${e.message}`);
    }
    if (header.alg !== mkAlg.value) {
      // Keep the header's alg in step with the chosen algorithm.
      header = { ...header, alg: mkAlg.value };
      if (document.activeElement !== mkHeader) mkHeader.value = JSON.stringify(header, null, 2);
    }
    setStatus(mkStatus, mkSecret.value ? null : 'warning', mkSecret.value ? '' : 'An empty secret makes the signature worthless. Enter a long random secret.');
    const h = jsonPart(header);
    const p = jsonPart(payload);
    const s = await signHS(mkAlg.value, h, p, enc.encode(mkSecret.value));
    if (seq !== signSeq) return;
    token = `${h}.${p}.${s}`;
    mkOut.innerHTML = colorize([h, p, s]);
  };
  const signSoon = debounce(sign, 100);
  [mkHeader, mkPayload, mkSecret].forEach((el) => el.addEventListener('input', signSoon));
  mkAlg.addEventListener('change', () => {
    try {
      const h = JSON.parse(mkHeader.value);
      mkHeader.value = JSON.stringify({ ...h, alg: mkAlg.value }, null, 2);
    } catch {}
    sign();
  });
  const refreshTimes = () => {
    const now = Math.floor(Date.now() / 1000);
    let p: any;
    try {
      p = JSON.parse(mkPayload.value);
    } catch {
      p = exampleClaims(now);
    }
    if (!p || typeof p !== 'object') p = {};
    p.iat = now;
    p.exp = now + 3600;
    mkPayload.value = JSON.stringify(p, null, 2);
    sign();
  };
  $('#jwt-make-now').addEventListener('click', refreshTimes);
  $('#jwt-make-load').addEventListener('click', () => {
    if (!token) return toast('Fix the errors first', 'error');
    inp.value = token;
    secret.value = mkSecret.value;
    secretEnc.value = 'utf8';
    decode();
    inp.scrollIntoView({ block: 'center', behavior: 'smooth' });
    toast('Loaded into the decoder');
  });
  mkHeader.value = JSON.stringify({ alg: 'HS256', typ: 'JWT' }, null, 2);
  const { sub, name, role, iat, exp } = exampleClaims();
  mkPayload.value = JSON.stringify({ sub, name, role, iat, exp }, null, 2);

  await Promise.all([example(), sign()]);
}
