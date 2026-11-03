import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

function configured(env: Record<string, string | undefined>, args: string[] = []) {
  const previous = { ...process.env };
  const argv = process.argv;
  try {
    for (const key of ["COPILOT_ENABLED", "LOKI_ENABLED", "LOKI_ENVIRONMENT"]) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.argv = ["node", "index.ts", ...args];
    return loadConfig();
  } finally { process.env = previous; process.argv = argv; }
}

test("existing Copilot configuration stays the default", () => {
  const config = configured({});
  assert.equal(config.copilotEnabled, true);
  assert.equal(config.lokiEnabled, false);
  assert.equal(config.lokiEnvironment, "prod");
});

test("Loki-only mode can disable GitHub startup", () => {
  const config = configured({ COPILOT_ENABLED: "false", LOKI_ENABLED: "true", LOKI_ENVIRONMENT: "sdf" });
  assert.equal(config.copilotEnabled, false);
  assert.equal(config.lokiEnabled, true);
  assert.equal(config.lokiEnvironment, "sdf");
});

test("explicit authentication works before provider enablement", () => {
  const config = configured({ COPILOT_ENABLED: "false", LOKI_ENABLED: "false" }, ["--loki-auth", "--device-code"]);
  assert.equal(config.lokiAuthOnly, true);
  assert.equal(config.lokiDeviceCode, true);
  assert.equal(config.authOnly, false);
});

test("invalid provider settings fail early rather than silently selecting Copilot", () => {
  assert.throws(() => configured({ LOKI_ENABLED: "yes" }), /LOKI_ENABLED/);
  assert.throws(() => configured({ COPILOT_ENABLED: "no" }), /COPILOT_ENABLED/);
  assert.throws(() => configured({ LOKI_ENVIRONMENT: "http://attacker" }), /LOKI_ENVIRONMENT/);
  assert.throws(() => configured({ COPILOT_ENABLED: "false" }), /Enable at least one/);
  assert.throws(() => configured({}, ["--auth", "--loki-auth"]), /not both/);
});
