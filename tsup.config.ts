import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
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
});
