import { Hono } from "hono";

import { observeModelRequest } from "../../lib/request-observation.js";
import { handleResponses } from "./handler.js";

export const responsesRoutes = new Hono();

responsesRoutes.post("/", (c) =>
  observeModelRequest(c, "responses", (observation) => handleResponses(c, observation))
);
