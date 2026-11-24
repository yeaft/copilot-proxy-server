import { crc32 } from "node:zlib";

import type { ImagePart } from "../../types/openai.js";

const maxImageBytes = 10 * 1024 * 1024;
const maxBase64Chars = Math.ceil(maxImageBytes / 3) * 4;

/** A fresh validation budget for each translated request, shared across all tool results. */
export function toolImageReader(): (part: unknown) => ImagePart | undefined {
  let remainingBytes = 32 * 1024 * 1024;
  return (part) => {
    if (!part || typeof part !== "object" || !("inlineData" in part)) return;
    const { inlineData } = part;
    if (!inlineData || typeof inlineData !== "object" || !("mimeType" in inlineData) || !("data" in inlineData)) return;
    const { mimeType, data } = inlineData;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/gif" && mimeType !== "image/webp") return;
    if (typeof data !== "string" || !data.length || data.length % 4 !== 0 || data.length > maxBase64Chars) return;

    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const bytes = data.length / 4 * 3 - padding;
    if (bytes > maxImageBytes || bytes > remainingBytes) return;
    // Charge candidates before scanning them, including ones that fail validation.
    remainingBytes -= bytes;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return;
    const tail = data.slice(-4);
    if (Buffer.from(tail, "base64").toString("base64") !== tail) return;

    const image = Buffer.from(data, "base64");
    const valid = mimeType === "image/png" ? isPng(image)
      : mimeType === "image/jpeg" ? isJpeg(image)
      : mimeType === "image/gif" ? isGif(image) : isWebP(image);
    if (valid) return { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } };
  };
}

// Walk container framing only. No decompression, pixel allocation, or network reads.
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const pngDepths = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]], [4, [8, 16]], [6, [8, 16]]]);

function isPng(b: Buffer): boolean {
  if (!b.subarray(0, 8).equals(pngSignature)) return false;
  let imageBytes = 0;
  let sawData = false;
  let endedData = false;
  let palette = false;
  let color = -1;
  for (let p = 8; p + 12 <= b.length;) {
    const size = b.readUInt32BE(p);
    const start = p + 8;
    const end = start + size;
    if (end + 4 > b.length || crc32(b.subarray(p + 4, end)) !== b.readUInt32BE(end)) return false;
    const type = b.toString("latin1", p + 4, start);
    if (p === 8) {
      if (type !== "IHDR" || size !== 13) return false;
      const width = b.readUInt32BE(start);
      const height = b.readUInt32BE(start + 4);
      color = b[start + 9];
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff
        || !pngDepths.get(color)?.includes(b[start + 8]) || b[start + 10] !== 0
        || b[start + 11] !== 0 || b[start + 12] > 1) return false;
    } else if (type === "IDAT") {
      if (endedData || (color === 3 && !palette)) return false;
      sawData = true;
      imageBytes += size;
    } else if (type === "IEND") {
      return size === 0 && imageBytes > 0 && end + 4 === b.length;
    } else if (type === "PLTE") {
      if (sawData || palette || color === 0 || color === 4 || size < 3 || size > 768 || size % 3 !== 0
        || (color === 3 && size / 3 > 2 ** b[24])) return false;
      palette = true;
    } else {
      // Only skip ancillary chunks; unknown critical chunks cannot be interpreted.
      if (!/^[a-z][A-Za-z][A-Z][A-Za-z]$/.test(type)) return false;
      if (sawData) endedData = true;
    }
    p = end + 4;
  }
  return false;
}

const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function isJpeg(b: Buffer): boolean {
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let frameComponents = 0;
  let sawScan = false;
  for (let p = 2; p < b.length;) {
    if (b[p++] !== 0xff) return false;
    while (b[p] === 0xff) p++;
    const marker = b[p++];
    if (marker === 0xd9) return sawScan && p === b.length;
    if (marker < 0xc0 || (marker >= 0xd0 && marker <= 0xd8) || p + 2 > b.length) return false;
    const size = b.readUInt16BE(p);
    const end = p + size;
    if (size < 2 || end > b.length) return false;
    if (jpegFrames.has(marker)) {
      if (frameComponents || size < 11 || !b.readUInt16BE(p + 3) || !b.readUInt16BE(p + 5)) return false;
      frameComponents = b[p + 7];
      if (!frameComponents || size !== 8 + 3 * frameComponents) return false;
    }
    if (marker !== 0xda) {
      p = end;
      continue;
    }
    if (size < 8 || !b[p + 2] || b[p + 2] > frameComponents || size !== 6 + 2 * b[p + 2]) return false;
    p = end;
    let hasEntropy = false;
    // Stuffed FF bytes and restart markers don't end a scan.
    while (p < b.length) {
      const next = b.indexOf(0xff, p);
      if (next < 0) return false;
      if (next > p) hasEntropy = true;
      p = next + 1;
      while (b[p] === 0xff) p++;
      const code = b[p];
      if (code === 0) hasEntropy = true;
      else if (!(code >= 0xd0 && code <= 0xd7)) {
        p = next;
        break;
      }
      p++;
    }
    if (!hasEntropy) return false;
    sawScan = true;
  }
  return false;
}

function gifBlocks(b: Buffer, p: number): number {
  while (p < b.length) {
    const size = b[p++];
    if (size === 0) return p;
    p += size;
  }
  return -1;
}

function isGif(b: Buffer): boolean {
  if (b.length < 13 || !["GIF87a", "GIF89a"].includes(b.toString("latin1", 0, 6))
    || !b.readUInt16LE(6) || !b.readUInt16LE(8)) return false;
  const tableBytes = (flags: number) => flags & 0x80 ? 3 * (2 << (flags & 7)) : 0;
  let sawImage = false;
  for (let p = 13 + tableBytes(b[10]); p < b.length;) {
    const block = b[p++];
    if (block === 0x3b) return sawImage && p === b.length;
    if (block === 0x21) {
      // Extension label, then a size-prefixed block chain.
      p = gifBlocks(b, p + 1);
    } else if (block === 0x2c) {
      if (p + 9 > b.length || !b.readUInt16LE(p + 4) || !b.readUInt16LE(p + 6)) return false;
      const localTable = tableBytes(b[p + 8]);
      if (!localTable && !tableBytes(b[10])) return false;
      p += 9 + localTable;
      if (p + 1 >= b.length || b[p] < 2 || b[p] > 8 || b[p + 1] === 0) return false;
      p = gifBlocks(b, p + 1);
      sawImage = true;
    } else return false;
    if (p < 0) return false;
  }
  return false;
}

function isWebP(b: Buffer): boolean {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP"
    || b.readUInt32LE(4) !== b.length - 8) return false;
  return webpChunks(b, 12, b.length, false);
}

function webpChunks(b: Buffer, p: number, limit: number, frame: boolean): boolean {
  const first = p;
  let extended = false;
  let animated = false;
  let animationHeader = false;
  let image = false;
  while (p < limit) {
    if (p + 8 > limit) return false;
    const type = b.toString("latin1", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    const start = p + 8;
    const end = start + size;
    const next = end + (size & 1);
    if (next > limit || (next !== end && b[end] !== 0)) return false;
    if (type === "VP8X") {
      if (frame || p !== first || size !== 10) return false;
      extended = true;
      animated = (b[start] & 2) !== 0;
    } else if (type === "ANIM") {
      if (!animated || animationHeader || size !== 6) return false;
      animationHeader = true;
    } else if (type === "ANMF") {
      if (!animationHeader || size < 16 || !webpChunks(b, start + 16, end, true)) return false;
      image = true;
    } else if (type === "VP8 " || type === "VP8L") {
      if (image || animated || (!frame && !extended && p !== first)) return false;
      if (type === "VP8 ") {
        if (size <= 10 || (b[start] & 1) || b.readUIntBE(start + 3, 3) !== 0x9d012a
          || !(b.readUInt16LE(start + 6) & 0x3fff) || !(b.readUInt16LE(start + 8) & 0x3fff)
          || (b.readUIntLE(start, 3) >>> 5) > size - 10) return false;
      } else if (size <= 5 || b[start] !== 0x2f || (b[start + 4] >>> 5) !== 0) return false;
      image = true;
    } else if (!extended && !frame) return false;
    p = next;
  }
  return image;
}
