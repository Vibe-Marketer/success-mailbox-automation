# Stage 02: approve

## Inputs

- Preflight report
- `_templates/approval.json`

## Process

Copy the exact batch hash, identify the operator, and set an approval window no longer than one hour.

## Outputs

- `02_approve/output/approval.json`

## Human check

Confirm the hash matches the reviewed batch and the approval is not expired.
