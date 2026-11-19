import { Hono } from "hono";

import { state } from "../../lib/state.js";
import { cacheModels } from "../../services/copilot-models.js";
import { getPlaygroundHtml } from "./page.js";

export const playgroundRoutes = new Hono();

// Public page — no auth required. API calls from the page use Bearer token.
playgroundRoutes.get("/", (c) => {
  return c.html(getPlaygroundHtml());
});

// Full model metadata (with supported_endpoints and capabilities).
// Requires API key (goes through auth middleware like other /v1 endpoints).
playgroundRoutes.get("/api/models", async (c) => {
  if (!state.models) {
    await cacheModels();
  }
  return c.json({
    object: "list",
    data: state.models?.data || [],
  });
});
