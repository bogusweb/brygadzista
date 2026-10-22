import QRCode from "qrcode";
import sharp from "sharp";
import { z } from "zod";

// A signature drawn with a finger in the app (#82) arrives as strokes (points in a 0..1 box with the aspect ratio of
// the pad), never as an image, so the server draws it itself and nothing but lines can end up in the PDF.

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);

export const signatureSchema = z.object({
  aspect: z.number().min(1).max(6),
  strokes: z.array(z.array(point).min(1).max(2000)).min(1).max(100),
});

export type SignatureStrokes = z.infer<typeof signatureSchema>;

const WIDTH = 600;

// A few taps are not a signature.
export const isSignature = ({ strokes }: SignatureStrokes) => strokes.reduce((sum, stroke) => sum + stroke.length, 0) >= 8;

export const signaturePng = ({ aspect, strokes }: SignatureStrokes) => {
  const height = Math.round(WIDTH / aspect);
  const path = strokes
    .map((stroke) => {
      const [first, ...rest] = stroke.map(([x, y]) => `${(x * WIDTH).toFixed(1)} ${(y * height).toFixed(1)}`);
      // A single tap is drawn as a dot.
      return rest.length ? `M ${first} L ${rest.join(" L ")}` : `M ${first} l 0.1 0`;
    })
    .join(" ");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">` +
    `<path d="${path}" fill="none" stroke="#10204A" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};

export const qrPng = (url: string) => QRCode.toBuffer(url, { errorCorrectionLevel: "M", margin: 1, width: 240 });
