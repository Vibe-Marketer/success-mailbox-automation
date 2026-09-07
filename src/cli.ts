#!/usr/bin/env bun
import { SuccessBrowserApi } from "./api";
import { isProvider, loadConfig } from "./core";
import { connect, prepare, verify } from "./workflow";
import type { Provider } from "./types";

const option = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const positiveInteger = (name: string): number | undefined => {
  const value = option(name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
};

async function main() {
  const config = await loadConfig(option("--config"));
  const command = process.argv[2];
  if (command === "prepare") {
    const raw = option("--provider");
    if (raw !== undefined && raw !== "row" && !isProvider(raw)) throw new Error(`Unsupported provider: ${raw}`);
    const input = option("--input");
    const report = await prepare(config, { ...(input ? { csvPath: input } : {}), ...(raw ? { provider: raw as Provider | "row" } : {}) });
    console.log(`Prepared ${report.total} mailbox rows; no network calls were made.`); return;
  }
  const api = () => new SuccessBrowserApi(process.env.SUCCESS_AI_SESSION_TOKEN ?? "", process.env.SUCCESS_AI_WORKSPACE_ID ?? "", fetch, config.timeoutMs);
  if (command === "connect") {
    const apply = process.argv.includes("--apply"), maxRows = positiveInteger("--max-rows");
    const report = await connect(config, { apply, ...(maxRows ? { maxRows } : {}), ...(apply ? { api: api() } : {}) });
    console.log(report.mode === "dry-run" ? `Dry run: ${report.pending} pending; no network calls were made.` : `Processed ${report.processedThisRun} rows; ${report.remaining} remain.`); return;
  }
  if (command === "verify") {
    const report = await verify(config, await api().listAccounts());
    console.log(`Verified ${report.total}: ${report.present} present, ${report.missing} missing.`); return;
  }
  throw new Error("Usage: bun run cli -- prepare|connect|verify [--provider gmail|microsoft|smtp|row] [--apply] [--max-rows N]");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Unknown error"); process.exitCode = 1; });
