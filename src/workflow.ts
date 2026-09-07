import type { SuccessAccount, SuccessBrowserApi } from "./api";
import { assertLiveGate, isProvider, parseCsv, sha256, validateBatch, writeJson } from "./core";
import type { Mailbox, ProgressEntry, ProgressFile, ProgressStatus, Provider, WorkflowConfig } from "./types";

export async function prepare(config: WorkflowConfig, options: { csvPath?: string; provider?: Provider | "row" } = {}) {
  const mailboxes = validateBatch(parseCsv(await Bun.file(options.csvPath ?? config.input.csv).text()), options.provider ?? config.provider);
  await writeJson(config.input.normalizedBatch, mailboxes, 0o600);
  const batchText = await Bun.file(config.input.normalizedBatch).text();
  const report = {
    status: "ready-for-approval", total: mailboxes.length, batchSha256: sha256(batchText),
    mailboxes: mailboxes.map(({ email, provider }) => ({ email, provider, status: "valid" })),
  } as const;
  await writeJson(config.input.preflightReport, report);
  return report;
}

const statuses = new Set<ProgressStatus>(["connected", "skipped-existing", "failed"]);
const progressKey = (entry: Pick<ProgressEntry, "email" | "provider">) => `${entry.email.toLowerCase()}\u0000${entry.provider}`;

async function readProgress(path: string, batchSha256: string): Promise<ProgressFile> {
  if (!(await Bun.file(path).exists())) return { batchSha256, entries: [] };
  const value: unknown = await Bun.file(path).json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Progress file has invalid schema");
  const candidate = value as { batchSha256?: unknown; entries?: unknown };
  if (candidate.batchSha256 !== batchSha256) throw new Error("Progress file belongs to a different normalized batch");
  if (!Array.isArray(candidate.entries)) throw new Error("Progress file has invalid entries");
  const entries: ProgressEntry[] = [], keys = new Set<string>();
  for (const raw of candidate.entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Progress entry has invalid schema");
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "email,provider,status") throw new Error("Progress entry contains unsupported fields");
    if (typeof record.email !== "string" || !record.email || !isProvider(record.provider) || !statuses.has(record.status as ProgressStatus)) throw new Error("Progress entry has invalid values");
    const entry = { email: record.email.toLowerCase(), provider: record.provider, status: record.status as ProgressStatus };
    const key = progressKey(entry);
    if (keys.has(key)) throw new Error("Progress file contains duplicate email/provider entries");
    keys.add(key); entries.push(entry);
  }
  return { batchSha256, entries };
}

function applyReport(progress: ProgressEntry[]) {
  return {
    mode: "apply" as const, total: progress.length,
    connected: progress.filter(({ status }) => status === "connected").length,
    skippedExisting: progress.filter(({ status }) => status === "skipped-existing").length,
    failed: progress.filter(({ status }) => status === "failed").length,
    results: progress,
  };
}

export async function connect(
  config: WorkflowConfig,
  options: { apply: boolean; maxRows?: number; api?: Pick<SuccessBrowserApi, "listAccounts" | "connect">; delay?: (ms: number) => Promise<void> },
) {
  if (options.maxRows !== undefined && (!Number.isInteger(options.maxRows) || options.maxRows < 1)) throw new Error("--max-rows must be a positive integer");
  const batchText = await Bun.file(config.input.normalizedBatch).text(), batchSha256 = sha256(batchText);
  const mailboxes = JSON.parse(batchText) as Mailbox[];
  const progressFile = config.resume ? await readProgress(config.input.progress, batchSha256) : { batchSha256, entries: [] };
  const progress = progressFile.entries;
  const completed = new Set(progress.filter(({ status }) => status === "connected" || status === "skipped-existing").map(progressKey));
  if (!options.apply) {
    const report = {
      mode: "dry-run" as const, mutations: 0, total: mailboxes.length,
      pending: mailboxes.filter((mailbox) => !completed.has(progressKey(mailbox))).length,
      mailboxes: mailboxes.map(({ email, provider }) => ({ email, provider, status: completed.has(progressKey({ email, provider })) ? "already-complete" : "would-check-and-connect" })),
    };
    await writeJson(config.input.connectReport, report);
    return report;
  }
  const approval: unknown = await Bun.file(config.input.approval).json();
  assertLiveGate(true, approval, batchText, config.approval);
  if (!options.api) throw new Error("Live connection requires an API client");
  const inventory = new Set((await options.api.listAccounts()).map(({ email }) => email.toLowerCase()));
  const save = async (entry: ProgressEntry) => {
    const index = progress.findIndex((current) => progressKey(current) === progressKey(entry));
    if (index >= 0) progress[index] = entry; else progress.push(entry);
    await writeJson(config.input.progress, progressFile);
  };
  let processedThisRun = 0;
  for (const mailbox of mailboxes) {
    if (completed.has(progressKey(mailbox))) continue;
    if (options.maxRows !== undefined && processedThisRun >= options.maxRows) break;
    let entry: ProgressEntry;
    if (inventory.has(mailbox.email)) entry = { email: mailbox.email, provider: mailbox.provider, status: "skipped-existing" };
    else {
      try { await options.api.connect(mailbox); entry = { email: mailbox.email, provider: mailbox.provider, status: "connected" }; }
      catch (error) {
        entry = { email: mailbox.email, provider: mailbox.provider, status: "failed" };
        console.error(`${mailbox.email} (${mailbox.provider}): ${error instanceof Error ? error.message : "connection failed"}`);
        if (!config.errorHandling.continueOnError) { await save(entry); await writeJson(config.input.connectReport, applyReport(progress)); throw new Error(`Connection stopped after failure for ${mailbox.email}`); }
      }
    }
    await save(entry); processedThisRun += 1;
    if (processedThisRun % config.batching.size === 0 && config.batching.delayMs > 0) await (options.delay ?? Bun.sleep)(config.batching.delayMs);
  }
  const completeNow = new Set(progress.filter(({ status }) => status === "connected" || status === "skipped-existing").map(progressKey));
  const report = { ...applyReport(progress), processedThisRun, remaining: mailboxes.filter((mailbox) => !completeNow.has(progressKey(mailbox))).length };
  await writeJson(config.input.connectReport, report);
  return report;
}

export async function verify(config: WorkflowConfig, inventory: SuccessAccount[]) {
  const batchText = await Bun.file(config.input.normalizedBatch).text();
  const approval: unknown = await Bun.file(config.input.approval).json();
  assertLiveGate(true, approval, batchText, config.approval);
  const existing = new Set(inventory.map(({ email }) => email.toLowerCase()));
  const results = (JSON.parse(batchText) as Mailbox[]).map(({ email, provider }) => ({ email, provider, status: existing.has(email) ? "present" : "missing" }));
  const report = { total: results.length, present: results.filter(({ status }) => status === "present").length, missing: results.filter(({ status }) => status === "missing").length, results };
  await writeJson(config.input.verification, report);
  return report;
}
