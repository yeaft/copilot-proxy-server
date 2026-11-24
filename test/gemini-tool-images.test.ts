import assert from "node:assert/strict";
import { test } from "node:test";
import { crc32 } from "node:zlib";

import { toolImageReader } from "../src/routes/gemini/tool-images.js";

// Small, encoded images (PNG RGB; JPEG baseline; GIF87a; WebP lossy, lossless and animated).
const fixtures = [
  ["png", 8, "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"],
  ["jpeg", 3, "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCLAGVxf//Z"],
  ["gif", 6, "R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7"],
  ["webp", 12, "UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="],
  ["webp", 12, "UklGRhwAAABXRUJQVlA4TA8AAAAvAUAAAAcQ/Y/+ByKi/wEA"],
  ["webp", 12, "UklGRsQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GSgAAAAAAAAAAAAEAAAEAAGQAAAJWUDggMgAAADABAJ0BKgIAAgABQCYloAADcAD+8ut///mwP/bz/wR6Af//0uD//pcH//S4P/SkAAAAQU5NRkYAAAAAAAAAAAABAAABAABkAAAAVlA4IC4AAAA0AQCdASoCAAIAAAAmJaAAA3AA/vtV4///S4P/+lwf/9Lg/9Lg//rV5Vesq6AA"],
] as const;

for (const [index, [format, signatureBytes, data]] of fixtures.entries()) {
  test(`tool image container ${format} #${index + 1} rejects every proper prefix and trailing bytes`, () => {
    const read = toolImageReader();
    const mimeType = `image/${format}`;
    const check = (data: string) => read({ inlineData: { mimeType, data } });
    assert.deepEqual(check(data), { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
    const bytes = Buffer.from(data, "base64");
    assert.equal(check(bytes.subarray(0, signatureBytes).toString("base64")), undefined, "signature only");
    for (let end = signatureBytes + 1; end < bytes.length; end++) {
      assert.equal(check(bytes.subarray(0, end).toString("base64")), undefined, `truncated at byte ${end}`);
    }
    assert.equal(check(Buffer.concat([bytes, Buffer.of(0)]).toString("base64")), undefined, "trailing byte");
  });
}

test("tool image PNG rejects corrupt chunks and enforces the per-image and request byte budgets", () => {
  const png = Buffer.from(fixtures[0][2], "base64");
  const part = (bytes: Buffer) => ({ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } });
  const corrupt = Buffer.from(png);
  corrupt[29] ^= 1; // IHDR CRC
  assert.equal(toolImageReader()(part(corrupt)), undefined);

  function paddedPng(size: number) {
    // An ignorable private ancillary chunk before IDAT. No large pixel payload is needed.
    const chunk = Buffer.alloc(size - png.length);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write("vpAg", 4);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    return part(Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]));
  }
  const mib = 1024 * 1024;
  const read = toolImageReader();
  const tenMiB = paddedPng(10 * mib);
  assert.equal(read(paddedPng(10 * mib + 1)), undefined);
  assert.ok(read(tenMiB));
  assert.ok(read(tenMiB));
  const invalid = { inlineData: { mimeType: "image/png", data: "A".repeat(tenMiB.inlineData.data.length - 4) + "AA==" } };
  assert.equal(read(invalid), undefined); // The invalid candidate still spends 10 MiB.
  assert.equal(read(tenMiB), undefined);
  assert.ok(read(paddedPng(2 * mib)));
  assert.equal(read(part(png)), undefined);
  assert.ok(toolImageReader()(part(png)));
});
