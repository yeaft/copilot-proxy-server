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
  // MSAL loads runtime/native broker assets; keep it external in the runner image.
  external: ["@azure/msal-node", "@azure/msal-node-extensions", "proper-lockfile"],
  noExternal: [/^(?!better-sqlite3|sql\.js|@azure\/msal-node|proper-lockfile).*/],
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
});
