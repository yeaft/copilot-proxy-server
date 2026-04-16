import { Hono } from "hono";

import { forwardError } from "../../lib/error.js";
import { handleResponses } from "./handler.js";

export const responsesRoutes = new Hono();

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c);
  } catch (error) {
    return await forwardError(c, error);
  }
});
