import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  // The analytics worker is loaded by URL next to the bundle (src/lib/metrics-query.ts).
  entry: { index: "src/index.ts", "metrics-worker": "src/lib/metrics-worker.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  bundle: true,
  platform: "node",
  // Keep `node:` protocol intact because `node:sqlite` cannot be imported without `node:`.
  removeNodeProtocol: false,
  noExternal: [/.*/],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  // The dashboard UI is served from files next to the bundle (src/routes/dashboard/assets.ts).
  async onSuccess() {
    cpSync("src/routes/dashboard/assets", "dist/assets", { recursive: true });
  },
});
