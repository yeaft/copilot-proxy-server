import { state } from "../lib/state.js";
import { logger } from "../lib/logger.js";
import { cacheModels } from "./copilot-models.js";

/** Keep provider-specific metadata separate; never cast Loki metadata to Copilot capabilities. */
export async function getModelCatalog(full = false): Promise<Record<string, unknown>[]> {
  const data: Record<string, unknown>[] = [];
  const failures: unknown[] = [];
  let available = 0;
  if (state.copilotEnabled) {
    try {
      if (!state.models) await cacheModels();
      available++;
      for (const model of state.models?.data ?? []) {
        data.push(full ? { ...model } : {
          id: model.id, object: "model", type: "model", created: 0,
          created_at: new Date(0).toISOString(), owned_by: model.vendor, display_name: model.name,
        });
      }
    } catch (error) { failures.push(error); }
  }
  if (state.loki) {
    try {
      const models = await state.loki.getModels();
      available++;
      for (const model of models) {
        data.push({ ...model.metadata, id: `loki/${model.id}`, object: "model", type: "model",
          name: model.name, display_name: model.name, owned_by: "loki", vendor: "loki", provider: "loki",
        });
      }
    } catch (error) { failures.push(error); }
  }
  if (failures.length && !available) throw failures[0];
  if (failures.length) logger.warn("One provider's model catalog is unavailable; returning the other providers.");
  return data;
}
