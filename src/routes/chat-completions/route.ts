import { Hono } from "hono";

import { observeModelRequest } from "../../lib/request-observation.js";
import { handleChatCompletion } from "./handler.js";

export const completionRoutes = new Hono();

completionRoutes.post("/", (c) =>
  observeModelRequest(c, "openai", (observation) => handleChatCompletion(c, observation))
);
