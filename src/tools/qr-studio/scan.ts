// Decoding QR codes from images and the camera. BarcodeDetector when available, jsQR otherwise.
type JsQR = typeof import('jsqr').default;
let jsqrPromise: Promise<JsQR> | null = null;
/** jsQR is only needed when scanning, so it is loaded on first use. */
export function loadJsQR(): Promise<JsQR> {
  jsqrPromise ??= import('jsqr').then((m) => m.default);
  return jsqrPromise;
}

export interface Point {
  x: number;
  y: number;
}
export interface Detection {
  text: string;
  corners: Point[]; // in source pixel coordinates
  engine: 'BarcodeDetector' | 'jsQR';
}

type BD = { detect(src: CanvasImageSource | ImageBitmap): Promise<{ rawValue: string; cornerPoints: Point[] }[]> };
let detectorPromise: Promise<BD | null> | null = null;

/** Native detector if this browser has one that supports QR codes. */
export function getNativeDetector(): Promise<BD | null> {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const Ctor = (window as any).BarcodeDetector;
      if (!Ctor) return null;
      try {
        const formats: string[] = (await Ctor.getSupportedFormats?.()) ?? [];
        if (!formats.includes('qr_code')) return null;
        return new Ctor({ formats: ['qr_code'] }) as BD;
      } catch {
        return null;
      }
    })();
  }
  return detectorPromise;
}

function jsqrDetect(jsQR: JsQR, img: ImageData): Detection | null {
  const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!r || (!r.data && !r.binaryData.length)) return null;
  const l = r.location;
  return { text: r.data, corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner], engine: 'jsQR' };
}

function draw(src: CanvasImageSource, sw: number, sh: number, maxDim: number, pad = 0) {
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const c = document.createElement('canvas');
  c.width = w + pad * 2;
  c.height = h + pad * 2;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  if (pad) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(src, pad, pad, w, h);
  return { data: ctx.getImageData(0, 0, c.width, c.height), scale, pad, canvas: c };
}

/**
 * Decode a still image. Tries the native detector, then jsQR at several scales,
 * and once more with a white border (helps codes cropped without a quiet zone).
 */
export async function decodeImage(src: CanvasImageSource, sw: number, sh: number): Promise<Detection | null> {
  const native = await getNativeDetector();
  if (native) {
    try {
      const found = await native.detect(src);
      if (found.length) return { text: found[0].rawValue, corners: found[0].cornerPoints, engine: 'BarcodeDetector' };
    } catch {
      /* fall back to jsQR */
    }
  }
  const jsQR = await loadJsQR();
  const attempts: [number, number][] = [[1600, 0], [800, 0], [400, 0], [1000, 40], [500, 24]];
  const seen = new Set<string>();
  for (const [maxDim, pad] of attempts) {
    const key = `${Math.min(1, maxDim / Math.max(sw, sh)).toFixed(3)}:${pad}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { data, scale } = draw(src, sw, sh, maxDim, pad);
    const r = jsqrDetect(jsQR, data);
    if (r) {
      r.corners = r.corners.map((p) => ({ x: (p.x - pad) / scale, y: (p.y - pad) / scale }));
      return r;
    }
    await new Promise((res) => setTimeout(res, 0)); // keep the tab responsive between attempts
  }
  return null;
}

/** Load a File/Blob into an <img>. */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This file could not be read as an image.'));
    };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera access was blocked. Allow the camera for this site in your browser’s address bar or settings, then press Start camera again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found on this device. You can still scan a QR code from an image file or by pasting a screenshot.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy or unavailable (another app may be using it). Close other apps using the camera and try again.';
    case 'SecurityError':
      return 'The browser blocked camera access on this page (camera needs HTTPS or localhost).';
    case 'AbortError':
      return 'Starting the camera was interrupted. Please try again.';
    default:
      return `The camera could not be started${(err as Error)?.message ? `: ${(err as Error).message}` : '.'}`;
  }
}

export function cameraSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  torch: boolean;
  stop(): void;
  setTorch(on: boolean): Promise<boolean>;
}

export async function openCamera(deviceId?: string): Promise<CameraHandle> {
  if (!cameraSupported()) {
    const e = new Error('no mediaDevices');
    e.name = window.isSecureContext ? 'NotFoundError' : 'SecurityError';
    throw e;
  }
  const video: MediaTrackConstraints = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
  const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  const track = stream.getVideoTracks()[0];
  const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
  return {
    stream,
    track,
    torch: !!caps.torch,
    stop: () => stream.getTracks().forEach((t) => t.stop()),
    async setTorch(on: boolean) {
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Decode one video frame (downscaled for speed). */
export async function decodeFrame(video: HTMLVideoElement, work: HTMLCanvasElement, native: BD | null): Promise<Detection | null> {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  if (native) {
    try {
      const found = await native.detect(video);
      return found.length ? { text: found[0].rawValue, corners: found[0].cornerPoints, engine: 'BarcodeDetector' } : null;
    } catch {
      /* fall through to jsQR */
    }
  }
  const jsQR = await loadJsQR();
  const scale = Math.min(1, 720 / Math.max(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  if (work.width !== w) work.width = w;
  if (work.height !== h) work.height = h;
  const ctx = work.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, w, h);
  const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
  if (!r) return null;
  const l = r.location;
  return {
    text: r.data,
    corners: [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner].map((p) => ({ x: p.x / scale, y: p.y / scale })),
    engine: 'jsQR',
  };
}
