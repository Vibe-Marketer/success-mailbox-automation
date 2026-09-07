# Security

Never commit session tokens, OAuth codes, mailbox passwords, CSV inputs, approval artifacts, browser profiles, or generated reports.

The connector uses unsupported, version-sensitive Success.ai browser endpoints. Review Success.ai and mailbox-provider terms before use. Live changes require an exact batch approval, and failed mutations are not retried automatically.

If a secret may have been exposed, revoke or rotate it immediately and use GitHub private vulnerability reporting for disclosure.
