# Legacy market data migration

This directory holds community self-hosting tooling for migrating pre-rename
market data. Read [README.md](README.md) before changing the migration script.

- Never commit real hostnames, SSH aliases, credentials, tokens, certificates,
  production data, or other operational secrets.
- Examples use placeholder domains and paths. Keep them generic.
- Back up data with the SQLite backup API and verify integrity before running a
  migration. Do not use destructive Git commands to force a deployment.
- MiniApp and Skin markets have their own runbooks. Do not mix their checkouts,
  secrets, or Compose projects.
