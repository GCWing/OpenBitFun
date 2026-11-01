# OpenBitFun MiniApp Market Service

这里是 MiniApp 市场后端的主要业务实现。Axum 可执行入口位于
`../../../apps/miniapp-market-server/`，生产部署文件位于
`../../../../deploy/miniapp-market/`。

## 给 AI Agent 的最短指引

1. 先阅读仓库根 `AGENTS.md`、上级 `src/crates/services/AGENTS.md`、
   [Server README](../../../apps/miniapp-market-server/README.md) 和
   [部署手册](../../../../deploy/miniapp-market/README.md)。
2. 本 crate 负责具体 SQLite、文件存储、GitHub OAuth、包校验和市场 HTTP
   路由。纯 DTO、状态机和策略属于
   `../../contracts/product-domains/src/miniapp/market.rs`。
3. 不要让 Services 依赖 UI、桌面 command、Assembly 或其他上层产品入口。
4. API 前缀、DTO、分页和错误 envelope 是 Web 与桌面共享的稳定契约；变化时
   必须同步消费者和测试。
5. 安全约束不是可选功能。不得放宽 OAuth state/PKCE、CSRF、token 轮换、管理员
   数字 ID、包白名单、zip 限制、市场展示图重编码、hash 绑定或审计规则来绕过失败。
6. 不读取、输出或提交生产 secret、Cookie、token、包内容或个人 IP。
7. 生产发布只能来自明确 commit，并按部署手册先备份、后构建、再验证 revision。

## 文件地图

| 文件 | 所有权 |
| --- | --- |
| `src/lib.rs` | 装配数据库、artifact store、认证、API 和静态网页 |
| `src/routes.rs` | `/miniapp/api/v1` 路由、请求/响应和事务流程 |
| `src/auth.rs` | GitHub Web OAuth、桌面授权事务、session 和 token |
| `src/db.rs` | SQLite WAL、查询、唯一性和审核事务 |
| `src/package.rs` | `.bfminiapp` ZIP、Node/npm/ESM、大小和市场展示图验证 |
| `src/artifacts.rs` | SHA-256 内容寻址持久化 |
| `src/retention.rs` | 草稿、驳回和撤回 artifact 清理 |
| `src/error.rs` | 统一 API 错误 envelope |
| `src/request_id.rs` | request ID |
| `src/config.rs` | 环境变量和生产/开发配置 |
| `migrations/` | 编号 SQLite schema migration |

## 不变量

- 公开 API 固定在 `/miniapp/api/v1`。
- 列表响应保持 `{items,nextCursor}`。
- 错误保持 `{error:{code,message,requestId,details?}}`。
- 投稿状态保持 `draft → submitted → approved | rejected | withdrawn`；批准的
  release 可被永久 yank。
- Release 不可变，新版本审核期间继续提供旧的已批准版本。
- 新 release 可由 listing 原始发布者或当前管理员提交；listing 的
  `owner_user_id` 始终保留首次发布者，不随管理员代发更新而变化。
- 批准必须原子绑定 package hash、市场展示图 hash、规范化 metadata 和
  `review_bundle_hash`。
- 市场展示图 URL 无 query 时保持规范化原图兼容；只允许 `compact-v1`（最大边 640px）
  和 `large-v1`（最大边 1280px）两个有界变体。变体按需生成到原图旁，不进入
  审核 hash，删除原图时必须同步删除变体。
- 市场包只能包含协议白名单文件，必须拒绝 Node、npm、非空 ESM、zip-slip、
  link、重复/大小写冲突路径和超限解压。
- GitHub token 只用于读取公开 `{id,login,avatar_url}`，随后丢弃，不能下发给
  Web 或桌面客户端。
- 本服务是 MiniApp、Skin 和远控共用的 GitHub 身份权威，通过 `auth.openbitfun.com`
  提供统一入口。Web 和桌面 OAuth 完成都为
  `/miniapp` 与 `/skin` 签发同一服务端 session 的独立 Path-scoped Cookie；Skin
  不保存 OAuth secret，退出登录必须撤销 session 并清除两组 Cookie。
- 管理员身份每次请求按 GitHub 数字 ID 计算，不能依赖客户端声明。
- `MARKET_WEB_SUBMISSIONS_ENABLED=false` 时，所有投稿写路由会在读取请求体前
  拒绝 Web Cookie 会话；Desktop Bearer 投稿、投稿历史读取和 Web 管理员审核
  保持可用。UI 隐藏不是这一边界的替代品。

## 全局身份入口资源限制

GitHub 授权启动与回调分别限制为每分钟 300 次，避免启动请求挤占完成授权的容量；
认证请求最多并发 128 个，POST body 上限 16 KiB，读取期限 10 秒、处理期限 45 秒。
GitHub HTTP 连接 / 总期限为 10 / 20 秒，单个 JSON 响应不超过 64 KiB。
公开部署还需按真实来源配置反向代理限流和上游防护，不能把所有 Relay 代理用户
误识别成同一个终端 IP。

待完成 OAuth flow 和未过期桌面授权事务各有 8,192 条数据库原子上限；桌面事务
与对应 OAuth flow 一起提交，拒绝新授权时不会留下半条记录。每五分钟清理过期
认证状态，桌面授权事务在过期后一小时删除。用户、投稿和其他产品数据不在此清理
范围内；尚未过期的已撤销 refresh token 继续保留，用于发现重放并撤销令牌族。

## 当前投稿入口与鉴权矩阵

生产默认 `MARKET_WEB_SUBMISSIONS_ENABLED=false`。该开关只控制普通用户的投稿
写入，不控制目录、评分收藏、只读投稿历史或管理员审核：

| 请求面 | Web Cookie | Desktop Bearer | 开关关闭时 |
| --- | --- | --- | --- |
| 公开目录、详情、下载 | 可选登录 | 可选登录 | 不变 |
| 评分与收藏 | 登录并校验 CSRF | 登录 | 不变 |
| `GET /submissions`、`GET /submissions/{id}` | 登录 | 登录 | 保持可读 |
| `POST /submissions`、包/市场展示图 PUT/DELETE、submit、withdraw | 登录并校验 CSRF | 登录 | Web 在读取 body 前返回 `403 web_submissions_disabled`；Desktop 保持可写 |
| `/admin/*` 审核和下架 | 管理员登录并校验 CSRF | 管理员登录 | 不受该开关影响 |

匿名或无效凭据的投稿写请求仍先返回 `401 unauthorized`。未来重新开放 Web 投稿时，
必须显式设置环境变量、recreate 容器，并重新验证 CSRF、上传大小、恶意包拒绝和
所有投稿状态转换；不得仅修改前端显示条件。

## 本地验证

在仓库根目录运行：

```bash
pnpm run fmt:rs
cargo test -p openbitfun-miniapp-market-service
cargo check -p openbitfun-miniapp-market-server
cargo check --workspace
```

领域 DTO 或状态机变化再运行：

```bash
cargo test -p openbitfun-product-domains --features miniapp
pnpm run type-check:miniapp-market
pnpm run test:miniapp-market
```

按改动补 focused tests，至少覆盖相应拒绝或回滚路径。包校验、OAuth、权限、批准、
yank、上传和 migration 变化不能只测试成功路径。

## Migration 规则

`migrations/0001_init.sql` 已进入生产，不得原地修改。新增 schema 时：

1. 新增下一个编号 migration；
2. 更新 migration runner，按编号、事务化、只执行一次；
3. 用已有旧 schema 数据库测试升级；
4. 验证重复启动幂等；
5. 在部署说明中写明旧 binary 是否仍兼容；
6. 发布前运行一致性备份和恢复演练。

不兼容 migration 不能依靠“切回旧镜像”回滚。恢复生产备份会丢失备份时间点之后
的数据，必须先取得人工确认并制定数据恢复方案。

## 发布

此 crate 被 `openbitfun-miniapp-market-server` 编译进与网页相同的 Docker 镜像。
不要在生产服务器直接执行 `cargo run`，不要手工替换 binary，也不要直接编辑
SQLite/artifacts。完整流程见
[部署手册](../../../../deploy/miniapp-market/README.md)。

## 邮箱验证码登录

统一登录页提供两个独立入口：GitHub OAuth 和邮箱验证码。首次验证邮箱后创建独立
账号；不创建密码，不按邮箱或昵称自动绑定、合并 GitHub 账号。跨设备必须使用同一种
登录方式和同一个账号。

新版客户端向 `POST /auth/desktop/start?methods=all` 请求统一登录页，继续使用原有
事务 secret 和一次性轮询 token。未携带该参数的旧客户端仍直接收到 GitHub OAuth
URL。Relay 的旧命名 `/api/auth/github/start` 同样仅在 `methods=all` 时转发新能力。
旧服务器忽略该参数时保留原 GitHub 路径，不向旧客户端发放邮箱身份。

`POST /auth/login/start` 创建浏览器授权票据；`POST /auth/login/github` 选择 GitHub；
`POST /auth/email/send` 发码，`POST /auth/email/verify` 验码。邮箱地址按 ASCII 小写
规范化，不删除加号标签或点。固定八位随机数字验证码十分钟有效，单次最多五次尝试，只存
基于 session secret 的 HMAC 摘要。每个邮箱滚动六十秒最多两次、滚动二十四小时最多二十次，
跨设备共享；服务器整体一分钟三百封、不设每日总量上限，发送失败也计入配额。
发送记录保留一天，配额跨重启有效。
只接受八位数字，不兼容旧六位验证码；部署后旧验证码需重新获取。
SMTP 错误不得包含地址、凭据或验证码。认证接口保留 body、并发、期限和全局限流。

浏览器授权票据与设备轮询 secret 分离。邮箱验证完成后使用六十秒、一次性 grant
在市场 origin 建立 host-only Cookie；不在 URL 中传输长期 session 或 API token。

新增 migration 0002 保留旧 users 内部 ID、会话和产品外键，将 github_id 改为可空。
`/me` 增加可选 `accountId`：GitHub 用户保持原数字 ID 字符串，邮箱用户为独立
`email-<internal-id>` 命名空间。兼容字段 `githubId=0` 表示没有 GitHub 身份，不是
合成 GitHub ID；旧消费者必须拒绝该身份。管理员仍仅由正数 GitHub ID 决定。
已产生邮箱用户后不得回滚到旧 binary；应向前修复，恢复备份需单独的数据恢复决策。

发信使用 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURITY`（ssl/starttls）、`SMTP_USERNAME`、
`SMTP_PASSWORD` 和可选 `SMTP_FROM_NAME`。默认阿里企业邮箱 TLS 主机
`smtp.qiye.aliyun.com:465`，不允许关闭证书验证。未配置密码时只关闭邮箱入口，
`/config` 和 `/health` 的 `emailAuthConfigured` 明确报告能力。

重点回归：`cargo test -p openbitfun-miniapp-market-service --lib email_`。

The verification email uses `src/email/sign-in.html` as a multipart/alternative
HTML body with a complete UTF-8 plain-text fallback. Layout uses presentation
tables, inline styles and system fonts; the six digits stay selectable text.
Media queries add compact spacing and dark-mode colors without being required
for readability. There are no scripts, forms, tracking pixels or recipient data
in image URLs. The HTML branch is multipart/related with the original application
PNG embedded as an inline CID resource (`src/email/app-icon.png`). It does not
require external image downloads. The brand generator owns this byte-identical
copy of the application icon; do not recolor it or add a CSS placeholder background.
The market web build publishes the same icon separately for the sign-in page.

Email clients cannot consume CSS variables or theme packages. The template's
small inline palette is an email-specific snapshot of the existing OpenBitFun
reference scales: neutral 0/70/75/200/350/650/800/850/900/950/1000 and cyan 500 from
`design-system/packages/theme-openbitfun/src/reference.tokens.json`. Preserve
those source mappings when updating the template; do not add a separate brand
palette. Check the HTML at 390px and desktop widths in light and dark mode,
then run `cargo test -p openbitfun-miniapp-market-service --lib email_auth::tests`
and a real message render check after SMTP/template changes.

Marketplace author labels are public: email accounts display their full verified
email address in listing owners and moderation submitters. The authenticated
`/me` profile keeps its legacy `user.login` protocol handle and exposes the
verified address separately as `email`; older relays require that handle format.
Skin uses the separate email for its public author projection. GitHub
accounts retain their GitHub login. Ownership and authorization use internal IDs,
never the displayed label; this does not link email and GitHub accounts.
