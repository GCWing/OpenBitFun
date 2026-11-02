# Legacy market data migration

This directory contains one-time migration tooling for pre-rename MiniApp and
Skin market data. It does not describe the official hosted service, and no
official hostnames, SSH aliases, credentials, or production data belong here.

## What is here

| Path | Purpose |
| --- | --- |
| `migrate-market-data-v1.py` | One-time data migration for pre-rename market data |
| `test_migrate_market_data_v1.py` | Tests for the migration tool |

[`migrate-market-data-v1.py`](migrate-market-data-v1.py) refuses to run against
the live database when `--live-database` points at the same path. Work on a
copy, keep the original, and verify SQLite `integrity_check` plus package
checksums before switching traffic.

Run the tests before modifying it:

```bash
python3 -m unittest test_migrate_market_data_v1.py
```

## Related guides

- MiniApp market: [`../miniapp-market/README.md`](../miniapp-market/README.md)
- Skin market: [`../skin-market/README.md`](../skin-market/README.md)
- Relay: [`../relay-v1/README.md`](../relay-v1/README.md) and
  [`../../src/apps/relay-server/README.md`](../../src/apps/relay-server/README.md)
- Outbound mail: [`../outbound-mail/README.md`](../outbound-mail/README.md)
