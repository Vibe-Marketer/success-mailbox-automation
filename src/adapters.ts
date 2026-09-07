import type { GmailMailbox, Mailbox, MicrosoftMailbox, Provider, SmtpMailbox } from "./types";

export interface BrowserApiRequest { method: "POST"; path: string; body: unknown }
export interface ProviderAdapter<T extends Mailbox = Mailbox> { provider: Provider; buildRequests(mailbox: T, workspaceId: string): BrowserApiRequest[] }

export const gmailAdapter: ProviderAdapter<GmailMailbox> = {
  provider: "gmail",
  buildRequests: (mailbox, workspaceId) => [{ method: "POST", path: "accounts/google", body: { code: mailbox.oauthCode, workspace: workspaceId, isWhitelabelCustomSMTPMail: false } }],
};
export const microsoftAdapter: ProviderAdapter<MicrosoftMailbox> = {
  provider: "microsoft",
  buildRequests: (mailbox, workspaceId) => [{ method: "POST", path: "accounts/microsoft", body: { code: mailbox.oauthCode, workspaceId, isWhitelabelCustomSMTPMail: false } }],
};
export const smtpAdapter: ProviderAdapter<SmtpMailbox> = {
  provider: "smtp",
  buildRequests(mailbox, workspaceId) {
    const body = {
      name: { first: mailbox.firstName, last: mailbox.lastName }, email: mailbox.email,
      ...(mailbox.replyTo ? { replyTo: mailbox.replyTo } : {}), workspaceId, imap: mailbox.imap, smtp: mailbox.smtp,
    };
    return [
      { method: "POST", path: "accounts/test-imap", body: mailbox.imap },
      { method: "POST", path: "accounts/test-smtp", body: mailbox.smtp },
      { method: "POST", path: "accounts/custom-imap-smtp", body },
    ];
  },
};
export const adapters = { gmail: gmailAdapter, microsoft: microsoftAdapter, smtp: smtpAdapter } satisfies Record<Provider, ProviderAdapter<any>>;
export function buildRequests(mailbox: Mailbox, workspaceId: string): BrowserApiRequest[] {
  if (mailbox.provider === "gmail") return gmailAdapter.buildRequests(mailbox, workspaceId);
  if (mailbox.provider === "microsoft") return microsoftAdapter.buildRequests(mailbox, workspaceId);
  return smtpAdapter.buildRequests(mailbox, workspaceId);
}
