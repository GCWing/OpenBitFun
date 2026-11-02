# Relay v1 self-hosted deployment

This directory is a community self-deployment template. Example domains and
paths must be replaced with your own environment.

The owner guide is [Relay Server](../../src/apps/relay-server/README.md).
Use this independent Compose project for `/v/1.0.2/`. Keep the `/v/1.0.1/` Compose project
(`openbitfun-relay-v1.0.1`, port `19701`, `/srv/openbitfun-relay-v1.0.1`) running with its own
container, image, database, assets, and proxy location: clients built for 1.0.1 keep using it,
and the two releases do not share a credential database.

Deploy from a committed checkout at `/srv/openbitfun-relay-v1.0.2/app`. Set
`RELAY_GIT_COMMIT` to that checkout's verified full commit. Set
`RELAY_PUBLIC_ORIGIN` and `RELAY_AUTH_ORIGIN` to your public Relay and auth
origins before running Compose; the checked-in values are `example.com`
placeholders. Build mobile web
from the same checkout with `pnpm run build:mobile-web` and stage its `dist`
contents into `/srv/openbitfun-relay-v1.0.2/static`. Create `data` and `assets`
under that root owned by UID/GID 10001 before starting Compose.

The Linux host network plus explicit `127.0.0.1:19702` listener lets the service
verify the immediate proxy peer before trusting its overwritten forwarded IP.
Do not publish this listener on a public interface. Install `nginx-http.conf` as `/etc/nginx/conf.d/relay-v1.0.2.conf` and include
`nginx-location.conf` as `/etc/nginx/relay-v1.0.2-location.conf` in the existing remote server after the container passes
its health check. [`nginx-relay.conf`](nginx-relay.conf) is a full generic
server-block example. Keep the existing v1.0.1 includes. The new version uses independent admission zones.
The new location accepts your explicit WAF origin
ranges and loopback; direct origin requests from other peers receive 403.
Forwarded client IPs are recursively resolved only for those trusted WAF
peers. Keep the range list synchronized with the WAF control plane. Raise
`worker_connections` to 8192 and retain a file descriptor limit of at least
16384; validate with `nginx -t` before a graceful reload.

Published Pages use your public Relay address:
`https://relay.example.com/v/1.0.2/p/{github_username}/{slug}`.
Compose derives this public base URL and the separate sign-in base URL
`https://auth.example.com/v/1.0.2` from `RELAY_PUBLIC_ORIGIN` and
`RELAY_AUTH_ORIGIN`. Users do not configure domains.
Install the versioned Pages sign-in locations from
[`nginx-auth.conf`](../miniapp-market/nginx-auth.conf)
(template file name) in the existing auth server as well. Keep its marketplace sign-in routes intact.
These locations forward only Page sign-in and GitHub start/poll endpoints to
Relay, preserve the auth Host, and omit query strings from access logs.
The Page callback and published content remain on the remote origin.

Both base URLs are required: missing configuration returns an explicit 503.
After changing the environment, recreate only `relay-v1` with the verified
existing image (`docker compose up -d --no-build relay-v1`), validate Nginx,
and gracefully reload it. Verify publish and deploy through an authenticated
CLI, fetch both returned URLs, and verify that private-page sign-in redirects
to the auth origin and its client script loads.

Before replacement, back up this version's database and assets and retain the
previous image tag. Roll back only this Compose project and its versioned
location. Never use the legacy relay Compose file to operate this deployment.

## Retiring an older version

Retiring `/v/1.0.1/` (or any earlier prefix) must tell its clients to update
instead of leaving them with a bare `404`/`502`, because those clients cannot
be patched after the fact. Both forms answer the same body:

```json
{"error":"relay_version_retired","message":"…Update OpenBitFun on this device, then sign in again to continue.","update_required":true}
```

The code string, the `update_required` flag and the message are one contract,
pinned by `src/crates/services/relay-service/src/retired_version.rs`.

1. **Relay enforced (while a container still serves the prefix).** Point the
   retired prefix at the *current* relay and announce it:

   ```nginx
   location ^~ /v/1.0.0/ {
       proxy_set_header X-OpenBitFun-Relay-Served-Prefix /v/1.0.0;
       # …the same proxy_pass, real-IP and admission settings as the live prefix
   }
   ```

   Start that relay with `RELAY_RETIRED_VERSION_PREFIXES=/v/1.0.0` so account,
   realtime and Page routes of the announced prefix answer `410` before
   authentication or body buffering. `RELAY_RETIRED=1` retires the whole
   deployment instead, which is what a full shutdown uses. The startup log
   states the resolved switch (`relay answers retired versions …` or `no Relay
   version is retired`), so enabling and rolling back are verifiable before
   traffic arrives. The development deployment retires `/v/1.0.0/` this way,
   through a deployment-local `compose.override.yml`:

   ```yaml
   services:
     relay-v1:
       environment:
         RELAY_RETIRED_VERSION_PREFIXES: /v/1.0.0
   ```

   **Both halves are required.** Proxying a retired prefix without listing it
   serves the live relay under that retired prefix, which silently un-retires
   the version; announcing a prefix that the edge never sends retires nothing.
   A working example of this location is installed as
   `/etc/nginx/relay-retired-v1.0.0-location.conf`.
2. **Edge only (recommended once the container is gone).** Stop the retired
   Compose project, delete its images and volumes, then replace the retired
   prefix's include with `nginx-retired-version.conf`, keep the live version's
   include untouched, validate with `nginx -t`, and gracefully reload. The old
   prefix keeps answering `410` with `no-store`, so no client caches a stale
   success, and the retirement body covers the websocket upgrade path too.

Either form keeps `/health` and static content served: the page that explains
the update still loads, and the health probe keeps working.

Never retire a prefix that current clients still use: an unconfigured relay is
never retired, so an omitted or mistyped variable fails safe. An operator
turnover hazard is the reverse: a prefix listed but no longer proxied stays
retired only for as long as the edge announces it.

## Keeping a legacy 1.0.x deployment alive

A 1.0.x Relay persisted every realtime session message in `realtime_messages`
and never pruned it: `log_bytes` was tracked per account but no code enforced a
ceiling, so the file grew with traffic forever. A legacy deployment
reached **38.6 GiB in six days** with 97 accounts (~6.4 GB/day, ~2.8 M rows,
~14.5 KB per encrypted row), while every other table stayed under a megabyte.
1.0.2 stores no session content and drops those tables at startup (see
[Forwarding only](../../src/apps/relay-server/README.md#forwarding-only)), but a
legacy version cannot be patched after the fact, so its log has to be bounded by
hand until that version is retired.

`prune-legacy-message-log.py` in this directory does that from the database
side, without a service window. The rules below are the contract it implements;
do not weaken them without re-reading the legacy read path.

### What a legacy database may lose without affecting users

- Messages are forwarded after being committed, so a client cursor is only ever
  valid against the rows that still exist. Reads tolerate gaps: catch-up asks
  for `seq > cursor` and history pages ask for `seq < cursor`, and neither
  reports a missing range.
- Delete by age (default: keep 24 hours), keep the newest `--min-keep` messages
  of every session regardless of age, and never delete anything newer than
  `--safety-minutes` (default: 60 minutes). A device that was offline longer
  than the window cannot backfill that gap; nothing else changes for it.
- Never delete or rewrite `realtime_sessions`, `realtime_account_sequence` or
  `realtime_sessions.seq`. They carry the session identity and the cursor
  counters; removing them would break `open_session` and the client cursors
  instead of just shortening history. The tool leaves them untouched.
- The `local_id` uniqueness that makes a send retry idempotent only covers the
  rows still retained. A retry of a message older than the window inserts a new
  row rather than returning the old one, which is acceptable because clients
  retry within seconds.

### Prune online

```bash
# Analyse first: prints how many rows each policy would delete.
python3 prune-legacy-message-log.py --report
python3 prune-legacy-message-log.py --dry-run --keep-hours 24

# Delete for real, gently.
nice -n 10 ionice -c2 -n6 python3 prune-legacy-message-log.py --apply \
  --keep-hours 24 --safety-minutes 60 --max-msgs 5000 --min-keep 200 \
  --batch-rows 2000 --sleep-ms 20
```

The Relay runs SQLite in WAL mode with `busy_timeout = 5s`, so users only stay
unaffected while every statement holds the single write lock for far less than
five seconds:

- Delete primary-key ranges in small committed batches with a pause between
  them; never delete a large range in one transaction. A single oversized
  `DELETE`, an online `VACUUM`, or a checkpoint stall makes every account wait
  for the write lock and then fail with `database is locked`.
- Count rows that were really removed (`total_changes`), never the planned range
  length. A planned range is recomputed on every run, so re-planning already
  pruned sessions reports phantom deletions and issues empty statements that
  still take the write lock.
- Verify with the Relay's own log: `slow statement` warnings (sqlx logs anything
  over one second) mean the batches are too large.

### Reclaim the space (one short window)

Pruning alone does not shrink the file: an `auto_vacuum = 0` database keeps the
freed pages in its freelist and reuses them, which stops the growth but leaves
the file at its high-water mark. Either reclaim in a short window:

```bash
docker stop openbitfun-relay-v1.0.1
# Keep the previous file (plus its -wal/-shm) until the new one is verified.
sqlite3 /srv/openbitfun-relay-v1.0.1/data/relay.db \
  "PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; VACUUM;"
docker start openbitfun-relay-v1.0.1
```

or compact online first and swap inside the window, which turned a
38.6 GiB file into 7.15 GiB in one legacy deployment: run
`VACUUM INTO '/srv/.../data/relay-compact.db'` while the service keeps serving
(a consistent snapshot; `VACUUM INTO` output is `journal_mode=delete` and keeps
`auto_vacuum` of the source, so the window still has to set both), then stop the
container, move the live `relay.db` and its `-wal`/`-shm` aside, move the
compact copy into place, `chown` it to the container's UID (10001 in the Compose
file), and start. Budget the window around the in-place `VACUUM`, not the copy:
on a 7 GiB file it took 138 of the 151 seconds here.

Enabling `auto_vacuum = INCREMENTAL` in that same window is what makes later
prunes return space without stopping the service: the tool then calls
`PRAGMA incremental_vacuum(...)` after each run, which moves free pages to the
end of the file and truncates them (verified: 6,843 free pages returned and the
file shrank by exactly 26.7 MiB while the service stayed up).

After the swap, verify before deleting anything: `PRAGMA quick_check`,
row counts for `users`/`devices`/`auth_tokens`/`realtime_*`, `auto_vacuum = 2`,
`journal_mode = wal`, `/health`, and that devices reconnect. A swap installs a
snapshot taken when the copy started, so writes made during the copy are
missing; that is acceptable for the message log, but expect a few devices to
sign in again because their credential row moved.

### Run it on a timer

Install the tool on the deployment host and prune hourly, so the database stops
growing without anyone watching it:

```bash
install -m 0755 prune-legacy-message-log.py /root/ops/
```

```ini
# /etc/systemd/system/openbitfun-relay-1.0.1-prune.service
[Unit]
Description=Prune the legacy OpenBitFun Relay 1.0.1 realtime message log
After=network-online.target docker.service

[Service]
Type=oneshot
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=6
ExecStart=/usr/bin/python3 /root/ops/prune-legacy-message-log.py --apply \
  --keep-hours 24 --safety-minutes 60 --max-msgs 5000 --min-keep 200 \
  --batch-rows 500 --sleep-ms 25 --incremental-vacuum-pages 2000
StandardOutput=append:/var/log/openbitfun-relay-1.0.1-prune.log
StandardError=append:/var/log/openbitfun-relay-1.0.1-prune.log

# /etc/systemd/system/openbitfun-relay-1.0.1-prune.timer
[Unit]
Description=Hourly prune of the legacy OpenBitFun Relay 1.0.1 message log

[Timer]
OnCalendar=hourly
RandomizedDelaySec=300
Persistent=true
Unit=openbitfun-relay-1.0.1-prune.service

[Install]
WantedBy=timers.target
```

`systemctl enable --now openbitfun-relay-1.0.1-prune.timer`. The steady-state run
is cheap: hourly traffic moves past the window in seconds, versus 455 seconds
for the first pass over 2.17 M rows. Pruning and retiring are separate steps —
pruning only buys time until the version reaches the retirement switch above.
