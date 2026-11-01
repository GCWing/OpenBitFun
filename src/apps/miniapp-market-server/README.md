# OpenBitFun MiniApp Market Server

这里是 MiniApp 市场 HTTP 服务的 Axum 入口。生产服务同时提供
`/miniapp/api/v1` API 和已经构建好的 MiniApp 市场网页。

> 最短结论：这个目录只负责启动、日志和 Docker 入口。大部分后端业务代码在
> [`src/crates/services/miniapp-market-service/`](../../crates/services/miniapp-market-service/README.md)，稳定领域类型在
> `src/crates/contracts/product-domains/src/miniapp/market.rs`。修改后端并
> 提交明确 Git commit 后，按照
> [部署手册](../../../deploy/miniapp-market/README.md)重建同一个容器。

## 给 AI Agent 的执行约束

1. 先阅读仓库根目录 `AGENTS.md`、本文件和
   [部署手册](../../../deploy/miniapp-market/README.md)。
2. 遵守分层边界：入口只装配服务；SQLite、文件、OAuth 和 HTTP 实现在
   Services；纯 DTO、状态机和策略放在 product-domains。
3. REST 前缀固定为 `/miniapp/api/v1`。列表和错误 envelope 是公开契约，
   修改时必须同步 Web、桌面客户端和契约测试。
4. 不得降低包校验、截图重编码、OAuth state/PKCE、CSRF、Cookie、安全响应
   头、管理员数字 ID、审计或 retention 约束来让测试通过。
5. 已在生产使用的 migration 不可重写。新增 schema 必须使用下一个编号迁移，
   事务化执行，并验证旧数据库升级。
6. 不要读取或输出生产 secret，不要手工修改生产 SQLite 或 artifacts。
7. Rust 改动必须格式化并通过相应测试。发布必须绑定明确 commit；健康检查和
   镜像 revision 不匹配时不得声称成功。

## 后端源码地图

| 位置 | 作用 |
| --- | --- |
| `src/main.rs` | 读取环境变量、JSON 日志、监听端口和优雅退出 |
| `Dockerfile` | 构建 React 网页、Rust release binary 和非 root 运行镜像 |
| `../../crates/services/miniapp-market-service/src/routes.rs` | 版本化 REST API |
| `../../crates/services/miniapp-market-service/src/auth.rs` | GitHub Web/桌面授权、会话和 token |
| `../../crates/services/miniapp-market-service/src/db.rs` | SQLite WAL、查询和事务 |
| `../../crates/services/miniapp-market-service/src/package.rs` | `.bfminiapp` 和截图安全验证 |
| `../../crates/services/miniapp-market-service/src/artifacts.rs` | SHA-256 内容寻址文件存储 |
| `../../crates/services/miniapp-market-service/src/retention.rs` | 草稿、驳回和撤回文件保留策略 |
| `../../crates/services/miniapp-market-service/migrations/` | 编号 SQLite migration |
| `../../crates/contracts/product-domains/src/miniapp/market.rs` | DTO、投稿状态机和市场领域事实 |
| `../../../deploy/miniapp-market/` | Compose、Nginx、备份和部署 Runbook |

## 本地运行

在仓库根目录先构建网页，再运行服务器：

```bash
pnpm run build:miniapp-market
cargo run -p openbitfun-miniapp-market-server
```

默认监听 `127.0.0.1:9710`，默认开发数据位于
`var/miniapp-market/`，网页来自 `src/miniapp-market-web/dist/`：

```bash
curl -fsS http://127.0.0.1:9710/miniapp/api/v1/health
curl -fsS http://127.0.0.1:9710/miniapp/api/v1/config
```

需要隔离测试数据时，使用专用临时目录；不要复用生产路径：

```bash
MARKET_DATABASE_PATH=/tmp/openbitfun-market-dev/market.sqlite \
MARKET_ARTIFACT_DIR=/tmp/openbitfun-market-dev/artifacts \
MARKET_SESSION_SECRET=development-only-change-me \
cargo run -p openbitfun-miniapp-market-server
```

开发默认 secret 不能用于 release 或生产。GitHub OAuth 未配置时，健康响应中的
`githubAuthConfigured` 为 `false`，登录功能不可用。

## 环境变量

示例环境变量见 `../../../deploy/miniapp-market/market.env.example`。实际值只
应存在服务器的 `/etc/openbitfun-miniapp-market/market.env`。

| 变量 | 作用 |
| --- | --- |
| `MARKET_BIND` | 服务监听地址；生产容器内为 `0.0.0.0:9710` |
| `MARKET_PUBLIC_BASE_URL` | 公开 base；例如 `https://market.example.com/miniapp` |
| `MARKET_DATABASE_PATH` | SQLite 文件 |
| `MARKET_ARTIFACT_DIR` | 内容寻址包和截图目录 |
| `MARKET_WEB_DIR` | 构建后的网页目录 |
| `MARKET_GITHUB_CALLBACK_URL` | 可选 OAuth 回调地址；未设置时由 `MARKET_PUBLIC_BASE_URL` 派生，桌面登录页和完成页使用该 URL 的 origin |
| `MARKET_GITHUB_CLIENT_ID` | GitHub OAuth App client ID |
| `MARKET_GITHUB_CLIENT_SECRET` | GitHub OAuth App secret |
| `MARKET_SESSION_SECRET` | 会话签名 secret，生产至少 24 字符并应使用强随机值 |
| `MARKET_ADMIN_GITHUB_IDS` | 逗号分隔的 GitHub 数字 ID；留空表示没有管理员 |
| `MARKET_PUBLIC_BROWSE` | 是否向匿名用户开放目录 |
| `MARKET_WEB_SUBMISSIONS_ENABLED` | 是否允许 Web Cookie 会话投稿；默认及生产为 `false`，Desktop Bearer 投稿不受影响 |
| `RUST_LOG` | 英文 JSON 日志过滤器 |

未设置 `MARKET_WEB_SUBMISSIONS_ENABLED` 时服务按 `false` 处理；它与
`MARKET_PUBLIC_BROWSE` 相互独立。生产修改该值需要仅 recreate 市场容器，并通过
`GET /miniapp/api/v1/config` 核对实际的 `webSubmissionsEnabled`，不能只根据
env 文件内容判断已经生效。

统一登录部署时，在 `market.env` 中设置 OAuth callback，例如
`MARKET_GITHUB_CALLBACK_URL=https://auth.example.com/api/v1/auth/github/callback`。
桌面登录页和完成页会使用该 URL 的 origin；未设置时使用
`MARKET_PUBLIC_BASE_URL` 的 origin。

## 修改后的最小验证

Rust 后端改动在仓库根目录运行：

```bash
pnpm run fmt:rs
cargo test -p openbitfun-miniapp-market-service
cargo check -p openbitfun-miniapp-market-server
cargo check --workspace
```

领域状态机或 DTO 改动再运行：

```bash
cargo test -p openbitfun-product-domains --features miniapp
pnpm run type-check:miniapp-market
pnpm run test:miniapp-market
```

Docker 或 Web 静态资源装配改动还要运行：

```bash
pnpm run build:miniapp-market
MARKET_GIT_COMMIT=local-verification \
  docker compose -f deploy/miniapp-market/docker-compose.yml build miniapp-market
```

测试至少覆盖改动对应的失败路径。包、OAuth、权限、批准/yank、上传或 migration
改动不能只验证成功路径。

## 数据库和文件规则

- SQLite 生产文件：`/srv/openbitfun-miniapp-market/data/market.sqlite`
- artifacts：`/srv/openbitfun-miniapp-market/artifacts`
- 两者都是持久数据，不包含在 Docker 镜像中。
- migration 在服务启动时执行，因此涉及 schema 的发布必须先完成一致性备份。
- 不要在服务运行时复制 SQLite 主文件当作备份；使用部署目录提供的 SQLite
  `.backup` 脚本。
- 不要直接删除 hash 文件。retention、批准、yank 和审核记录必须保持一致。

## 发布

生产 Docker 镜像包含这个 Rust binary 和
`src/miniapp-market-web/dist/`。前端、后端或两者更新都使用同一条精确 commit
发布链路。详见
[部署手册](../../../deploy/miniapp-market/README.md)。
