import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { isSignature, qrPng, signaturePng, signatureSchema } from "../src/signature.js";

describe("signature", () => {
  const strokes = { aspect: 3, strokes: [[[0.1, 0.5], [0.2, 0.3], [0.3, 0.6], [0.4, 0.4]], [[0.5, 0.5], [0.6, 0.2], [0.7, 0.7], [0.8, 0.5]], [[0.9, 0.9]]] };

  it("draws the strokes into a PNG with the pad's proportions", async () => {
    const parsed = signatureSchema.parse(strokes);
    expect(isSignature(parsed)).toBe(true);
    const png = await signaturePng(parsed);
    expect(await sharp(png).metadata()).toMatchObject({ format: "png", width: 600, height: 200 });
  });

  it("rejects points outside the pad and a couple of taps", () => {
    expect(signatureSchema.safeParse({ aspect: 3, strokes: [[[1.5, 0]]] }).success).toBe(false);
    expect(isSignature({ aspect: 3, strokes: [[[0.1, 0.1]], [[0.2, 0.2]]] })).toBe(false);
  });
});

describe("qrPng", () => {
  it("makes a square PNG", async () => {
    const png = await qrPng("https://brygadzista.smieci.online/p/abc");
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(meta.height);
  });
});
