# Success mailbox automation

An approval-gated Bun and TypeScript workflow for connecting Gmail, Microsoft, and custom IMAP/SMTP mailboxes to Success.ai.

Success.ai does not publish mailbox-creation endpoints. This project calls the same private endpoints used by the web application. Those endpoints can change without notice. Use a short-lived token from your own account and review every prepared batch before applying it.

## Safety model

- The API destination is fixed in code to `https://api.success.ai/api`; tokens cannot be redirected through configuration.
- `.env`, source CSV files, normalized batches, approvals, progress, and reports are ignored by git.
- Secret-bearing normalized batches are written with mode `0600`.
- Connect is a zero-network dry run unless both `--apply` and a valid, unexpired approval are present.
- Existing accounts are skipped, progress is bound to the exact batch hash, and connection requests are never automatically retried.
- Reports contain email, provider, and status only—never passwords, OAuth codes, or tokens.

## Setup

1. Install Bun, then run `bun install`.
2. Copy `.env.example` to `.env` and fill in your Success.ai session token and workspace ID.
3. Copy `_templates/mailbox-batch.csv` to `01_prepare/input/mailboxes.csv` and replace the placeholder rows.

## Workflow

```bash
bun run stage:prepare
bun run stage:connect
```

Review `01_prepare/output/preflight-report.json`. Create `02_approve/output/approval.json` from `_templates/approval.json`, using the exact `batchSha256` and a validity window no longer than one hour.

Run one live canary:

```bash
bun run stage:connect -- --apply --max-rows 1
```

After checking the canary in Success.ai, resume the approved batch and verify inventory:

```bash
bun run stage:connect -- --apply
bun run stage:verify
```

Gmail and Microsoft rows require fresh OAuth authorization codes. SMTP rows require separate IMAP and SMTP connection fields. Provider login, consent, MFA, CAPTCHA, and tenant policy remain outside this tool.

## Development

```bash
bun run typecheck
bun test
bun run audit:contracts
```

No live provider or Success.ai requests run during tests.
