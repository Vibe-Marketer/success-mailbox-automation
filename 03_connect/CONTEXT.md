# Stage 03: connect

## Inputs

- Normalized batch
- Approval artifact for live execution
- `.env` token and workspace ID

## Process

Dry-run by default. With `--apply`, validate approval, load complete inventory, skip existing accounts, and execute provider-specific requests without automatic retries.

## Outputs

- `03_connect/output/progress.json`
- `03_connect/output/connect-report.json`

## Human check

Use `--max-rows 1` first and inspect the canary in Success.ai before resuming.
