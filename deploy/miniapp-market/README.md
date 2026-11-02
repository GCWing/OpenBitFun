# OpenBitFun MiniApp Market 自建部署手册

这份 Runbook 用于在自建 Linux 主机上部署和更新 MiniApp 市场网页与后端。它同时
面向人工操作和 AI Agent，命令默认从 OpenBitFun 仓库根目录执行。

> 本文是社区自部署模板。`$DEPLOY_HOST`、`market.example.com`、`auth.example.com`
> 以及 `/srv/openbitfun-miniapp-market`、`/etc/openbitfun-miniapp-market` 等路径都是
> 示例，请替换为你自己的 SSH 主机、域名和目录。开始前先在当前 shell 设置：
>
> ```bash
> DEPLOY_HOST=root@your-server
> ```
>
> 官方托管服务的配置不在本仓库中。

相关源码说明：

- [网页源码 README](../../src/miniapp-market-web/README.md)
- [后端入口 README](../../src/apps/miniapp-market-server/README.md)
- [后端业务 README](../../src/crates/services/miniapp-market-service/README.md)

## 最短答案

MiniApp 市场网页源码在 `src/miniapp-market-web/`，后端入口在
`src/apps/miniapp-market-server/`，后端业务实现在
`src/crates/services/miniapp-market-service/`。

网页和后端由 `src/apps/miniapp-market-server/Dockerfile` 打进同一个镜像。
因此只改网页、只改后端、或前后端一起改，部署动作相同：

1. 本地检查并提交一个明确 Git commit；
2. 验证或创建部署前备份；
3. 把该 commit 推到服务器专用 `market-deploy` ref；
4. 服务器 checkout 该 commit，构建新镜像；
5. 重建 `openbitfun-miniapp-market` 容器；
6. 核对健康状态、镜像 revision 和公网 URL；
7. 失败时回到上一个 commit，不能用 `git clean` 或 `git reset --hard`。

不要单独上传 `dist/`，也不要在服务器上直接改源码。

Skin 市场复用本服务的 GitHub OAuth、桌面 token 和 Web 会话别名。修改
`miniapp-market-service/src/auth.rs`、`routes.rs` 或 OAuth 回跳参数时，必须同时
验证 Skin 的“我的投稿”和“审核”接口；Skin 容器只能通过它自己的部署手册和
专用 checkout 更新，不能从 MiniApp Compose 项目重建。

## 部署边界

本目录只能部署 MiniApp 市场。如果同一主机上还运行 Relay、官网或其他服务，不要
修改、清理或重启它们的 Nginx vhost/container。

市场使用独立 checkout `/srv/openbitfun-miniapp-market/app`。任何部署都不得在其他
服务的 checkout 中运行 `git clean`、`git reset --hard`、强制 checkout 或部署脚本。

## 部署事实

| 项目 | 值 |
| --- | --- |
| SSH | `ssh "$DEPLOY_HOST"`（设为你的部署主机） |
| 公网地址 | `https://market.example.com/miniapp/` |
| API | `https://market.example.com/miniapp/api/v1` |
| OAuth callback | `https://auth.example.com/api/v1/auth/github/callback` |
| 专用 checkout | `/srv/openbitfun-miniapp-market/app` |
| SQLite | `/srv/openbitfun-miniapp-market/data/market.sqlite` |
| packages/screenshots | `/srv/openbitfun-miniapp-market/artifacts` |
| backups | `/srv/openbitfun-miniapp-market/backups` |
| secrets | `/etc/openbitfun-miniapp-market/market.env`，`root:root`、`0600` |
| 容器 | `openbitfun-miniapp-market` |
| 监听 | 仅宿主 `127.0.0.1:9710` |
| Nginx vhost | `/etc/nginx/sites-available/market.example.com.conf` |
| Nginx 未知 Host 兜底 | `/etc/nginx/sites-available/00-default-server.conf` |
| 部署 ref | `refs/heads/market-deploy` |

容器以 UID/GID `10001` 非 root、read-only filesystem、drop all
capabilities 方式运行。数据和 artifacts 通过独立宿主目录持久化。

## AI Agent 发布契约

执行发布的 Agent 必须遵守：

1. 先读仓库根 `AGENTS.md`、对应源码 README 和本文件。
2. 先运行 `git status --short`。不得覆盖或提交用户的无关改动。
3. 只部署已提交的明确 commit；不从 dirty worktree 构建，不部署浮动分支名。
4. 不读取、复制、输出 `/etc/openbitfun-miniapp-market/market.env` 内容。
5. 不记录 token、Cookie、请求 body、包内容或个人 IP。
6. 发布前记录旧 commit；数据库相关变更先验证备份。
7. 不修改同一主机上的其他服务或它们的 Nginx/container。
8. 每个外部写操作后做只读验证。任何验证失败立即停止，不连续尝试破坏性修复。
9. 只有容器 healthy、镜像 revision 等于目标 commit、公网健康检查通过，才可以
   报告“部署成功”。
10. schema 变更回滚、数据恢复或 OAuth 配置不明确时，停止并请求人工确认，
    不猜测。

下面步骤中的 `DEPLOY_COMMIT`、`PREVIOUS_COMMIT` 等变量保存在本地 shell。应在
同一个终端依次完成发布；新开终端后必须重新计算并核对，不能留空继续执行。

## 1. 判断改动类型并完成本地检查

先查看未提交改动：

```bash
git status --short
git diff --check
git diff --name-only HEAD
```

未提交文件只用于检查；发布前必须把本任务改动提交成一个明确 commit。不要顺手
提交工作区中的无关文件。

按改动选择最小验证：

| 改动 | 发布前验证 |
| --- | --- |
| 仅 `src/miniapp-market-web/` | `pnpm run type-check:miniapp-market && pnpm run test:miniapp-market && pnpm run build:miniapp-market` |
| 后端 Services/入口 | `pnpm run fmt:rs && cargo test -p openbitfun-miniapp-market-service && cargo check -p openbitfun-miniapp-market-server && cargo check --workspace` |
| 领域 DTO/状态机 | 上述 Rust 检查，再加 `cargo test -p openbitfun-product-domains --features miniapp` 和前端检查 |
| Docker/Compose | 对应代码检查，再做本地 Docker build |
| i18n 文案/契约 | 前端检查，再加 `pnpm run i18n:contract:test && pnpm run i18n:audit` |
| 颜色/token | 对应前端检查，再加 `pnpm run theme:color-audit:all` |

验证通过后只 stage 本任务的明确文件，不使用 `git add .`：

```bash
git add <本任务文件路径...>
git diff --cached --check
git diff --cached --stat
git commit -m "<清楚描述本次市场改动>"
```

记录要部署的 commit，并确认它包含预期改动：

```bash
DEPLOY_COMMIT="$(git rev-parse HEAD)"
git show --stat --oneline "$DEPLOY_COMMIT"
git status --short
```

如果最后一条仍有属于本任务的未提交改动，停止；它们不会进入部署镜像。

## 2. 只读检查当前部署状态

```bash
ssh "$DEPLOY_HOST" 'set -eu
git -C /srv/openbitfun-miniapp-market/app status --short
git -C /srv/openbitfun-miniapp-market/app rev-parse HEAD
docker inspect --format "{{.Config.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}" openbitfun-miniapp-market
docker inspect --format "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" openbitfun-miniapp-market
curl -fsS http://127.0.0.1:9710/miniapp/api/v1/health
stat -c "%U:%G %a %n" /etc/openbitfun-miniapp-market/market.env'
```

预期：

- 专用 checkout 没有输出 dirty 文件；
- 容器是 `running healthy`；
- checkout HEAD、镜像 tag 和 image revision 一致；
- health 返回 `"status":"ok"` 和 `"database":true`；
- secret 文件是 `root:root 600`。

保存旧 commit，供失败回滚：

```bash
PREVIOUS_COMMIT="$(
  ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-miniapp-market/app rev-parse HEAD'
)"
```

## 3. 验证部署前备份

只改纯前端时数据库 schema 不变，但仍应确认自动备份 timer 正常。后端、
migration、包存储或审核流程变更必须在发布前拥有当天的一致性备份。

```bash
ssh "$DEPLOY_HOST" 'set -eu
systemctl is-enabled openbitfun-miniapp-market-backup.timer
systemctl is-active openbitfun-miniapp-market-backup.timer
today="$(date -u +%F)"
target="/srv/openbitfun-miniapp-market/backups/daily/${today}"
if [ -d "$target" ]; then
  (cd "$target" && sha256sum -c SHA256SUMS)
  test "$(sqlite3 "$target/market.sqlite" "PRAGMA integrity_check;")" = "ok"
else
  /usr/local/sbin/openbitfun-miniapp-market-backup
fi'
```

`backup.sh` 会用 SQLite `.backup`、校验 `PRAGMA integrity_check`，并保存
artifacts 快照。它会拒绝覆盖同一天已有备份。

涉及 migration 或高风险存储改动时，再对最新备份做一次恢复演练：

```bash
ssh "$DEPLOY_HOST" 'set -eu
latest="$(find /srv/openbitfun-miniapp-market/backups/daily \
  -mindepth 1 -maxdepth 1 -type d -print | sort | tail -n 1)"
test -n "$latest"
/usr/local/sbin/openbitfun-miniapp-market-restore-drill "$latest"'
```

同机备份不等于异地灾备。不要把“备份存在”描述成完整灾备。

## 4. 把精确 commit 送到专用 checkout

部署 ref 只用于这个市场 checkout。使用 `--force-with-lease` 防止覆盖未知的并发
发布，不使用无条件 `--force`。

```bash
REMOTE_REF_COMMIT="$(
  ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-miniapp-market/app \
    rev-parse refs/heads/market-deploy'
)"

git push \
  --force-with-lease="refs/heads/market-deploy:${REMOTE_REF_COMMIT}" \
  ssh://$DEPLOY_HOST/srv/openbitfun-miniapp-market/app \
  "${DEPLOY_COMMIT}:refs/heads/market-deploy"
```

如果 lease 失败，表示另一个发布修改了服务器 ref。停止并重新检查部署状态，不要
改成无条件 force。

确认服务器专用 checkout 干净后切到目标 commit：

```bash
ssh "$DEPLOY_HOST" "set -eu
test -z \"\$(git -C /srv/openbitfun-miniapp-market/app status --porcelain)\"
git -C /srv/openbitfun-miniapp-market/app checkout --detach '$DEPLOY_COMMIT'
test \"\$(git -C /srv/openbitfun-miniapp-market/app rev-parse HEAD)\" = '$DEPLOY_COMMIT'"
```

这里禁止运行 `git clean` 或 `git reset --hard`。

## 5. 构建并替换市场容器

构建期间旧容器继续服务。只有镜像构建成功后才 recreate：

```bash
ssh "$DEPLOY_HOST" "set -eu
cd /srv/openbitfun-miniapp-market/app
test \"\$(git rev-parse HEAD)\" = '$DEPLOY_COMMIT'
export MARKET_GIT_COMMIT='$DEPLOY_COMMIT'
docker compose -f deploy/miniapp-market/docker-compose.yml build miniapp-market
docker compose -f deploy/miniapp-market/docker-compose.yml \
  up -d --no-build --force-recreate miniapp-market"
```

前端会在 Docker `web-builder` 阶段构建；后端会在 `rust-builder` 阶段构建。
两者都来自同一个 `$DEPLOY_COMMIT`。

## 6. 验证发布

等待 Compose healthcheck 变成 `healthy`：

```bash
ssh "$DEPLOY_HOST" 'set -eu
for attempt in $(seq 1 30); do
  status="$(
    docker inspect --format \
      "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" \
      openbitfun-miniapp-market
  )"
  [ "$status" = "healthy" ] && exit 0
  sleep 2
done
docker inspect --format "{{json .State}}" openbitfun-miniapp-market
exit 1'
```

核对镜像确实来自目标 commit：

```bash
DEPLOYED_COMMIT="$(
  ssh "$DEPLOY_HOST" 'docker inspect --format \
    "{{index .Config.Labels \"org.opencontainers.image.revision\"}}" \
    openbitfun-miniapp-market'
)"
test "$DEPLOYED_COMMIT" = "$DEPLOY_COMMIT"
```

检查 origin 和公网：

```bash
ssh "$DEPLOY_HOST" 'curl -fsS http://127.0.0.1:9710/miniapp/api/v1/health'
curl -fsS https://market.example.com/miniapp/api/v1/health
curl -fsS https://market.example.com/miniapp/api/v1/config
curl -fsS https://market.example.com/miniapp/ >/dev/null
```

`/config` 应返回 `"webSubmissionsEnabled":false`。此开关关闭时，Web
投稿写请求由后端拒绝，网页仅保留“我的投稿”历史；OpenBitFun Desktop 的 Bearer
投稿和 Web 管理员审核继续可用。未来重新开放网页投稿时，必须先完成对应安全
回归，再显式修改 root-only `market.env` 并仅 recreate 市场容器。
环境变量缺失时后端也默认关闭，但 `market.env` 应显式保留
`MARKET_WEB_SUBMISSIONS_ENABLED=false`，避免后续运维人员误判当前策略。

再用浏览器人工检查：

- `/miniapp/` 能加载，刷新子页面不会 404；
- `MARKET_PUBLIC_BROWSE=false` 时匿名目录按预期关闭；
- `MARKET_WEB_SUBMISSIONS_ENABLED=false` 时投稿/更新/撤回按钮不可见，直接访问
  `/miniapp/submit` 提示改用 OpenBitFun Desktop，“我的投稿”仍可读取；
- OAuth 已配置时，GitHub 登录 callback 正常；
- 与本次改动有关的浏览、下载、投稿、审核、安装或更新流程正常；
- 同一主机上的其他服务仍可用，且它们的容器/vhost 没被重启或改写。

查看最近日志时只读有限行数，不把完整运行日志复制到公开位置：

```bash
ssh "$DEPLOY_HOST" 'docker logs --since 10m --tail 200 openbitfun-miniapp-market'
```

## 7. 只有 Nginx 文件变化时才更新 Nginx

普通前后端发布不需要改 Nginx。先检查目标 commit 是否修改了：

- `deploy/miniapp-market/nginx-default-server.conf`
- `deploy/miniapp-market/nginx-log-format.conf`
- `deploy/miniapp-market/nginx-market.conf`（模板文件名，安装时改成你的域名）

确有修改时才安装市场专用文件：

```bash
ssh "$DEPLOY_HOST" 'set -eu
install -m 0644 \
  /srv/openbitfun-miniapp-market/app/deploy/miniapp-market/nginx-default-server.conf \
  /etc/nginx/sites-available/00-default-server.conf
ln -sfn \
  /etc/nginx/sites-available/00-default-server.conf \
  /etc/nginx/sites-enabled/00-default-server.conf
install -m 0644 \
  /srv/openbitfun-miniapp-market/app/deploy/miniapp-market/nginx-log-format.conf \
  /etc/nginx/conf.d/miniapp-market-log-format.conf
install -m 0644 \
  /srv/openbitfun-miniapp-market/app/deploy/miniapp-market/nginx-market.conf \
  /etc/nginx/sites-available/market.example.com.conf
nginx -t
systemctl reload nginx'
```

必须让 `nginx -t` 成功后才能 reload。不要编辑或重载其他产品的 vhost。市场
vhost 的上传上限是 25 MiB；访问日志刻意不记录 IP、query、Cookie、body 或
Authorization。

`nginx-default-server.conf` 是服务器级安全兜底，不代理任何产品。如果你的 DNS/WAF
会让未显式配置的子域名也到达源站，这个 `default_server` 必须返回 404，避免未知
Host 因 Nginx 加载顺序落到同一主机上的其他服务或市场。新增 vhost 后至少验证：

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Host: unconfigured.example.com" http://127.0.0.1/
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  -H "Host: market.example.com" http://127.0.0.1/
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://unconfigured.example.com/
```

预期依次为 `404`、跳转到
`https://market.example.com/miniapp/`、`404`。不要用真实但尚未发布的
产品域名做探针，避免以后与新 vhost 冲突。

## 8. 回滚

纯前端或兼容后端故障可以回滚到部署前保存的 `$PREVIOUS_COMMIT`：

```bash
ssh "$DEPLOY_HOST" "set -eu
test -n '$PREVIOUS_COMMIT'
test -z \"\$(git -C /srv/openbitfun-miniapp-market/app status --porcelain)\"
git -C /srv/openbitfun-miniapp-market/app checkout --detach '$PREVIOUS_COMMIT'
cd /srv/openbitfun-miniapp-market/app
export MARKET_GIT_COMMIT='$PREVIOUS_COMMIT'
if ! docker image inspect \"openbitfun-miniapp-market:$PREVIOUS_COMMIT\" >/dev/null 2>&1; then
  docker compose -f deploy/miniapp-market/docker-compose.yml build miniapp-market
fi
docker compose -f deploy/miniapp-market/docker-compose.yml \
  up -d --no-build --force-recreate miniapp-market"
```

然后重复“验证发布”，并确认 image revision 等于 `$PREVIOUS_COMMIT`。

容器恢复后把服务器部署 ref 同步回旧 commit，仍使用 lease：

```bash
ROLLBACK_REF_COMMIT="$(
  ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-miniapp-market/app \
    rev-parse refs/heads/market-deploy'
)"
git push \
  --force-with-lease="refs/heads/market-deploy:${ROLLBACK_REF_COMMIT}" \
  ssh://$DEPLOY_HOST/srv/openbitfun-miniapp-market/app \
  "${PREVIOUS_COMMIT}:refs/heads/market-deploy"
```

如果新版本已经执行不向后兼容的 migration，不得直接运行旧 binary，也不得自动
恢复数据库备份。恢复会丢失备份之后的投稿、审核、评分和下载数据；必须先停止并
制定数据迁移/恢复方案。Nginx 有改动时也要从旧 commit 恢复市场专用配置，
`nginx -t` 后再 reload。

## 修改运行配置

实际配置只在 `/etc/openbitfun-miniapp-market/market.env`。只能在服务器本地用受控
编辑器修改，不能 `cat`、下载或提交：

```bash
ssh -t "$DEPLOY_HOST" 'umask 077; vi /etc/openbitfun-miniapp-market/market.env'
ssh "$DEPLOY_HOST" 'stat -c "%U:%G %a %n" /etc/openbitfun-miniapp-market/market.env'
```

配置变化后，用当前 checkout commit recreate 容器：

```bash
CURRENT_COMMIT="$(
  ssh "$DEPLOY_HOST" 'git -C /srv/openbitfun-miniapp-market/app rev-parse HEAD'
)"
ssh "$DEPLOY_HOST" "set -eu
cd /srv/openbitfun-miniapp-market/app
export MARKET_GIT_COMMIT='$CURRENT_COMMIT'
docker compose -f deploy/miniapp-market/docker-compose.yml \
  up -d --no-build --force-recreate miniapp-market"
```

### GitHub OAuth 配置

GitHub OAuth App callback 必须精确为：

`https://auth.example.com/api/v1/auth/github/callback`

统一登录部署需在 `market.env` 中设置同一地址：

```bash
MARKET_GITHUB_CALLBACK_URL=https://auth.example.com/api/v1/auth/github/callback
```

桌面登录页和完成页会使用该回调 URL 的 origin；未设置时使用
`MARKET_PUBLIC_BASE_URL` 的 origin。GitHub OAuth App 的 callback 必须与
`MARKET_GITHUB_CALLBACK_URL` 完全一致。

创建或复用 OAuth App 时的实操要点：

- OAuth App 在 GitHub → Settings → Developer settings → OAuth Apps 下创建，
  没有对应的管理 API，只能人工在网页操作。创建表单支持 URL 预填：
  `https://github.com/settings/applications/new?oauth_application[name]=...&oauth_application[url]=...&oauth_application[callback_url]=...`
- Client Secret 只在生成那一刻显示一次，之后无法再查看。已有 App 拿不回旧
  secret 时，直接在原 App 上 "Generate a new client secret"，不需要新建 App。
- 凭据按上文流程用受控编辑器写入 `market.env`，然后 recreate 容器。不要把
  secret 以命令行参数形式传给脚本——它会进入 shell history 和进程列表。

配置生效的只读验证：

```bash
curl -fsS https://market.example.com/miniapp/api/v1/health
# 预期包含 "githubAuthConfigured":true

curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" \
  https://market.example.com/miniapp/api/v1/auth/github/start
# 预期 307，跳转 github.com/login/oauth/authorize，
# 且 client_id、redirect_uri 与注册的 App 一致
```

排错提示：浏览器登录入口是 `/auth/github/start`，不存在 `/auth/github/login`
这类路径。旧版本中未匹配的 `/miniapp/api/v1/*` 路径会落到 SPA 返回
200 + HTML，容易误判成"接口存在但行为异常"；新版本已改为返回标准
404 JSON 错误信封。

### 初次开放市场

初次开放市场时保持 `MARKET_PUBLIC_BROWSE=false`，先由管理员 GitHub ID
`<your-github-id>` 登录、上传并批准样例，再用全新桌面客户端验证安装和手动更新。
全部通过后才可改为 `true` 并 recreate。审批完成不代表用户自动授予 MiniApp
权限。

## 首次安装或运维文件变化

新服务器首次部署还需要：

1. 创建 `data`、`artifacts`、`backups`，让前两者归 UID/GID `10001`；
2. 从 `market.env.example` 创建 root-only `market.env`，生成强随机 session
   secret，填 GitHub OAuth 凭据；
3. 安装市场专用 Nginx log format/vhost；
   同时安装 `nginx-default-server.conf`，让所有未知 Host fail closed；
4. 安装 `backup.sh`、`restore-drill.sh`、systemd service/timer；
5. 运行一次备份和恢复演练；
6. 以 `MARKET_PUBLIC_BROWSE=false` 完成部署验收后再开放。

已有安装不要重复初始化。更改备份脚本或 systemd 文件时，逐个安装对应文件，
运行 `systemctl daemon-reload`，手工验证一次，再确认 timer 是 enabled/active。

每日备份保留 14 份，周备份保留 8 份。备份脚本的删除范围已经限制在市场专用
backup root；不要放宽该保护。

## 统一 GitHub 登录入口

`https://auth.example.com` 是市场与远控共用的登录入口，桌面授权完成页为
`/complete`，身份 API 为 `/api/v1`。它复用本服务和数据库；不新增账号库。
安装同目录 `nginx-auth.conf`（模板文件名，安装时改成你的域名）前，
先确认该域名的 DNS、TLS/WAF 已覆盖，并配置你自己的可信 WAF 源网段。该配置只开放
登录、身份、token 生命周期和页面静态资源，不代理市场写接口。

GitHub OAuth App 的注册 callback 为
`https://auth.example.com/api/v1/auth/github/callback`。统一入口将 code/state 原样转交市场的兼容完成端点；只有市场
host 写入两组 host-only Cookie（`/miniapp` 与 `/skin`），然后桌面授权跳转到
独立完成页；不要通过 `Domain=.example.com` 扩大 Cookie 信任范围。桌面
poll token 仍受一次性 transaction secret 约束。旧市场 API 与旧完成页路径保留，
已有安装无需手动迁移。

发布顺序：先更新本服务及新增 auth vhost，验证 `/complete`、`/sign-in` 跳转、
匿名 `/api/v1/me` 返回 401、desktop start/poll 和旧市场 API；再发布使用新身份
API 的 Relay/客户端。两个市场各自的网页仍在所属 Compose 项目中构建发布。
回滚时先让新客户端/Relay 恢复旧 API，再撤回 auth vhost；不能让已发布客户端的
身份地址失效。旧 Relay 和已有市场业务数据均不在这个 vhost 的变更范围内。

统一 callback 迁移时，先部署 auth 回调路由和服务配置，再在 GitHub OAuth App
设置中添加上述精确 Redirect URI。设置更新前，新发起的登录暂时无法完成。
旧市场 callback 路由作为 Cookie 会话完成端点保留，不扩大 Cookie Domain。

## 邮箱验证码发布补充

邮箱登录与 GitHub 登录是独立账号，不自动绑定或合并。部署前需同时验证身份服务、
当前版本 Relay 和 Skin 身份消费者；保留旧 GitHub 数字账号及旧授权启动行为。
客户端使用 `methods=all` 主动选择统一登录页，旧客户端继续走原 GitHub URL。

SMTP 配置单独存放在 `/etc/openbitfun-miniapp-market/smtp.env`，root:root 0600，
Compose 以可选 env_file 加载；不要将其复制到 checkout，也不要打印内容。
使用现有企业邮箱的 SMTP 配置，变量参见后端 README。不要复制收件人列表、测试
主题或 BCC 等与认证发信无关的配置。发件配置更新后需重建容器，核对
`emailAuthConfigured=true`。真实收件验收只向操作者明确指定的地址发送。

`/sign-in` 改为统一登录网页；auth vhost 仅新增 `/config` 和指定 login/email API，
验证码完成后经一次性 grant 跳转至 market host 设置 Cookie。登录票据放在 fragment，
Nginx 日志必须继续只记录 `$uri`，不能记录验证码 body 或 grant query。

migration 0002 保留原用户 ID 和外键，但旧 binary 不认识邮箱用户；发布后不能把
回退镜像当作数据库回滚。先完成两个市场的一致性备份和恢复演练，保留旧镜像，
出现问题优先向前修复；不得未经确认恢复备份或丢弃新增用户。

### 登录语言与验证码邮件

各端打开 `https://auth.example.com/sign-in` 时通过 `locale` 查询参数传递当前界面语言。
认证页优先使用该参数，其次使用已保存的语言和浏览器语言；别名遵循共享 i18n contract。
发送验证码请求可携带 `locale`（`en-US`、`zh-CN` 或 `zh-TW`），邮件主题、HTML 和纯文本使用同一语言。
旧客户端省略该字段或传入未知值时默认发送英文邮件，不影响验证码和令牌协议。

### Same-host outbound SMTP relay

完整维护流程见 [自建发信服务维护手册](../outbound-mail/README.md)。

For a send-only Postfix relay on the auth server, set `SMTP_SECURITY=local`,
`SMTP_HOST` to its literal loopback/private IPv4 address, `SMTP_PORT` to the
private listener port, and `SMTP_USERNAME` to the sender address. Leave
`SMTP_PASSWORD` unset. This explicit mode does not send credentials or use TLS;
use it only over loopback or an isolated same-host Docker bridge. Public IPs,
DNS names, and supplied passwords are rejected. Existing `ssl`/`starttls`
configurations retain certificate validation and authenticated delivery.

Bind Postfix only to loopback and the auth bridge gateway; restrict `mynetworks`
to loopback and the auth container's exact address, with `permit_mynetworks,
reject` relay/client restrictions. Recheck the container address after deployment.
Do not expose SMTP through a public Docker port or WAF. Restrict envelope senders
to the owned sender domain (for example, `*@example.com`), sign all its sender
addresses with OpenDKIM, and keep `relayhost` empty for direct
MX delivery. Enable opportunistic TLS for outbound delivery, persistent queues,
and systemd startup ordering after Docker. Keep DKIM private keys and any SMTP
configuration under root-controlled server paths, outside the repository.

Before switching production auth, publish a matching A/PTR identity, add the
outbound IP to the existing SPF record (never create a second SPF record), publish
DKIM, and establish DMARC. Keep existing MX records when inbound email remains
with another provider. Verify real delivery and recipient authentication headers;
SMTP queue acceptance alone does not prove delivery to the inbox. Preserve the
previous SMTP configuration for rollback until the new route is verified.
