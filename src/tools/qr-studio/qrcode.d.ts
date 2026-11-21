// Minimal typings for the parts of `qrcode` (no bundled types) used by QR Studio.
declare module 'qrcode' {
  interface Mode {
    id: string;
    bit: number;
    ccBits: number[];
  }
  interface Segment {
    mode: Mode;
    getBitsLength(): number;
  }
  interface QRCodeSymbol {
    modules: { size: number; data: Uint8Array };
    version: number;
    errorCorrectionLevel: { bit: number };
    maskPattern: number;
    segments: Segment[];
  }
  interface CreateOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' | 'low' | 'medium' | 'quartile' | 'high';
    version?: number;
    maskPattern?: number;
  }
  function create(text: string, options?: CreateOptions): QRCodeSymbol;
  const QRCode: { create: typeof create };
  export { create };
  export default QRCode;
}
