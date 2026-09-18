# Official Relay v1 deployment

The owner guide is [Relay Server](../../src/apps/relay-server/README.md).
Use this independent Compose project for `/v/1.0.2/`. Keep the `/v/1.0.1/` Compose project
(`openbitfun-relay-v1.0.1`, port `19701`, `/srv/openbitfun-relay-v1.0.1`) running with its own
container, image, database, assets, and proxy location: clients built for 1.0.1 keep using it,
and the two releases do not share a credential database.

Deploy from a committed checkout at `/srv/openbitfun-relay-v1.0.2/app`. Set
`RELAY_GIT_COMMIT` to that checkout's verified full commit. Build mobile web
from the same checkout with `pnpm run build:mobile-web` and stage its `dist`
contents into `/srv/openbitfun-relay-v1.0.2/static`. Create `data` and `assets`
under that root owned by UID/GID 10001 before starting Compose.

The Linux host network plus explicit `127.0.0.1:19702` listener lets the service
verify the immediate proxy peer before trusting its overwritten forwarded IP.
Do not publish this listener on a public interface. Install `nginx-http.conf` as `/etc/nginx/conf.d/relay-v1.0.2.conf` and include
`nginx-location.conf` as `/etc/nginx/relay-v1.0.2-location.conf` in the existing remote server after the container passes
its health check. Keep the existing v1.0.1 includes. The new version uses independent admission zones.
The new location accepts the existing explicit WAF origin
ranges and loopback; direct origin requests from other peers receive 403.
Forwarded client IPs are recursively resolved only for those trusted WAF
peers. Keep the range list synchronized with the WAF control plane. Raise
`worker_connections` to 8192 and retain a file descriptor limit of at least
16384; validate with `nginx -t` before a graceful reload.

Published Pages use the existing official Relay address:
`https://remote.openbitfun.com/v/1.0.2/p/{github_username}/{slug}`.
Compose sets this public base URL and the separate sign-in base URL
`https://auth.openbitfun.com/v/1.0.2`. Users do not configure domains.
Install the versioned Pages sign-in locations from
[`nginx-auth.openbitfun.com.conf`](../miniapp-market/nginx-auth.openbitfun.com.conf)
in the existing auth server as well. Keep its marketplace sign-in routes intact.
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
