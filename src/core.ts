import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { PROVIDERS, type ApprovalArtifact, type Mailbox, type Provider, type ServerCredentials, type WorkflowConfig } from "./types";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await Bun.$`mkdir -p ${dirname(path)}`.quiet();
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : { mode, createPath: true });
  if (mode !== undefined) await Bun.$`chmod ${mode.toString(8)} ${path}`.quiet();
}

export function parseCsv(text: string): Record<string, string>[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, quoteClosed = false;
  const pushField = () => { row.push(field); field = ""; quoteClosed = false; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!, next = text[index + 1];
    if (quoted && char === '"' && next === '"') { field += '"'; index += 1; }
    else if (quoted && char === '"') { quoted = false; quoteClosed = true; }
    else if (quoted) field += char;
    else if (char === '"') {
      if (field.length || quoteClosed) throw new Error("CSV contains malformed quote placement");
      quoted = true;
    } else if (quoteClosed && ![",", "\n", "\r"].includes(char)) throw new Error("CSV contains characters after a closing quote");
    else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") { if (char === "\r" && next === "\n") index += 1; pushRow(); }
    else field += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  if (field.length || row.length || quoteClosed) pushRow();
  while (rows.length && rows.at(-1)?.length === 1 && rows.at(-1)?.[0] === "") rows.pop();
  if (!rows.length) return [];
  const headers = rows[0]!.map((value) => value.trim().toLowerCase());
  if (headers.some((value) => !value) || new Set(headers).size !== headers.length) throw new Error("CSV contains invalid headers");
  return rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has ${values.length} columns; expected ${headers.length}`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]!])) as Record<string, string>;
  });
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

function requireFields(row: Record<string, string>, fields: string[], rowNumber: number): void {
  const missing = fields.filter((name) => !row[name]?.trim());
  if (missing.length) throw new Error(`Row ${rowNumber} is missing required fields: ${missing.join(", ")}`);
}

function server(row: Record<string, string>, prefix: "imap" | "smtp", rowNumber: number): ServerCredentials {
  const port = Number(row[`${prefix}_port`]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Row ${rowNumber} has invalid ${prefix}_port`);
  return { username: row[`${prefix}_username`]!, password: row[`${prefix}_password`]!, host: row[`${prefix}_host`]!, port };
}

export function validateBatch(rows: Record<string, string>[], forced: Provider | "row" = "row"): Mailbox[] {
  const mailboxes = rows.map((row, index): Mailbox => {
    const rowNumber = index + 2;
    const provider = forced === "row" ? row.provider?.toLowerCase() : forced;
    if (!isProvider(provider)) throw new Error(`Unsupported provider: ${provider || "(blank)"}`);
    requireFields(row, ["email", "first_name", "last_name"], rowNumber);
    const email = row.email!.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Row ${rowNumber} has invalid email`);
    const common = { email, provider, firstName: row.first_name!.trim(), lastName: row.last_name!.trim(), ...(row.reply_to?.trim() ? { replyTo: row.reply_to.trim().toLowerCase() } : {}) };
    if (provider === "gmail" || provider === "microsoft") {
      requireFields(row, ["oauth_code"], rowNumber);
      return { ...common, provider, oauthCode: row.oauth_code! };
    }
    requireFields(row, ["imap_username", "imap_password", "imap_host", "imap_port", "smtp_username", "smtp_password", "smtp_host", "smtp_port"], rowNumber);
    return { ...common, provider: "smtp", imap: server(row, "imap", rowNumber), smtp: server(row, "smtp", rowNumber) };
  });
  const seen = new Set<string>();
  for (const mailbox of mailboxes) {
    if (seen.has(mailbox.email)) throw new Error(`Duplicate mailbox address: ${mailbox.email}`);
    seen.add(mailbox.email);
  }
  return mailboxes;
}

export async function loadConfig(path = "config/workflow.json"): Promise<WorkflowConfig> {
  const value: unknown = await Bun.file(path).json();
  if (!value || typeof value !== "object") throw new Error("Workflow config must be an object");
  const config = value as WorkflowConfig;
  if (config.provider !== "row" && !isProvider(config.provider)) throw new Error("Unsupported configured provider");
  const paths = config.input;
  if (!paths?.csv || !paths.normalizedBatch || !paths.preflightReport || !paths.approval || !paths.progress || !paths.connectReport || !paths.verification) throw new Error("Workflow config is missing paths");
  if (!Number.isInteger(config.batching?.size) || config.batching.size < 1 || !Number.isInteger(config.batching.delayMs) || config.batching.delayMs < 0) throw new Error("Workflow batching config is invalid");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) throw new Error("Workflow timeout is invalid");
  if (!Number.isInteger(config.approval?.maxTtlMs) || config.approval.maxTtlMs < 1 || !Number.isInteger(config.approval.clockSkewMs) || config.approval.clockSkewMs < 0) throw new Error("Approval policy is invalid");
  if (config.errorHandling?.maxRetries !== 0 || typeof config.errorHandling.continueOnError !== "boolean") throw new Error("Automatic connection retries are not supported");
  return config;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Approval artifact is missing ${field}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Approval artifact has invalid ${field}`);
  return parsed;
}

export function assertLiveGate(apply: boolean, approval: unknown, batchText: string, policy: WorkflowConfig["approval"], now = new Date()): asserts approval is ApprovalArtifact {
  if (!apply) throw new Error("Live connection requires --apply");
  if (!approval || typeof approval !== "object") throw new Error("Live connection requires an approval artifact");
  const candidate = approval as Partial<ApprovalArtifact>;
  if (candidate.approved !== true) throw new Error("Approval artifact is not approved");
  if (typeof candidate.approvedBy !== "string" || !candidate.approvedBy.trim()) throw new Error("Approval artifact is missing approvedBy");
  const approvedAt = timestamp(candidate.approvedAt, "approvedAt"), expiresAt = timestamp(candidate.expiresAt, "expiresAt");
  if (approvedAt > now.getTime() + policy.clockSkewMs) throw new Error("Approval artifact approvedAt is too far in the future");
  if (expiresAt <= approvedAt || expiresAt <= now.getTime()) throw new Error("Approval artifact is expired or has an invalid window");
  if (expiresAt - approvedAt > policy.maxTtlMs) throw new Error("Approval artifact exceeds maximum TTL");
  if (candidate.batchSha256 !== sha256(batchText)) throw new Error("Approval artifact does not match the normalized batch");
}
