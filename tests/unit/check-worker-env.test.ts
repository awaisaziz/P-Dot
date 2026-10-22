import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findBakedSecrets } from "../../scripts/worker-env-rules.mjs";

const SCRIPT = resolve("scripts/check-worker-env.mjs");
const FAKE = "fake-secret-value-123";

describe("findBakedSecrets", () => {
  it("flags every name with a value that is not on the allow list", () => {
    const found = findBakedSecrets({
      production: {
        NEBIUS_API_KEY: "abc",
        TAVILY_API_KEY: "def",
        SUPABASE_SERVICE_ROLE: "s",
        NEXT_PUBLIC_NEBIUS_API_KEY: "p",
        PGPASSWORD: "pg",
        POSTGRES_URL: "postgres://u:p@h/db",
        SOME_NEW_SETTING: "x",
      },
      development: { NEBIUS_API_KEY: "abc" },
    });
    expect(found).toEqual([
      "production.NEBIUS_API_KEY",
      "production.TAVILY_API_KEY",
      "production.SUPABASE_SERVICE_ROLE",
      "production.NEXT_PUBLIC_NEBIUS_API_KEY",
      "production.PGPASSWORD",
      "production.POSTGRES_URL",
      "production.SOME_NEW_SETTING",
      "development.NEBIUS_API_KEY",
    ]);
  });

  it("allows empty values and the allowed settings", () => {
    const found = findBakedSecrets({
      production: {
        NEBIUS_API_KEY: "",
        TAVILY_API_KEY: "   ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        SITE_URL: "https://pdot.iampatelom.com",
        NEBIUS_BASE_URL: "https://api.tokenfactory.nebius.com/v1",
        NEBIUS_MODEL: "nvidia/example",
        NEBIUS_MAX_OUTPUT_TOKENS: "1024",
        CHAT_REQUESTS_PER_WINDOW: "30",
        CHAT_WINDOW_SECONDS: "3600",
        GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
        CONNECTOR_TOKEN_KEY_VERSION: "1",
        CONNECTOR_ALLOWED_USER_IDS: "*",
      },
      test: {},
    });
    expect(found).toEqual([]);
  });

  it("flags the Google client secret and the connector token keys", () => {
    const found = findBakedSecrets({
      production: {
        GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "s",
        CONNECTOR_TOKEN_KEYS: '{"1":"k"}',
        CONNECTOR_TOKEN_KEY: "k",
      },
    });
    expect(found).toEqual([
      "production.GOOGLE_CLIENT_SECRET",
      "production.CONNECTOR_TOKEN_KEYS",
      "production.CONNECTOR_TOKEN_KEY",
    ]);
  });
});

describe("check-worker-env command", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function project(envFile?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "pdot-env-"));
    dirs.push(dir);
    if (envFile !== undefined) {
      mkdirSync(join(dir, ".open-next/cloudflare"), { recursive: true });
      writeFileSync(join(dir, ".open-next/cloudflare/next-env.mjs"), envFile);
    }
    return dir;
  }
  const run = (cwd: string, script = SCRIPT) => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
  const withSecret = `export const production = {"NEBIUS_API_KEY":"${FAKE}"};\nexport const development = {};\nexport const test = {};\n`;

  it("fails and prints the name, not the value", () => {
    const result = run(project(withSecret));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production.NEBIUS_API_KEY");
    expect(result.stdout + result.stderr).not.toContain(FAKE);
  });

  it("fails on database credentials such as PGPASSWORD and POSTGRES_URL", () => {
    const env = `export const production = {"PGPASSWORD":"${FAKE}","POSTGRES_URL":"postgres://u:${FAKE}@h/db"};\nexport const development = {};\nexport const test = {};\n`;
    const result = run(project(env));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production.PGPASSWORD");
    expect(result.stderr).toContain("production.POSTGRES_URL");
    expect(result.stdout + result.stderr).not.toContain(FAKE);
  });

  it("fails on the Google client secret and the connector token keys, without printing them", () => {
    const keys = JSON.stringify({ "1": FAKE });
    const env = `export const production = ${JSON.stringify({
      GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: FAKE,
      CONNECTOR_TOKEN_KEYS: keys,
    })};
export const development = {};
export const test = {};
`;
    const result = run(project(env));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production.GOOGLE_CLIENT_SECRET");
    expect(result.stderr).toContain("production.CONNECTOR_TOKEN_KEYS");
    expect(result.stderr).not.toContain("production.GOOGLE_CLIENT_ID");
    expect(result.stdout + result.stderr).not.toContain(FAKE);
  });

  it("passes with the plain connector settings", () => {
    const env = `export const production = ${JSON.stringify({
      GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
      CONNECTOR_TOKEN_KEY_VERSION: "2",
      CONNECTOR_ALLOWED_USER_IDS: "*",
      GOOGLE_CLIENT_SECRET: "",
      CONNECTOR_TOKEN_KEYS: "",
    })};
export const development = {};
export const test = {};
`;
    expect(run(project(env)).status).toBe(0);
  });

  it("fails when started through a symbolic link", (ctx) => {
    const dir = project(withSecret);
    const link = join(dir, "linked-check.mjs");
    try {
      symlinkSync(SCRIPT, link);
    } catch (error) {
      // Windows needs a privilege to make a symbolic link; the check still runs in CI on Linux.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return ctx.skip();
      throw error;
    }
    expect(run(dir, link).status).toBe(1);
  });

  it("fails when the build output is missing", () => {
    const result = run(project());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Run the OpenNext build first");
  });

  it("passes when no secret has a value", () => {
    const clean = `export const production = {"NEBIUS_API_KEY":"","SITE_URL":"https://pdot.iampatelom.com"};\nexport const development = {};\nexport const test = {};\n`;
    expect(run(project(clean)).status).toBe(0);
  });
});
