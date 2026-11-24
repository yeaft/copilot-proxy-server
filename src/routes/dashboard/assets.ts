import { readFileSync } from "node:fs";

/**
 * Dashboard UI files (adapted from llm-proxy's dashboard/). In source they sit in
 * ./assets/ next to this module; the build copies them next to the bundle
 * (dist/assets/, see tsup.config.ts), so this relative URL resolves in both layouts.
 * Read once at startup so a missing file fails fast instead of on first visit.
 */
const directory = new URL("./assets/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, directory), "utf8");

export const dashboardAssets = {
  html: read("index.html"),
  script: read("app.js"),
  style: read("style.css"),
} as const;
