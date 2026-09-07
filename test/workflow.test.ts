import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters, buildRequests } from "../src/adapters";
import { SuccessBrowserApi } from "../src/api";
import { assertLiveGate, loadConfig, parseCsv, sha256, validateBatch } from "../src/core";
import type { Mailbox, WorkflowConfig } from "../src/types";
import { connect, prepare, verify } from "../src/workflow";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function fixture(): Promise<WorkflowConfig> {
  const dir = await mkdtemp(join(tmpdir(), "success-mailbox-public-test-")); dirs.push(dir);
  return {
    provider: "row",
    input: {
      csv: join(dir, "input.csv"), normalizedBatch: join(dir, "private", "batch.json"),
      preflightReport: join(dir, "preflight.json"), approval: join(dir, "approval.json"),
      progress: join(dir, "progress.json"), connectReport: join(dir, "connect.json"), verification: join(dir, "verify.json"),
    },
    batching: { size: 25, delayMs: 0 }, timeoutMs: 1000,
    approval: { maxTtlMs: 3_600_000, clockSkewMs: 300_000 }, resume: true,
    errorHandling: { continueOnError: true, maxRetries: 0 },
  };
}

const gmail: Mailbox = { provider: "gmail", email: "g@example.com", firstName: "G", lastName: "Mail", oauthCode: "oauth-secret" };
const microsoft: Mailbox = { provider: "microsoft", email: "m@example.com", firstName: "M", lastName: "Soft", oauthCode: "oauth-secret" };
const smtp: Mailbox = {
  provider: "smtp", email: "s@example.com", firstName: "S", lastName: "Mtp",
  imap: { username: "s@example.com", password: "imap-secret", host: "imap.example.com", port: 993 },
  smtp: { username: "s@example.com", password: "smtp-secret", host: "smtp.example.com", port: 587 },
};
const approval = (batchText: string) => ({
  approved: true, batchSha256: sha256(batchText), approvedBy: "test-operator",
  approvedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
});

describe("provider input", () => {
  test("strictly parses CSV while preserving secret whitespace", () => {
    const rows = parseCsv('\ufeffprovider,email,secret\r\ngmail,a@example.com,"  one, ""two""  "\r\n');
    expect(rows[0]?.secret).toBe('  one, "two"  ');
    expect(() => parseCsv("a,b\n1\n")).toThrow("columns");
    expect(() => parseCsv('a,b\npre"bad,2\n')).toThrow("quote placement");
  });
  test("rejects unsupported, incomplete, and duplicate rows", () => {
    expect(() => validateBatch([{ provider: "other" }])).toThrow("Unsupported");
    expect(() => validateBatch([{ provider: "gmail", email: "a@example.com", first_name: "A", last_name: "B" }])).toThrow("oauth_code");
    const row = { provider: "gmail", email: "a@example.com", first_name: "A", last_name: "B", oauth_code: "one" };
    expect(() => validateBatch([row, { ...row, email: "A@EXAMPLE.COM" }])).toThrow("Duplicate");
  });
});

describe("provider adapters", () => {
  test("has exactly Gmail, Microsoft, and SMTP", () => {
    expect(Object.keys(adapters).sort()).toEqual(["gmail", "microsoft", "smtp"]);
  });
  test("builds OAuth requests", () => {
    expect(buildRequests(gmail, "workspace")[0]).toEqual({ method: "POST", path: "accounts/google", body: { code: "oauth-secret", workspace: "workspace", isWhitelabelCustomSMTPMail: false } });
    expect(buildRequests(microsoft, "workspace")[0]).toEqual({ method: "POST", path: "accounts/microsoft", body: { code: "oauth-secret", workspaceId: "workspace", isWhitelabelCustomSMTPMail: false } });
  });
  test("tests IMAP and SMTP before custom connection", () => {
    const requests = buildRequests(smtp, "workspace");
    expect(requests.map(({ path }) => path)).toEqual(["accounts/test-imap", "accounts/test-smtp", "accounts/custom-imap-smtp"]);
    expect(requests[0]?.body).toEqual(smtp.imap);
    expect(requests[1]?.body).toEqual(smtp.smtp);
    expect(requests[2]?.body).toMatchObject({ email: smtp.email, workspaceId: "workspace", imap: smtp.imap, smtp: smtp.smtp });
  });
});

describe("fixed API destination and inventory", () => {
  test("always targets HTTPS api.success.ai and paginates", async () => {
    const calls: string[] = [];
    const rows = Array.from({ length: 51 }, (_, index) => ({ email: `mail-${index}@example.com` }));
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)); calls.push(url.href);
      expect(url.origin).toBe("https://api.success.ai");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      expect(init?.redirect).toBe("error");
      const offset = Number(url.searchParams.get("offset"));
      return new Response(JSON.stringify({ docs: rows.slice(offset, offset + 50), total: 51, limit: "50", offset: String(offset) }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await new SuccessBrowserApi("test-token", "workspace", fetcher).listAccounts()).toHaveLength(51);
    expect(calls).toHaveLength(2);
  });
  test("fails closed on incomplete inventory", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ docs: [{ email: "a@example.com" }], total: 2, limit: "50", offset: "0" }), { status: 200 })) as unknown as typeof fetch;
    await expect(new SuccessBrowserApi("token", "workspace", fetcher).listAccounts()).rejects.toThrow("incomplete page");
  });
  test("sanitizes private endpoint errors", async () => {
    const fetcher = mock(async () => new Response(JSON.stringify({ message: "Auth failed for a@example.com password=secret token=secret-token", body: smtp }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    let message = "";
    try { await new SuccessBrowserApi("session-secret", "workspace", fetcher).connect(smtp); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("accounts/test-imap failed (HTTP 400)");
    expect(message).toContain("[redacted-email]");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("session-secret");
    expect(message).not.toContain("imap.example.com");
  });
});

describe("approval-gated workflow", () => {
  test("requires matching, current, short-lived approval", () => {
    const batch = "[]\n", policy = { maxTtlMs: 3_600_000, clockSkewMs: 300_000 };
    expect(() => assertLiveGate(false, approval(batch), batch, policy)).toThrow("--apply");
    expect(() => assertLiveGate(true, { ...approval(batch), batchSha256: "wrong" }, batch, policy)).toThrow("does not match");
  });
  test("prepare protects secrets and dry-run makes zero calls", async () => {
    const config = await fixture();
    await Bun.write(config.input.csv, "provider,email,first_name,last_name,oauth_code,reply_to,imap_username,imap_password,imap_host,imap_port,smtp_username,smtp_password,smtp_host,smtp_port\ngmail,a@example.com,A,One,do-not-leak,,,,,,,,,\n");
    const report = await prepare(config);
    expect(report.total).toBe(1);
    expect((await stat(config.input.normalizedBatch)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(config.input.preflightReport).text()).not.toContain("do-not-leak");
    const listAccounts = mock(async () => []), connectMailbox = mock(async () => undefined);
    const dryRun = await connect(config, { apply: false, api: { listAccounts, connect: connectMailbox } });
    expect(dryRun.mode).toBe("dry-run");
    expect(listAccounts).toHaveBeenCalledTimes(0);
    expect(connectMailbox).toHaveBeenCalledTimes(0);
  });
  test("one-row canary persists progress and resumes", async () => {
    const config = await fixture(), batchText = `${JSON.stringify([gmail, microsoft, smtp], null, 2)}\n`;
    await Bun.write(config.input.normalizedBatch, batchText);
    await Bun.write(config.input.approval, JSON.stringify(approval(batchText)));
    const connectMailbox = mock(async () => undefined), api = { listAccounts: async () => [], connect: connectMailbox };
    const canary = await connect(config, { apply: true, maxRows: 1, api });
    expect(canary).toMatchObject({ processedThisRun: 1, remaining: 2 });
    expect(connectMailbox).toHaveBeenCalledTimes(1);
    const resumed = await connect(config, { apply: true, api });
    expect(resumed).toMatchObject({ processedThisRun: 2, remaining: 0 });
    expect(connectMailbox).toHaveBeenCalledTimes(3);
    const progress = await Bun.file(config.input.progress).text();
    expect(progress).not.toContain("secret");
  });
  test("verification compares approved batch", async () => {
    const config = await fixture(), batchText = `${JSON.stringify([gmail, smtp])}\n`;
    await Bun.write(config.input.normalizedBatch, batchText);
    await Bun.write(config.input.approval, JSON.stringify(approval(batchText)));
    expect(await verify(config, [{ email: gmail.email }])).toMatchObject({ total: 2, present: 1, missing: 1 });
  });
});

test("shipped config and env schema are public-safe", async () => {
  expect((await loadConfig()).errorHandling.maxRetries).toBe(0);
  const keys = (await Bun.file(".env.example").text()).split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => line.split("=")[0]).sort();
  expect(keys).toEqual(["SUCCESS_AI_SESSION_TOKEN", "SUCCESS_AI_WORKSPACE_ID"]);
});
