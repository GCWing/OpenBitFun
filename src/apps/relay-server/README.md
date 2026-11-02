# OpenBitFun Relay Server

The official Relay connects devices signed in to the same GitHub identity.
GitHub identity is shared with the marketplaces. Users sign in
from OpenBitFun; they do not create a Relay account or deploy a server.

The official endpoint is `https://remote.openbitfun.com/v/1.0.2`. This release is deployed with
its own process, database, assets, and reverse-proxy location. An existing
`/relay` deployment remains on its existing binary and data directory.

The Relay forwards opaque encrypted messages. Each device generates an X25519
private key locally and registers its public key after GitHub identity
verification. Peers obtain public keys through the authenticated same-account
directory and derive an AES-GCM key with X25519 and HKDF-SHA256. The Relay does
not receive device private keys or upload copies of settings and sessions.
Sessions and files are read from the owning online device on demand.

Selecting **Same network** starts the same Relay implementation inside the
Desktop host at `http://<LAN-IP>:9700`. Its SQLite database is local to that
host (`<product-home>/relay-v1.0.0/local-server/relay.db`), separate from the
official server database. Login, device registration, device discovery,
public-key lookup, RPC and presence all use the selected Relay endpoint.
The two modes differ only in endpoint and host startup; no device traffic is
forwarded from the local Relay to the official Relay.

Both modes verify GitHub identity through `auth.openbitfun.com`, so signing in
requires internet access. An invitation contains only the selected endpoint
and device id (`/#/pair?did=<device-id>`); scanning it grants no authority.
The controller must sign in and resolve that id in its same-account directory.
Anonymous room pairing and tunnel-provider startup have been removed.

SSH and Docker workspace connections remain independent of Relay login.

## For community developers and forks

Self-hosting is supported through source and deployment scripts. The public mode uses a fixed official endpoint; it has no deployment wizard or editable
Relay URL. A private Relay therefore needs a matching client build.

1. Fork this workspace and read `CONTRIBUTING.md`. Build the Relay and mobile
   controller from the same revision. Keep your fork's changes in source control.
2. Select your HTTPS endpoint in `product-domains/src/account.rs`, then align
   the frontend constants in `src/web-ui/src/infrastructure/remote-connect/remoteConnectionState.ts`
   and `src/mobile-web/src/services/pairingLink.ts`. Native clients have
   matching constants in KMP `core-transport/AccountDeviceLink.kt` and HarmonyOS
   `services/AccountDeviceLink.ets`; update the HarmonyOS account-link parser too.
   Search for `https://remote.openbitfun.com/v/1.0.2` to verify every runtime
   reference and corresponding test before building your distribution.
3. Decide who owns identity. You can retain the official GitHub identity
   authority, or run the [shared identity service](../../../deploy/miniapp-market/README.md)
   with your own GitHub OAuth application. For an independent authority, change
   `IDENTITY_ME_URL` in `relay-service/src/identity.rs` and
   `DEFAULT_ACCOUNT_API_URL` in `services-integrations/src/account_identity/mod.rs`
   together, and adapt the market sign-in links and callback/completion host.
   `OPENBITFUN_ACCOUNT_API_URL` overrides the desktop/CLI identity API for
   development; the previous `OPENBITFUN_MINIAPP_MARKET_API_URL` alias remains
   readable. Relay never accepts an identity authority from a client request.
4. Use separate persistent data and asset directories, configure exact browser
   CORS origins, then put the service behind your own TLS reverse proxy. Build
   and exercise two devices using the same GitHub identity before distributing
   your fork. The public web controller must come from that matching build.

The scripts remain in this directory: `deploy.sh` deploys on the machine where
it runs, `common.sh` contains Docker/health helpers, and `mirror.sh` and
`release-download.sh` support mirrors and published images. Inspect
`bash deploy.sh --help` first. For fork code use
`bash deploy.sh --build-from-source --global-mirror`; the default image path
pulls a published upstream release, so it will not include your modifications.
An empty account database is normal: successful GitHub verification creates an
identity. Do not run retired `add-user` or password-reset commands.

The legacy script uses its own Compose project and defaults. For a fresh
versioned deployment, prefer the isolated [v1 Compose project](../../../deploy/relay-v1/README.md)
and adapt its host paths, bind port, proxy host, and trusted upstream ranges to
your infrastructure. Never reuse production data directories or an existing
container name for a development deployment. There is no need to restore the
removed deployment wizard to operate these scripts.

## Operator startup

This directory owns the official service binary and maintenance tools. The
shared HTTP/WebSocket implementation lives in `src/crates/services/relay-service`.

Set `RELAY_DB_PATH` to a persistent SQLite database before starting the service.
Startup fails if it is missing; anonymous public relay mode is unsupported.
The service validates OpenBitFun access tokens against the fixed GitHub identity
authority at `https://auth.openbitfun.com/api/v1/me`.

```bash
cargo build --release -p openbitfun-relay-server
RELAY_PORT=9700 RELAY_DB_PATH=/var/lib/openbitfun-relay-v1/relay.db \
  RELAY_ASSET_DIR=/var/lib/openbitfun-relay-v1/assets \
  ./target/release/openbitfun-relay-server
```

Use the isolated [v1 Compose project](../../../deploy/relay-v1/README.md).
Set `RELAY_LISTEN_ADDR=127.0.0.1:19702` with host networking so the service can
verify the immediate loopback proxy peer. Invalid listener values fail startup.
Expose only the TLS reverse proxy. Keep the database and asset paths distinct from older deployments.
`relay-admin` supports listing and explicitly deleting accounts; GitHub login
creates identities. Password provisioning, password reset, and user-entered
Relay server URLs are retired.

## Public-service resource controls

These limits protect the service independently of reverse-proxy configuration.
They are implemented in the shared Relay service, not in the agent loop.

| Resource | Limit and overload behavior |
|---|---|
| Authentication request body | 16 KiB; oversized bodies return 413 |
| Buffered HTTP request bodies | 512 MiB total reserved before buffering; overload returns 503 |
| Concurrent HTTP API requests | 2,048; overload returns 503 |
| Body read / API handler | 15 seconds / 130 seconds |
| HTTP request rate | 6,000/minute per source IP, and per account on the device API; overload returns 429 |
| GitHub authorization start / poll | 10 / 120 per minute per IP |
| Identity verification | 10 attempts/minute per IP; 3-second connect and 5-second response timeout; 64 concurrent outbound requests |
| WebSocket connections | 4,096 active sockets per Relay process; a further handshake is rejected with `connection capacity exceeded` |
| WebSocket connect / heartbeat | Namespace connect must finish within 15 seconds; ping every 15 seconds with a 45-second pong timeout; 30-second acknowledgement lifetime |
| WebSocket frames | 256 KiB per message; larger encrypted bodies use the short-lived HTTP payload lane |
| WebSocket outgoing queue | 128 queued messages per socket, plus 256 MiB of outbound message memory server-wide; a frame that cannot be queued within 2 seconds is dropped |
| RPC memory budgets | 64 MiB server-wide and 16 MiB per account, reserved against the estimated serialized size of in-flight calls; an exhausted budget answers `server RPC memory budget busy` or `account RPC memory budget busy` instead of queueing |
| Pending device RPCs | 2,048 globally, 64 per account, with a 256 MiB response budget: legacy HTTP-to-WebSocket bridge limits, kept in the shared crate but not driven by any current server route |
| Registered devices / active credentials | 64 / 256 per account; database-atomic admission |
| Device RPC ciphertext | 48 MiB, with JSON envelope allowance |
| Published Pages | 100 MiB per page, 10 MiB per file, 4,096 files per page; 1 GiB content-addressed asset store and 256 MiB in-memory asset volume by default |
| Page data | 4 MiB per blob, 2,048 blobs and 64 MiB mutable bytes per page, 10,000 blobs and 256 MiB mutable bytes per account; 20 MiB per page database, 1,000 rows and 2 MiB per query |
| Page functions | 64 concurrent workers globally, 16 per user, 8 per page; 3,000 requests/minute per user and 600 per page; 1 MiB request body |

Existing devices can reconnect at the registration limit. Idempotent token
replays remain valid at the credential limit. Limits never delete a user's
session, device, workspace, or other product data.

Every value in this table is a compile-time constant of the shared service.
Only deployment-level knobs are configurable: the `RELAY_*` settings below, the
container's CPU, memory, PID and file-descriptor limits, and the reverse proxy's
`limit_req`, `limit_conn`, body size and timeouts. A deployment that quotes a
larger limit than its container or proxy allows will fail at the smaller one.

### Scaling

One Relay process owns its sockets, rooms, presence, payload store, asset store
and SQLite database in-process, and the Socket.IO build has no external adapter.
A second instance cannot route to the first instance's sockets, so horizontal
scaling needs per-account stickiness at the proxy; the 4,096-socket ceiling is
per process, not per deployment.

Two paths cost work per connection rather than per message. Connect and
disconnect pass one global gate that is held across the device row's SQLite
round trips, and every open socket re-validates its credential every five
seconds. Both are linear in concurrent sockets, and they matter when a whole
fleet reconnects at once — a Relay restart is the event that produces that
load, so size and test against a mass reconnect, not only steady traffic.

Bearer authentication precedes body buffering on device APIs. Device discovery,
public-key lookup, message routing, and RPC correlation all enforce account
ownership. Delegated controller credentials cannot register sockets, mint more
credentials, or delete devices; revoking their parent device revokes them.
Account-enabled services reject the retired anonymous pairing-room endpoints.

The identity HTTP client rejects redirects, bounds response size and duration,
and never accepts a caller-provided identity authority. Browser CORS uses an
explicit origin list; wildcard CORS is rejected by the standalone host when
account APIs are enabled. Published Pages must use an origin separate from the
account sign-in surface. Without both isolated origins, the standalone host
returns 503 for `/api/pages`, `/api/page-auth`, and `/p` routes.

`POST /api/pages/check-files` advertises `metadata_preconditions_supported`.
Content updates use optional `expected_visibility` and `expected_title` on
version freeze to reject concurrent metadata changes under the Page write lease.
Older clients omit these fields and retain their existing publishing behavior;
new clients require this capability before attempting a content-only update.

Application limits do not replace network-layer protection. Public deployment
also requires bounded proxy connections and request bodies, TLS, upstream DDoS
protection, and alerts for saturation, rejected requests, and disk growth.
Do not log Authorization headers, OAuth transaction secrets, tokens, request
bodies, or URL query strings containing sign-in state.

## Versioned reverse proxy

Strip only the new version prefix when forwarding. Do not replace the existing
`/relay` location. The proxy must overwrite forwarded IP headers with its own
observed source address, and the upstream port must be unreachable externally.
The Relay trusts forwarded client IPs only from an immediate loopback peer.

```nginx
location ^~ /v/1.0.2/ {
    proxy_pass http://127.0.0.1:19702/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    client_max_body_size 49m;
    client_body_timeout 15s;
    proxy_read_timeout 140s;
    proxy_send_timeout 30s;
}
```

Define the standard `$connection_upgrade` map and deployment-specific
`limit_req`/`limit_conn` zones in the owning Nginx configuration. Tune worker and
file-descriptor limits against measured concurrent sockets; daily active users
alone are not a capacity measurement. Preserve ordinary streaming and attachment
traffic in the load test when tuning rate limits.

Before opening the new location, exercise invalid/expired credentials,
cross-account access, concurrent quota exhaustion, oversized/slow bodies,
unauthenticated and slow-reader sockets, cancellation, reconnect, and normal
streaming. Verify that overload returns promptly and releases memory. Confirm
that the old service remains healthy and that rollback only removes the new
location and process.

## API

| Endpoint | Purpose |
|---|---|
| `GET /health`, `GET /api/info` | Health and service version |
| `POST /api/auth/github/start`, `/api/auth/github/poll` | Browser GitHub authorization |
| `POST /api/auth/login` | Exchange verified identity for a keyed device credential |
| `POST /api/auth/logout` | Revoke a credential |
| `POST /api/auth/delegate` | Issue a separately keyed, restricted controller credential |
| `POST /api/auth/provision-device` | Authorized SSH host bootstrap |
| `GET /api/devices` | Same-account device directory |
| `PATCH /api/devices/{id}` | Update an account device alias or self-reported metadata |
| `GET /api/devices/{id}/key` | Same-account device public key |
| `DELETE /api/devices/{id}` | Explicit device removal and revocation |
| `GET /v1/updates` | Authenticated Socket.IO account and machine scopes |
| `POST /v1/rpc/payloads`, `GET /v1/rpc/payloads/{id}` | Account-scoped encrypted bulk RPC bodies (short-lived) |
| `POST /v1/sessions`, `GET /v1/sessions/{id}`, `GET/POST /v3/sessions/{id}/messages` | Retired; answer `410 Gone` with `{"error":"relay_session_history_retired"}` |

Realtime clients authenticate the namespace and wait for `auth-ok` before
registering or calling methods. Machine-owned RPC methods route inside the
same account; only the selected target socket can acknowledge a request.
A lost acknowledgement reports an unknown outcome and never replays a mutation.
Small encrypted messages travel over the live connection; larger RPC bodies use
short-lived HTTP references that expire on their own.

### Device-directory compatibility

`GET /api/devices` retains its existing scope: only same-account desktop/session-host
control targets are listed, including offline devices. Registered mobile and watch
devices remain hidden; legacy rows without a device kind remain desktop targets.
The additive nullable fields are:

| Field | Meaning |
|---|---|
| `device_alias` | Account-owned user alias, persisted independently of the technical name |
| `device_model` | Host-reported device model |
| `device_os` | Host-reported operating-system name |
| `device_os_version` | Host-reported operating-system version |
| `client_version` | Client build string reported at login/handshake, null when unreported |
| `client_protocol` | Client protocol number reported at login/handshake, null when unreported |
| `compatible` | Relay-computed; whether the requesting token's device may remote-control this device |

`device_name` remains the technical/self-reported name; the Relay never replaces it
with the alias. New clients display alias, then technical name, then device id as
fallback. Older clients continue displaying the technical name and can ignore the
additive response fields. Clients must tolerate absent fields from older Relays.

`PATCH /api/devices/{id}` requires an authenticated full device bearer token and
returns `204 No Content` on success. A device may change the alias of any device
in its own account, but may update model/OS metadata only for its own authenticated
device id. Delegated controller tokens cannot patch devices (`403`); missing or
other-account targets return `404` without revealing ownership.

- `{"device_alias":"Build host"}` sets the alias; `{"device_alias":null}` clears it.
- Missing fields mean no change, including a missing alias. An empty object is a
  no-op, not a request to clear fields.
- `device_model`, `device_os`, and `device_os_version` accept strings only when
  present in a PATCH; explicit `null` is rejected rather than clearing metadata.
- Each alias or metadata string is limited to **256 UTF-8 bytes**, not characters,
  and must be nonblank and contain no control characters. Use alias `null`, not an
  empty string, to clear an alias.
- PATCH uses strict `deny_unknown_fields`: unknown mutation fields, including an
  arbitrary metadata extension object, are rejected rather than silently ignored
  and reported as successful. This differs deliberately from extensible response
  objects, whose unknown fields clients may ignore.

Before sending mutations, clients negotiate capabilities through `GET /api/info`:
`device_alias_v1` enables alias updates and `device_metadata_v1` enables metadata
reporting/updates. These are strings in the `capabilities` array;
`protocol_version` remains `3`. Missing capabilities mean unsupported, regardless
of package version. Future PATCH fields or behaviors require their own capability
negotiation before use; clients must not probe old servers with unknown mutations.
An older Relay returning `404`/`405` must produce an explicit unsupported state,
not a successful local-only rename.

### Client-build compatibility

Newer clients also report their build so the Relay can refuse a remote-control
pair it cannot prove compatible. `device_client_build_v1` advertises this: an
optional `clientVersion` string and `clientProtocol` number travel with the
realtime handshake and with `POST /api/auth/login`.

- The device row stores the build from the **current** connection. Every login
  and handshake refreshes both values, including writing `NULL` when the client
  reports nothing, so a stale build is never left behind. `clientVersion` is
  limited to 64 UTF-8 bytes with no control characters; a malformed or absent
  value is treated as unreported rather than rejected, so an older client still
  connects.
- Compatibility is decided only from `clientProtocol`, and a report is required
  rather than merely tolerated: control is allowed only when both sides reported
  a protocol number and the numbers match. Two legacy clients that report
  nothing, and any pair where either side never reported, are incompatible.
- `GET /api/devices` reports the relay-computed `compatible` flag per target,
  based on the requesting token's device row. Incompatible devices are still
  listed, never hidden or deleted.
- A `rpc-call` between incompatible devices is answered with a `failure`
  acknowledgement — `incompatible client build: remote control requires matching
  client versions` — and is not dispatched.

Presence `device-presence` entries carry the raw `client_version` and
`client_protocol` values only; the relay-computed `compatible` flag appears
exclusively in `GET /api/devices`.

Login and provisioning accept optional model/OS metadata. Omission by an older
client preserves stored metadata, and neither registration nor reconnect changes
the alias. Login (and the realtime handshake) additionally report the client
build described above, which is refreshed rather than preserved. Additive SQLite
migrations preserve existing device rows; aliases and metadata survive Relay
restart when the same persistent database is used. Startup resets stale online
presence, not the alias or technical metadata.

Successful patches notify online same-account clients through the existing
`device-presence` channel, whose device entries also carry the new fields.
Notifications are refresh hints, not durable directory state: re-fetch
`GET /api/devices` after a patch or notification and on reconnect/normal refresh.

### Forwarding only

The relay stores no session content. Session transcripts, terminal output and
the workspace/session catalog are host-owned streams
(`services-integrations::remote_connect::host_stream`): a controller reads
pages on demand with the pairwise-encrypted `read_stream` device RPC, and the
host pushes an encrypted `host-stream-changed` device event naming only the
stream id, epoch and newest sequence. Both travel through the same RPC and
`ephemeral` device-event forwarding as every other command, so the relay never
sees plaintext and keeps nothing after delivery. When the controlled device is
offline there is no history to show, by design.

Compatibility on the same connection:

- An older client that still calls the session history routes or requests the
  Socket.IO `session` scope receives `410 Gone` / an explicit auth failure with
  the same `relay_session_history_retired` reason, never an empty page.
- A newer client against an older relay ignores the `update` frames that relay
  still emits; stream pages and hints do not depend on relay-side state.
- Hosts advertise `host_stream_v1` in their handshake `capabilities`;
  controllers check it before opening a stream and report an older host as
  unsupported instead of probing it with unknown commands.
- On start-up the service drops the retired `realtime_sessions`,
  `realtime_messages` and `realtime_account_sequence` tables from an existing
  database and runs `VACUUM`, so previously stored ciphertext is removed from
  disk without an operator step. A version that is still serving clients cannot
  be patched after the fact: bound its growing log by hand until it reaches the
  retirement switch, as described in the
  [v1 deployment guide](../../../deploy/relay-v1/README.md#keeping-a-legacy-10x-deployment-alive).

The old `/ws`, HTTP device `rpc` and `messages` routes are retired. Deploy the
new client and server together under a separate versioned relay prefix.

## Configuration

`RELAY_PORT`, `RELAY_DB_PATH`, `RELAY_STATIC_DIR`, `RELAY_ROOM_WEB_DIR`,
`RELAY_ASSET_STORE_MAX_BYTES`, and `RELAY_CORS_ALLOW_ORIGINS` are operator
settings. `RELAY_PAGE_PUBLIC_BASE_URL` and `RELAY_PAGE_AUTH_BASE_URL` must be set
together and use distinct origins when protected Pages are deployed.

## Verification

```bash
cargo test -p openbitfun-relay-server --bin openbitfun-relay-server
cargo test -p openbitfun-relay-service
cargo check -p openbitfun-relay-server
node scripts/check-core-boundaries.mjs
```

Unit and integration tests are local evidence. Record live remote-control,
peer-device, remote-workspace, and detached-dispatch validation separately.
