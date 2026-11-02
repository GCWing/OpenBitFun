# 自建发信服务维护手册

OpenBitFun 的验证码邮件可以通过同机 Postfix 直接投递给收件方 MX，
OpenDKIM 为邮件签名。不需要部署 IMAP、POP3、用户邮箱或公网收信入口。
认证服务负责生成验证码及本地化邮件模板；Postfix 负责签名接入、队列和投递。

```text
auth → 私有 SMTP → Postfix → 收件方 MX:25
                      ↕
                  OpenDKIM
```

本手册描述可复用的维护规则。实际 IP、路径、已部署版本和回滚文件只保存在你自己的
root-only 配置中，不要写进仓库。不要将 SMTP 密码、DKIM 私钥、验证码、
认证令牌或 env 文件复制到仓库。

## 网络与发信身份

- 同机进程可以通过 `127.0.0.1:25` 提交邮件，无需 SMTP 密码。
- 认证容器使用同机专用 Docker 网桥的宿主机地址；只授权该容器的确切 IP。
- Postfix 仅监听 loopback 和该网桥，不监听公网网卡，不发布公网 Docker SMTP 端口。
- 出站 TCP 25 必须能连接收件方 MX。WAF 处理入站 HTTP(S)，不代理出站 SMTP。
- 允许整个自有域名的发件人，例如 `hello@example.com`、`support@example.com`。
  新增同域发件地址无需创建本地邮箱。回复能否被接收，仍取决于已有收信服务。
- `mynetworks` 限制调用方，发件地址规则限制可使用的域名；不能仅靠发件域名防止开放中继。

## 认证服务接入

验证码接口的防滥用限制与 SMTP 服务商额度无关：同一邮箱每 60 秒一次、滚动
24 小时最多 20 封；全站每 60 秒最多 300 封，不设每日总量上限。发送失败也计数。
新验证码固定 8 位随机数字，每个验证码最多尝试 5 次，10 分钟有效。修改这些规则需更新认证服务并重新部署；
修改 Postfix 配置不会改变认证接口的限制。

在服务器的 SMTP env 文件中配置；私有模式示例：

```dotenv
SMTP_SECURITY=local
SMTP_HOST=172.19.0.1
SMTP_PORT=25
SMTP_USERNAME=hello@example.com
SMTP_PASSWORD=
SMTP_FROM_NAME=OpenBitFun
```

示例 IP 必须替换成该实例的实际网桥地址。`SMTP_USERNAME` 在此模式中是发件地址，
不是登录凭据。`local` 只接受私有 IPv4/loopback 地址字面量，并拒绝非空密码；
不得用于跨主机的不可信网络。远端 SMTP 保持使用 `ssl` 或 `starttls`，验证证书并认证。

变更 env 后，需要使用已部署的提交版本重新创建认证容器，仅 `docker restart`
不会加载更新后的 Compose env_file。参考 [MiniApp 部署手册](../miniapp-market/README.md)。
确认 `/miniapp/api/v1/health` 的 `emailAuthConfigured` 为 `true`。

`locale` 决定验证码邮件主题、HTML 与纯文本语言：`en-US`、`zh-CN`、`zh-TW`。
旧客户端省略或传入未知值时使用英文。自建 SMTP 不会取消应用层验证码限流。

## 初次部署与恢复

Ubuntu 可安装 `postfix opendkim opendkim-tools`。安装时先选择仅本地监听，
完成调用方和发件域名限制后再启用网桥接入。以下是必须核对的配置关系，
不能将示例 IP 原样用于其他服务器。

`/etc/postfix/main.cf` 的关键项目：

```ini
myhostname = outbound.example.com
myorigin = example.com
mydestination =
relayhost =
default_transport = smtp
relay_transport = relay
inet_protocols = ipv4
inet_interfaces = 127.0.0.1, 172.19.0.1
mynetworks = 127.0.0.0/8, 172.19.0.2/32
smtpd_client_restrictions = permit_mynetworks, reject
smtpd_relay_restrictions = permit_mynetworks, reject
smtpd_sender_restrictions = check_sender_access regexp:/etc/postfix/allowed_sender_domains, reject
smtpd_milters = inet:127.0.0.1:8891
non_smtpd_milters = inet:127.0.0.1:8891
milter_protocol = 6
milter_default_action = tempfail
smtp_tls_security_level = may
smtp_tls_CAfile = /etc/ssl/certs/ca-certificates.crt
disable_vrfy_command = yes
```

`Local only` 安装配置可能留下 `default_transport = error`，必须改为上述出站 transport。
`/etc/postfix/allowed_sender_domains` 使用精确的域名匹配：

```text
/^[^@[:space:]]+@example[.]com$/ OK
```

这是 `regexp:` 映射，修改后不运行 `postmap` 生成 hash 数据库，检查配置并 reload 即可。
其他域名不要加入此规则，除非已经完成该域名的所有权和发信验证。

`/etc/opendkim.conf` 的关键项目：

```text
Syslog yes
SyslogSuccess yes
UserID opendkim
PidFile /run/opendkim/opendkim.pid
UMask 007
Mode s
Canonicalization relaxed/relaxed
SignatureAlgorithm rsa-sha256
Socket inet:8891@127.0.0.1
KeyTable refile:/etc/opendkim/key.table
SigningTable refile:/etc/opendkim/signing.table
InternalHosts refile:/etc/opendkim/trusted.hosts
OversignHeaders From
```

`PidFile` 必须与发行版 systemd 单元一致，否则可能出现进程已运行但服务一直停留在
`activating`。签名表用 `*@example.com` 匹配整个域名。KeyTable 指向相应 selector
及私钥；InternalHosts 只列 loopback 和确切的认证容器地址。

私钥由 `opendkim-genkey -b 2048` 在服务器上生成，目录仅允许维护者/签名服务访问，
私钥为 `opendkim:opendkim`、`0600`。只将生成的 `.txt` 公钥发布到 DNS。
启用 `opendkim`、`postfix` 开机启动，并让 Postfix 的 systemd 启动顺序位于 Docker
和网络就绪之后。恢复服务器时先恢复网桥和签名文件，再启动邮件服务。

## DNS、换 IP 与密钥轮换

| 记录 | 作用 |
| --- | --- |
| `outbound` A | 指向实际出站公网 IP，不接入 WAF |
| 该公网 IP 的 PTR | 在云厂商反向解析中指向 `outbound.example.com` |
| 根域 TXT SPF | 在原有 SPF 中添加 `ip4:新IP`；保留仍在使用的发信商授权，不能新增第二条 SPF |
| `selector._domainkey` TXT | 对应 OpenDKIM selector 的完整公钥 |
| `_dmarc` TXT | 初始使用 `v=DMARC1; p=none`；验证全部合法发信源后再考虑更严格策略 |

现有 MX 和企业邮箱入口保持不变。只有发信服务，不需要新增指向本机的 MX。
修改 DNS 后同时检查权威服务器和公共递归解析。PTR、正向地址与 SMTP HELO 身份应匹配。
部分邮件服务商会缓存 SPF，换 IP 必须提前发布授权；
不要因缓存拒收而放宽 SPF 为 `+all` 或关闭验证。

轮换 DKIM 时使用新 selector：生成新密钥、发布新公钥、确认解析与
`opendkim-testkey` 成功，然后切换签名表并重启 OpenDKIM。旧公钥保留到旧邮件全部投递
且缓存窗口结束，之后再撤除。私钥应有加密备份，不能放入普通 Git、工单或聊天记录。

## 日常检查与排障

```bash
systemctl is-active postfix opendkim
systemctl is-enabled postfix opendkim
postfix check
opendkim -n -x /etc/opendkim.conf
ss -ltn | grep -E ':25 |:8891 '
postqueue -p
journalctl --since '30 minutes ago' -t postfix/smtp -t postfix/smtpd -t postfix/qmgr -u opendkim
```

| 现象 | 检查方向 |
| --- | --- |
| API 不提供邮箱登录 | SMTP env 是否加载、配置是否合法、健康接口是否报告已配置 |
| API 返回成功但收不到 | 按 Postfix queue ID 查 `status=sent/deferred/bounced`，不要把队列接受当收件成功 |
| `550 SPF check failed` | 出站 IP、SPF 唯一性、权威 DNS 与收件方缓存；记录回包后定向重试 |
| DKIM milter 连接失败 | OpenDKIM 状态、8891 监听、私钥权限和配置；保持 `tempfail`，不要静默去掉签名 |
| `Relay access denied` / `Access denied` | 实际容器 IP 与 mynetworks、发件域名映射、客户端限制 |
| `Recipient address rejected` 且 transport 为 error | `Local only` 安装遗留的 default_transport/relay_transport |
| 外部 MX 连接超时 | 出站 25、云厂商限制、DNS 和目标 MX 可达性 |
| 已 accepted 但进入垃圾箱 | 收件邮件的 SPF/DKIM/DMARC 结果、IP/域名信誉及内容；记录真实收件位置 |

验收分三层：API 提交成功、收件方 MX 返回 `250`、指定收件人确认收到。
测试只发给操作者明确授权的地址，不打印验证码或原始邮件正文。
失败重试使用新验证码，不能让已过期验证码重新生效。

当前示例针对验证码将队列寿命设为 10 分钟、消息大小设为 1 MiB，并限制目标并发。
这些属于业务参数；接入其他邮件类型前应评估队列寿命、退信处理和容量。
不要直接清空整个队列来“修复”投递，按 queue ID 处理已确认可丢弃的测试邮件。

## 配置更新、备份与回滚

1. 将 Postfix/OpenDKIM 配置、签名密钥和 SMTP env 备份到服务器受限目录；离机备份加密。
2. 修改前记录运行状态、当前镜像 revision 和容器网桥地址。镜像更新后再次核对调用方 IP。
3. Postfix 普通配置运行 `postfix check` 后 reload；更改监听地址/协议后 restart。
   OpenDKIM 配置或签名表修改后先校验，再 restart。
4. 发送授权测试并检查实际结果。回退发信路径时恢复之前的 SMTP env，使用同一个已部署
   代码版本重新创建认证容器；不回退数据库、不删除用户和令牌。
5. 回滚到外部 SMTP 只改变投递路径，必须明确记录仍使用外部提供商，不能报告为自建直投成功。

参考：
[Postfix 基础配置](https://www.postfix.org/BASIC_CONFIGURATION_README.html)、
[Postfix 中继限制](https://www.postfix.org/SMTPD_ACCESS_README.html)、
[Postfix Milter](https://www.postfix.org/MILTER_README.html)。
