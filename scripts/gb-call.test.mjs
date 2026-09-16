import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("gb-call", import.meta.url));

function runAppOrigin({ env = {}, config = "" } = {}) {
  const home = mkdtempSync(join(tmpdir(), "gb-call-test-"));
  try {
    if (config) {
      const configPath = join(home, ".config", "growthbook", ".env");
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, config);
    }

    const childEnv = { ...process.env, HOME: home };
    delete childEnv.GB_API_KEY;
    delete childEnv.GB_API_URL;
    delete childEnv.GB_APP_URL;
    Object.assign(childEnv, env);

    return spawnSync(process.execPath, [script, "app-origin"], {
      encoding: "utf8",
      env: childEnv,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("app-origin returns the cloud default without an API key", () => {
  const result = runAppOrigin();
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "https://app.growthbook.io");
});

test("app-origin recognizes the cloud API with an explicit default port", () => {
  const result = runAppOrigin({
    env: { GB_API_URL: "https://api.growthbook.io:443" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "https://app.growthbook.io");
});

test("app-origin returns a normalized configured origin", () => {
  const result = runAppOrigin({
    env: { GB_APP_URL: "https://growthbook.internal/" },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "https://growthbook.internal");
});

test("environment configuration takes precedence over the config file", () => {
  const result = runAppOrigin({
    env: { GB_APP_URL: "https://env.example" },
    config: "GB_APP_URL=https://file.example\n",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "https://env.example");
});

test("app-origin reads the config file", () => {
  const result = runAppOrigin({
    config:
      "GB_API_URL=https://api.internal\nGB_APP_URL=https://app.internal\n",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "https://app.internal");
});

test("a self-hosted API requires an explicit app origin", () => {
  const result = runAppOrigin({
    env: { GB_API_URL: "https://api.internal" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /GB_APP_URL is required/);
  assert.match(result.stderr, /gb-setup/);
});

for (const appUrl of [
  "http://growthbook.internal",
  "https://growthbook.internal/app",
  "https://growthbook.internal?org=acme",
  "https://growthbook.internal#settings",
  "https://user:password@growthbook.internal",
  "not-a-url",
]) {
  test(`app-origin rejects malformed GB_APP_URL: ${appUrl}`, () => {
    const result = runAppOrigin({ env: { GB_APP_URL: appUrl } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /valid HTTPS origin/);
  });
}
