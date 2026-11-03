import { Hono } from "hono";
import { HTTPError, forwardError } from "../../lib/error.js";

import { getModelCatalog } from "../../services/model-catalog.js";
import { lokiError } from "../loki.js";
import { getPlaygroundHtml } from "./page.js";

export const playgroundRoutes = new Hono();

// Public page — no auth required. API calls from the page use Bearer token.
playgroundRoutes.get("/", (c) => {
  return c.html(getPlaygroundHtml());
});

// Full model metadata (with supported_endpoints and capabilities).
// Requires API key (goes through auth middleware like other /v1 endpoints).
playgroundRoutes.get("/api/models", async (c) => {
  try {
    return c.json({ object: "list", data: await getModelCatalog(true) });
  } catch (error) {
    return error instanceof HTTPError ? forwardError(c, error) : lokiError(c, error);
  }
});
