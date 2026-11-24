import { Hono } from "hono";

import { forwardError } from "../../lib/error.js";
import { observeModelRequest } from "../../lib/request-observation.js";
import { handleMessagesCompletion, handleCountTokens } from "./handler.js";

export const messageRoutes = new Hono();

messageRoutes.post("/", (c) =>
  observeModelRequest(c, "anthropic", (observation) => handleMessagesCompletion(c, observation))
);

messageRoutes.post("/count_tokens", async (c) => {
  try {
    return await handleCountTokens(c);
  } catch (error) {
    return await forwardError(c, error);
  }
});
