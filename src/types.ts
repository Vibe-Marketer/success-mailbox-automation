export const PROVIDERS = ["gmail", "microsoft", "smtp"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface CommonMailbox {
  email: string;
  provider: Provider;
  firstName: string;
  lastName: string;
  replyTo?: string;
}
export interface GmailMailbox extends CommonMailbox { provider: "gmail"; oauthCode: string }
export interface MicrosoftMailbox extends CommonMailbox { provider: "microsoft"; oauthCode: string }
export interface ServerCredentials { username: string; password: string; host: string; port: number }
export interface SmtpMailbox extends CommonMailbox { provider: "smtp"; imap: ServerCredentials; smtp: ServerCredentials }
export type Mailbox = GmailMailbox | MicrosoftMailbox | SmtpMailbox;

export interface WorkflowConfig {
  provider: Provider | "row";
  input: {
    csv: string;
    normalizedBatch: string;
    preflightReport: string;
    approval: string;
    progress: string;
    connectReport: string;
    verification: string;
  };
  batching: { size: number; delayMs: number };
  timeoutMs: number;
  approval: { maxTtlMs: number; clockSkewMs: number };
  resume: boolean;
  errorHandling: { continueOnError: boolean; maxRetries: 0 };
}

export type ProgressStatus = "connected" | "skipped-existing" | "failed";
export interface ProgressEntry { email: string; provider: Provider; status: ProgressStatus }
export interface ProgressFile { batchSha256: string; entries: ProgressEntry[] }
export interface ApprovalArtifact {
  approved: true;
  batchSha256: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
}
