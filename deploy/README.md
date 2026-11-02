# Deployment references

Community self-hosting references for OpenBitFun. The official hosted services
are operated separately; their configuration and access details are not
published in this repository.

Each guide uses placeholder hosts, domains, and paths. Replace them with your
own environment before running commands.

| Directory | Use |
| --- | --- |
| [market-data-migration/](market-data-migration/README.md) | Legacy market data migration tooling |
| [miniapp-market/](miniapp-market/README.md) | MiniApp market |
| [skin-market/](skin-market/README.md) | Skin market |
| [relay-v1/](relay-v1/README.md) | Versioned Relay deployment |
| [outbound-mail/](outbound-mail/README.md) | Send-only Postfix/OpenDKIM: auth integration, DNS, maintenance and rollback |
| [model-router/](model-router/README.md) | Client-side router launcher and system prompt |

Component source guides:

- Relay: [`src/apps/relay-server/README.md`](../src/apps/relay-server/README.md)
- MiniApp market server: [`src/apps/miniapp-market-server/README.md`](../src/apps/miniapp-market-server/README.md)
- Skin market service: [`src/crates/services/skin-market-service/README.md`](../src/crates/services/skin-market-service/README.md)

For deployment changes, read the relevant component guide and keep every
example hostname, path, and credential as a placeholder.
