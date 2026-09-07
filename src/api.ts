import { buildRequests } from "./adapters";
import type { Mailbox } from "./types";

const API_BASE_URL = "https://api.success.ai/api";
export interface SuccessAccount { email: string }

export class SuccessBrowserApi {
  constructor(
    private readonly sessionToken: string,
    private readonly workspaceId: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {
    if (!sessionToken) throw new Error("SUCCESS_AI_SESSION_TOKEN is required for live API access");
    if (!workspaceId) throw new Error("SUCCESS_AI_WORKSPACE_ID is required for live API access");
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const endpoint = path.split("?", 1)[0]!;
    let response: Response;
    try {
      response = await this.fetcher(`${API_BASE_URL}/${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", authorization: `Bearer ${this.sessionToken}`, ...init.headers },
      });
    } catch (error) {
      const reason = error instanceof Error ? sanitizeProviderError(error.message) : undefined;
      throw new Error(`Success.ai private endpoint ${endpoint} request failed${reason ? `: ${reason}` : ""}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const reason = extractProviderError(text, response.headers.get("content-type"));
      throw new Error(`Success.ai private endpoint ${endpoint} failed (HTTP ${response.status})${reason ? `: ${reason}` : ""}`);
    }
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { throw new Error(`Success.ai private endpoint ${endpoint} returned invalid JSON`); }
  }

  async listAccounts(): Promise<SuccessAccount[]> {
    const limit = 50;
    let offset = 0, total: number | undefined;
    const accounts: SuccessAccount[] = [];
    while (total === undefined || accounts.length < total) {
      const query = new URLSearchParams({ workspaceId: this.workspaceId, offset: String(offset), limit: String(limit) });
      const page = parseAccountPage(await this.request(`accounts/me?${query}`), offset, limit);
      if (total === undefined) total = page.total;
      else if (page.total !== total) throw new Error("Success.ai account inventory total changed during pagination");
      if (accounts.length + page.accounts.length > total) throw new Error("Success.ai account inventory exceeded its declared total");
      accounts.push(...page.accounts);
      if (accounts.length < total && page.accounts.length !== limit) throw new Error("Success.ai account inventory returned an incomplete page");
      offset += page.accounts.length;
    }
    if (new Set(accounts.map(({ email }) => email)).size !== accounts.length) throw new Error("Success.ai account inventory contains duplicate emails");
    return accounts;
  }

  async connect(mailbox: Mailbox): Promise<void> {
    for (const request of buildRequests(mailbox, this.workspaceId)) {
      await this.request(request.path, { method: request.method, body: JSON.stringify(request.body) });
    }
  }
}

function integerField(value: unknown): number | undefined {
  if (Number.isInteger(value) && (value as number) >= 0) return value as number;
  if (typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  return undefined;
}

function parseAccountPage(payload: unknown, expectedOffset: number, expectedLimit: number): { accounts: SuccessAccount[]; total: number } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Unrecognized Success.ai account inventory response shape");
  const value = payload as { docs?: unknown; total?: unknown; limit?: unknown; offset?: unknown };
  if (!Array.isArray(value.docs)) throw new Error("Unrecognized Success.ai account inventory response shape");
  if (!Number.isInteger(value.total) || (value.total as number) < 0) throw new Error("Success.ai account inventory has invalid total");
  if (integerField(value.limit) !== expectedLimit) throw new Error("Success.ai account inventory returned an unexpected limit");
  if (integerField(value.offset) !== expectedOffset) throw new Error("Success.ai account inventory returned an unexpected offset");
  if (value.docs.length > expectedLimit) throw new Error("Success.ai account inventory page exceeds its limit");
  const accounts = value.docs.map((row) => {
    if (!row || typeof row !== "object") throw new Error("Success.ai account inventory contains an invalid account row");
    const email = (row as { email?: unknown }).email;
    if (typeof email !== "string" || !email.trim()) throw new Error("Success.ai account inventory contains an account without email");
    return { email: email.trim().toLowerCase() };
  });
  return { accounts, total: value.total as number };
}

function extractProviderError(text: string, contentType: string | null): string | undefined {
  if (!text || (!contentType?.includes("json") && !text.trimStart().startsWith("{"))) return undefined;
  try {
    const payload = JSON.parse(text) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const root = payload as Record<string, unknown>;
    const error = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : undefined;
    const data = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Record<string, unknown> : undefined;
    const message = [root.message, typeof root.error === "string" ? root.error : undefined, error?.message, data?.message]
      .find((item): item is string => typeof item === "string" && item.trim().length > 0);
    return message ? sanitizeProviderError(message) : undefined;
  } catch { return undefined; }
}

function sanitizeProviderError(message: string): string | undefined {
  const value = message
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(password|pass|token|api[_-]?key|authorization|code)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\s{2,}/g, " ").trim().slice(0, 240);
  return value || undefined;
}
