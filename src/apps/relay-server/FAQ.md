# Relay, accounts, and remote connections

[中文](FAQ.zh-CN.md) · [Operator guide](README.md)

## Do I need to deploy a server?

No. Released clients use the official Relay for same-account device control.
Sign in on the host and controller with the same OpenBitFun account and follow
the Remote Connect invitation or device-selection flow. Keep the host running
and reachable. The official endpoint is `https://remote.openbitfun.com/relay?v=1.0.9`;
the version travels as a query parameter, and the older
`https://remote.openbitfun.com/v/1.0.2/` path keeps working against the same
account database;
the path is a service-protocol prefix, not the current desktop release number.

| Connection | What you need |
| --- | --- |
| Official Relay | Internet access and the same account on both devices; no server deployment or Relay URL configuration |
| Same network | A Desktop host running its embedded LAN Relay, reachable by the controller; internet access for sign-in |
| Private Relay | Your own service deployment and matching client builds; see the [fork guide](README.md#for-community-developers-and-forks) |
| SSH / Docker workspace | Access to the target environment; independent of Relay login |

Desktop can keep official and LAN connections active together. **My devices**,
Peer Device Mode, account synchronization, and account-device Detached Dispatch
continue to use the official account endpoint; LAN mode does not move them to a
private server. CLI does not host an embedded LAN Relay. Messaging bots have
their own provider configuration and pairing flow.

## Is GitHub required?

Current clients offer GitHub and email verification-code sign-in when enabled
by the shared identity service. Email sign-in needs no password. The two login
methods create independent accounts; matching email addresses do not merge them.
Use the same method and account on each device to see the same devices.

Older clients and services can offer GitHub only. If an expected login option is
missing, check the installed client and service support. Local work and SSH /
Docker workspace connections do not require a Relay account; model and external
service credentials are separate.

An invitation identifies a Relay endpoint and target device. Scanning it does
not grant access: the controller must sign in and resolve the device in its
same-account directory.

## Can I use LAN mode without internet access?

LAN device traffic stays on the selected local Relay, but both LAN and official
modes use `auth.openbitfun.com` for identity verification at sign-in. A local
Relay therefore does not provide an offline account-setup or sign-in flow.
An existing authenticated connection is not a guarantee that a new login or
credential renewal will work during an outage.

For an isolated environment, local work and SSH / Docker remain separate
options, subject to their own connectivity and model requirements. A private
Relay alone does not remove the online identity dependency: an independent
deployment must also adapt the identity service and clients. The shipped
product does not provide a turnkey air-gapped identity mode.

## What can the services see?

Device-control payloads are encrypted end to end. Devices generate X25519
private keys locally, retrieve peer public keys from the authenticated account
directory, and derive AES-GCM keys using X25519 and HKDF-SHA256. The Relay does
not receive device private keys. Session history and workspace files are read
from the owning online host on demand, rather than a Relay-hosted session backup.

The Relay still processes account IDs, device registrations, public keys,
presence, and routing metadata. The identity service processes sign-in; the
identity service and authenticated public-key directory remain part of the
trust boundary. Payload encryption does not mean that no data reaches an
operated service, nor does it protect a compromised endpoint.

Published Pages, Page data/functions, marketplaces, model-provider requests, and
messaging-bot traffic have separate data flows. Publishing a Page uploads its
content to the publishing service under the selected visibility rules. Do not
apply the device-control encryption claim to all OpenBitFun network traffic.

## Is the official Relay free? What are the quotas and SLA?

This repository documents technical resource controls, but does not publish a
Relay pricing schedule, monthly traffic allowance, or service-level agreement
(SLA). Check current service announcements or ask the maintainers through the
[repository](https://github.com/GCWing/OpenBitFun) before relying on specific
commercial or availability terms. Open-source licensing does not establish
hosted-service terms.

The [resource-control table](README.md#public-service-resource-controls)
documents enforced device, connection, request, and payload limits. These are
technical limits, not a subscription quota or an unlimited-use promise; the
deployment and reverse proxy may enforce tighter limits. Historical 0.2.x
“Beta free” descriptions do not establish permanent free service or current
limits. Legacy anonymous pairing, password provisioning, and deployment-wizard
instructions do not describe the current account-based connection flow.

## What happens if a service or device is unavailable?

New sign-ins require the identity service. Official remote control requires
the Relay and the selected host to be reachable. If the host is offline, its
session history and files are unavailable through that connection. A controller
disconnect does not cancel work already running on the host, but the host must
stay running and tasks waiting for approval still need an answer.

Desktop's same-network connection can provide a separate route when the devices
can reach each other, subject to the sign-in requirement above. It is not an
automatic failover for My devices, Peer Device Mode, or account-device dispatch.
Local work and independently configured SSH / Docker access are not Relay
routes. Reconnect and inspect the existing task before submitting it again.

## What does self-hosting actually involve?

The public mode has a fixed official endpoint, with no editable custom-server
field or deployment wizard. A private Relay needs coordinated client endpoint
changes, a compatible Relay/mobile-web build, persistent storage, TLS and proxy
configuration, and ongoing backups, upgrades, monitoring, and capacity planning.
If you also operate identity, configure the supported login providers and their
callbacks or email delivery. A VPS alone does not complete this setup; there is
no universal monthly-cost estimate.

Start with the [fork guide](README.md#for-community-developers-and-forks) and
[versioned deployment guide](../../../deploy/relay-v1/README.md). Changing server
environment variables does not redirect already released clients.

## Implementation references

- [Official endpoint and account identities](../../crates/contracts/product-domains/src/account.rs)
- [Shared sign-in and older-client compatibility](../../crates/services/miniapp-market-service/README.md#邮箱验证码登录)
- [Desktop connection lifecycle](../desktop/README.md#remote-connect)
- [Device key derivation](../../crates/services/services-integrations/src/remote_connect/device_crypto.rs) and [Relay identity verification](../../crates/services/relay-service/src/identity.rs)
- [Remote workspace ownership](../../../docs/architecture/remote-workspace-transport.md#controller-and-runtime-ownership)
