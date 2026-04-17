import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger as honoLogger } from "hono/logger";

import { state } from "./lib/state.js";
import { cacheModels } from "./services/copilot-models.js";
import { forwardError } from "./lib/error.js";

import { completionRoutes } from "./routes/chat-completions/route.js";
import { messageRoutes } from "./routes/messages/route.js";
import { geminiRoutes } from "./routes/gemini/route.js";
import { dashboardRoutes } from "./routes/dashboard/route.js";
import { responsesRoutes } from "./routes/responses/route.js";
import { playgroundRoutes } from "./routes/playground/route.js";

export const app = new Hono();

app.use(honoLogger());
app.use(cors());

// API Key authentication middleware
// Skips health check endpoint; all other routes require valid API key
app.use("*", async (c, next) => {
  // Skip auth for health check
  if (c.req.path === "/" && c.req.method === "GET") {
    return next();
  }

  // Skip API key auth for dashboard (has its own Basic Auth)
  if (c.req.path.startsWith("/dashboard")) {
    return next();
  }

  // Skip auth for playground HTML page only (not its API subpaths).
  // The page prompts the user for an API key and then calls authenticated endpoints.
  if (c.req.path === "/playground" || c.req.path === "/playground/") {
    return next();
  }

  // If no API key configured, allow all requests
  if (!state.apiKey) {
    return next();
  }

  // Extract key from Authorization header (Bearer xxx) or x-api-key header
  const authHeader = c.req.header("Authorization");
  const xApiKey = c.req.header("x-api-key");

  let providedKey: string | undefined;
  if (authHeader?.startsWith("Bearer ")) {
    providedKey = authHeader.slice(7);
  } else if (xApiKey) {
    providedKey = xApiKey;
  }

  if (!providedKey) {
    return c.json({ error: "Missing API key. Provide via Authorization: Bearer <key> or x-api-key header." }, 401);
  }

  // Constant-time comparison to prevent timing attacks
  if (providedKey.length !== state.apiKey.length) {
    return c.json({ error: "Invalid API key." }, 403);
  }

  const a = Buffer.from(providedKey);
  const b = Buffer.from(state.apiKey);
  if (!timingSafeEqual(a, b)) {
    return c.json({ error: "Invalid API key." }, 403);
  }

  return next();
});

// Health check
app.get("/", (c) =>
  c.json({
    status: "ok",
    service: "CopilotProxyServer",
    version: "1.0.0",
  })
);

// Models endpoint
app.get("/v1/models", async (c) => {
  try {
    if (!state.models) {
      await cacheModels();
    }

    const models = state.models?.data.map((model) => ({
      id: model.id,
      object: "model",
      type: "model",
      created: 0,
      created_at: new Date(0).toISOString(),
      owned_by: model.vendor,
      display_name: model.name,
    }));

    return c.json({
      object: "list",
      data: models,
      has_more: false,
    });
  } catch (error) {
    return await forwardError(c, error);
  }
});

app.get("/models", async (c) => {
  // Redirect to /v1/models handler
  const url = new URL(c.req.url);
  url.pathname = "/v1/models";
  return c.redirect(url.toString(), 301);
});

// OpenAI-compatible endpoints
app.route("/v1/chat/completions", completionRoutes);
app.route("/chat/completions", completionRoutes);

// OpenAI Responses API (for codex models)
app.route("/v1/responses", responsesRoutes);
app.route("/responses", responsesRoutes);

// Anthropic-compatible endpoints
app.route("/v1/messages", messageRoutes);

// Gemini-compatible endpoints
app.route("/", geminiRoutes);

// Dashboard (protected by Basic Auth)
app.route("/dashboard", dashboardRoutes);

// Playground (public HTML, API subpaths require API key)
app.route("/playground", playgroundRoutes);
