# OpenBitFun Skin market self-hosted deployment

This directory deploys the Appearance package catalog exposed to users as the
**Skin market** at `https://market.example.com/skin/`.

This is a community self-deployment template. `$DEPLOY_HOST`,
`market.example.com`, and the `/srv/openbitfun-*` and `/etc/openbitfun-*` paths
are examples; replace them with your own SSH host, domains, and directories.
Set `DEPLOY_HOST` in the current shell before running the commands:

```bash
DEPLOY_HOST=root@your-server
```

Official hosted-service configuration is not published in this repository.

It is intentionally isolated from the MiniApp market deployment:

| Resource | Skin market |
| --- | --- |
| Container | `openbitfun-skin-market` |
| Loopback origin | `127.0.0.1:9720` |
| Checkout | `/srv/openbitfun-skin-market/app` |
| SQLite | `/srv/openbitfun-skin-market/data/market.sqlite` |
| Artifacts | `/srv/openbitfun-skin-market/artifacts` |
| Backups | `/srv/openbitfun-skin-market/backups` |
| Root-only environment | `/etc/openbitfun-skin-market/market.env` |
| Deploy ref | `refs/heads/skin-market-deploy` |

The Skin server has no OAuth client or credential database. Desktop clients
reuse the MiniApp market credential vault and Skin forwards each Bearer token
to the configured MiniApp `/me` endpoint. Web contribution and review routes
use the MiniApp auth broker and a `/skin`-scoped alias of that broker's Web
session. Unsafe browser requests require the matching CSRF alias. Never copy
the MiniApp OAuth secret into the Skin environment.

The MiniApp identity service must run a commit that implements the same shared
account contract as Skin. Changes under `miniapp-market-service/src/auth.rs` or
its OAuth routes must be deployed with the MiniApp runbook before Skin is
considered healthy. Deploy the two containers separately from their dedicated
checkouts; do not recreate MiniApp from the Skin Compose project.

## Agent safety contract

1. Deploy only a committed, explicit commit. Never build a dirty checkout or a
   floating branch name.
2. Do not read, copy or print `/etc/openbitfun-skin-market/market.env`.
3. Record the previous commit and verify a current SQLite backup before a
   backend or schema deployment.
4. Do not recreate or modify other services running on the host.
5. Use `--force-with-lease` for the dedicated deploy ref; never unconditional
   force.
6. Run `nginx -t` before reload. Install only the market vhost changed by this
   deployment and the namespaced Skin rate-limit zones.
7. Report success only after container health, image revision, origin and public
   health all match the target commit.
8. Do not automatically roll an older binary over an incompatible migration.

## Local release checks

Choose the smallest relevant checks, then create one explicit commit:

```bash
pnpm run fmt:rs
cargo test -p openbitfun-product-domains --no-default-features --features appearance-market
cargo test -p openbitfun-skin-market-service
cargo check -p openbitfun-skin-market-server
pnpm run type-check:skin-market
pnpm run test:skin-market
pnpm run build:skin-market
git diff --check
```

Record the immutable target:

```bash
DEPLOY_COMMIT="$(git rev-parse HEAD)"
git show --stat --oneline "$DEPLOY_COMMIT"
```

## First installation

Create only the dedicated roots; UID/GID `10002` owns live data, never secrets:

```bash
ssh "$DEPLOY_HOST" 'set -eu
install -d -m 0755 /srv/openbitfun-skin-market
install -d -o 10002 -g 10002 -m 0750 \
  /srv/openbitfun-skin-market/data /srv/openbitfun-skin-market/artifacts
install -d -m 0750 /srv/openbitfun-skin-market/backups
install -d -m 0700 /etc/openbitfun-skin-market
test ! -e /srv/openbitfun-skin-market/app
git clone --no-hardlinks /srv/openbitfun-miniapp-market/app /srv/openbitfun-skin-market/app
git -C /srv/openbitfun-skin-market/app checkout --detach
git -C /srv/openbitfun-skin-market/app status --short'
```

Create the environment with a controlled editor, using
`market.env.example` as a field list. Generate the download hash secret on the
server; do not pass it as a command argument or paste it into logs:

```bash
ssh -t "$DEPLOY_HOST" 'umask 077; vi /etc/openbitfun-skin-market/market.env'
ssh "$DEPLOY_HOST" 'chmod 600 /etc/openbitfun-skin-market/market.env; \
  stat -c "%U:%G %a %n" /etc/openbitfun-skin-market/market.env'
```

Production identity verification should use
`https://market.example.com/miniapp/api/v1/me`. Public HTTPS avoids coupling
the two independent Compose networks. Skin forwards either the Bearer
Authorization header or the exact Skin session and CSRF aliases required for
the request; it never proxies the browser's full Cookie header.

Install backup jobs after the checkout contains this deployment, but do not
start the timer until the Skin container has created a healthy UID-10002-owned
database:

```bash
ssh "$DEPLOY_HOST" 'set -eu
install -m 0750 /srv/openbitfun-skin-market/app/deploy/skin-market/backup.sh \
  /usr/local/sbin/openbitfun-skin-market-backup
install -m 0750 /srv/openbitfun-skin-market/app/deploy/skin-market/restore-drill.sh \
  /usr/local/sbin/openbitfun-skin-market-restore-drill
install -m 0644 /srv/openbitfun-skin-market/app/deploy/skin-market/openbitfun-skin-market-backup.service \
  /etc/systemd/system/openbitfun-skin-market-backup.service
install -m 0644 /srv/openbitfun-skin-market/app/deploy/skin-market/openbitfun-skin-market-backup.timer \
  /etc/systemd/system/openbitfun-skin-market-backup.timer
systemctl daemon-reload'
```

## Deploy an exact commit

Inspect the target and existing deployment first. On an initial install, the
container inspect/health commands are expected not to find a container:

```bash
ssh "$DEPLOY_HOST" 'set -eu
git -C /srv/openbitfun-skin-market/app status --short
git -C /srv/openbitfun-skin-market/app rev-parse HEAD
docker inspect --format "{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" openbitfun-skin-market 2>/dev/null || true
curl -fsS http://127.0.0.1:9720/skin/api/v1/health 2>/dev/null || true
stat -c "%U:%G %a %n" /etc/openbitfun-skin-market/market.env'
```

For an existing deployment, save the rollback target and confirm or create
today's backup before changing the checkout:

```bash
PREVIOUS_COMMIT="$(ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-skin-market/app rev-parse HEAD')"
ssh "$DEPLOY_HOST" 'set -eu
if test -f /srv/openbitfun-skin-market/data/market.sqlite; then
  today="$(date -u +%F)"
  target="/srv/openbitfun-skin-market/backups/daily/${today}"
  if test -d "$target"; then
    (cd "$target" && sha256sum -c SHA256SUMS)
    test "$(sqlite3 "$target/market.sqlite" "PRAGMA integrity_check;")" = ok
  else
    /usr/local/sbin/openbitfun-skin-market-backup
  fi
fi'
```

Send only the explicit commit to the dedicated ref:

```bash
if REMOTE_REF_COMMIT="$(ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-skin-market/app \
  rev-parse refs/heads/skin-market-deploy 2>/dev/null')"; then
  DEPLOY_LEASE="refs/heads/skin-market-deploy:${REMOTE_REF_COMMIT}"
else
  # An empty expected value means the initial push succeeds only while the
  # deploy ref is still absent; it remains a compare-and-swap operation.
  DEPLOY_LEASE="refs/heads/skin-market-deploy:"
fi
git push \
  --force-with-lease="${DEPLOY_LEASE}" \
  ssh://$DEPLOY_HOST/srv/openbitfun-skin-market/app \
  "${DEPLOY_COMMIT}:refs/heads/skin-market-deploy"
ssh "$DEPLOY_HOST" "set -eu
test -z \"\$(git -C /srv/openbitfun-skin-market/app status --porcelain)\"
git -C /srv/openbitfun-skin-market/app checkout --detach '$DEPLOY_COMMIT'
test \"\$(git -C /srv/openbitfun-skin-market/app rev-parse HEAD)\" = '$DEPLOY_COMMIT'"
```

Build while any existing container continues serving, then recreate only Skin:

```bash
ssh "$DEPLOY_HOST" "set -eu
cd /srv/openbitfun-skin-market/app
test \"\$(git rev-parse HEAD)\" = '$DEPLOY_COMMIT'
export MARKET_GIT_COMMIT='$DEPLOY_COMMIT'
docker compose -f deploy/skin-market/docker-compose.yml build skin-market
docker compose -f deploy/skin-market/docker-compose.yml \
  up -d --no-build --force-recreate skin-market"
```

Wait for health and verify revision plus both network paths:

```bash
ssh "$DEPLOY_HOST" 'set -eu
for attempt in $(seq 1 45); do
  status="$(docker inspect --format \
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" \
    openbitfun-skin-market)"
  test "$status" = healthy && exit 0
  sleep 2
done
docker inspect --format "{{json .State}}" openbitfun-skin-market
exit 1'

DEPLOYED_COMMIT="$(ssh "$DEPLOY_HOST" 'docker inspect --format \
  "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" \
  openbitfun-skin-market')"
test "$DEPLOYED_COMMIT" = "$DEPLOY_COMMIT"
ssh "$DEPLOY_HOST" 'curl -fsS http://127.0.0.1:9720/skin/api/v1/health'
```

Create and drill the first backup only after the container is healthy, then
enable the timer:

```bash
ssh "$DEPLOY_HOST" 'set -eu
/usr/local/sbin/openbitfun-skin-market-backup
today="$(date -u +%F)"
/usr/local/sbin/openbitfun-skin-market-restore-drill \
  "/srv/openbitfun-skin-market/backups/daily/${today}"
systemctl enable --now openbitfun-skin-market-backup.timer'
```

## Nginx route

The shared market vhost is owned in
`deploy/miniapp-market/nginx-market.conf` (template file name).
It keeps MiniApp at 25 MiB and grants only `/skin/` the 100 MiB transport
ceiling. Skin application validation remains 96 MiB. Install this file only
when its diff is part of the target commit:

The trusted proxy ranges in `nginx-skin-market-http.conf` are an explicit trust
boundary, not a generic proxy list. Before each deployment, compare them with
your reverse proxy or WAF provider's current egress source-IP list and the
origin firewall allowlist. Stop if any of the sets differ.

```bash
ssh "$DEPLOY_HOST" 'set -eu
install -m 0644 \
  /srv/openbitfun-skin-market/app/deploy/skin-market/nginx-skin-market-http.conf \
  /etc/nginx/conf.d/skin-market.conf
install -m 0644 \
  /srv/openbitfun-skin-market/app/deploy/miniapp-market/nginx-market.conf \
  /etc/nginx/sites-available/market.example.com.conf
nginx -t
systemctl reload nginx
curl -fsS http://127.0.0.1:9720/skin/api/v1/health'
curl -fsS https://market.example.com/skin/api/v1/health
curl -fsS https://market.example.com/skin/ >/dev/null
```

Point your domain's DNS and TLS certificate at this host. If a WAF or load
balancer terminates TLS, verify its body-size policy before publishing a
package near the 96 MiB application limit.

## Rollback

For a backward-compatible release, detach the dedicated checkout at
`$PREVIOUS_COMMIT`, build if its image is absent, and recreate only
`skin-market`. Repeat all health and revision checks. Use a leased push to move
`skin-market-deploy` back afterwards. If the new binary applied a migration an
older binary cannot read, stop and design an explicit data rollback; restoring
a backup can discard submissions created after that snapshot.

Daily backups retain 14 snapshots and Sunday snapshots retain 8 weeks. The
restore drill validates same-host recovery only; it is not off-site disaster
recovery.
