# Stage 01: prepare

## Inputs

- `01_prepare/input/mailboxes.csv`
- `config/workflow.json`

## Process

Validate provider-specific fields, reject duplicate addresses, and write a normalized private batch plus credential-free preflight report.

## Outputs

- `01_prepare/output/private/normalized-batch.json`
- `01_prepare/output/preflight-report.json`

## Human check

Confirm every email/provider pair and the total before approval.
