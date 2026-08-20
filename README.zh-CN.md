# DSH Remote Runtime

[English](README.md) | 简体中文

**在 Linux 主机上运行一套隔离的官方 DeepSeek Harness，并通过 OpenSSH 安全访问。** DSH Remote Runtime 是面向 DeepSeek Harness `0.1.0-rc.8` Web profile 的独立社区插件。它提供双语界面，用来管理远程配置、显式运行时安装、工作区、隧道、凭据和远程 Session 历史；不修改 Harness 源码。

浏览器不会执行 SSH、读取文件或启动进程，也不会读回已保存密钥。这些能力全部留在插件 Host 侧，只通过 DSH 现有 Typert Remote 边界向界面返回有界、JSON 安全的摘要。

## 与现有远程插件的区别

未加 scope 的 [`dsh-remote`](https://github.com/flymysql/dsh-remote) 已经是一款成熟的 SSH/SFTP 工作区插件：本地 Harness 操作远端文件，并把远端目录镜像成本地 workspace。本项目解决的是另一类问题。

| | `dsh-remote` | DSH Remote Runtime |
| --- | --- | --- |
| Harness 进程 | 在本地运行 | 在远端 Linux 主机运行 |
| 主要边界 | 远端文件与命令 | 隔离的远端 `DSH_HOME`、运行时、Web API 与 Session |
| 界面 | 远端 workspace 选择与工具 | 配置向导、Doctor、运行时/隧道、工作区、历史及完整远端 DSH Web UI |
| 远端 Node/npm | 随具体工作流而定 | 不需要；托管运行时包含 Node 和固定版本 DSH |

两者使用不同包名、状态目录和产品边界，可以共存。

## 功能

- 每个配置使用稳定 UUID 和独立远端 `DSH_HOME`。同一 SSH 主机上的两条配置不会共享 Session、凭据、workspace 状态或进程控制文件。
- 使用系统 OpenSSH：保留 SSH config、`IdentityFile`、ssh-agent、`ProxyJump` 和你自己的 host-key 策略；插件不保存 SSH 密码或私钥。
- Settings 中提供受 Jasmine 远程配置界面启发的三步向导：
  1. 配置名、OpenSSH host、可选端口、workspace 与运行时根目录；
  2. 创建后不可修改的 `remote-direct` 或 `client-proxy`；
  3. 只读 Doctor，以及明确分开的 Install 操作。
- 内容寻址的 Linux x64 运行时，包含 Node 22.19 与官方 DSH `0.1.0-rc.8`。启用前校验外层制品和每个解包文件的 SHA-256；安装失败不会替换当前运行时。
- 远端只在 loopback 启动官方 `dsh web --no-open`，本地也只通过 loopback OpenSSH 隧道访问。
- 通过官方 DSH Host API 读取 `host.describe`、workspace、Session 列表、分页历史，并提交 prompt/cancel；不解析 DSH 私有 SQLite 或压缩 Session 文件。
- 显式、只写地导入 DeepSeek 凭据。密钥不会返回浏览器、状态 API、日志、快照或进程参数。
- 可选的带认证 client-proxy，包含 DNS rebinding 检查和有界元数据审计。私网、loopback、link-local、CGNAT、metadata、multicast、文档地址以及 IPv6 ULA/link-local 全部 fail closed。
- Disconnect 只断开隧道，远端 Harness 继续运行；Stop 是独立操作，并在发信号前校验进程所有权。

## 兼容范围

首个版本有意固定当前 developer-preview 边界：

- 本地 Harness：精确版本 `0.1.0-rc.8`；
- 客户端：Windows、macOS 或 Linux，Node `^22.19.0 || >=24`，以及系统 `ssh`；
- 远端：Linux x64、glibc 2.28+、Bash、`tar`、`gzip`、`sha256sum` 与可写 HOME；
- 交互界面：DSH Web profile。

DeepSeek Harness 仍处于预发布阶段。只有当精确 peer 版本、Typert 生成合同、组装 profile smoke 和真实验收一起迁移并通过后，插件才会声明支持后续 DSH 版本。

## 从本地代码安装

npm 包暂不发布。请先构建，再把精确 tarball 装入 Web profile：

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run check
corepack pnpm pack --pack-destination test-results

npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add `
  .\test-results\artificialnotimbecile-dsh-remote-runtime-0.1.0.tgz
npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 web
```

安装、更新或移除 bundle 后，请重启已经运行的 Web profile。插件管理器只修改所选 `DSH_HOME` profile，不会 patch DeepSeek Harness checkout。

开发时也可以安装绝对路径：

```powershell
npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add C:\path\to\dsh-remote-runtime
```

Git source 安装会运行包的 `prepare`。pnpm 可能先要求把经过审阅的精确 Git 依赖加入该 profile 的 `allowBuilds`；请按其输出的 path-specific 诊断操作。预构建 tarball 不需要这项构建权限。

## 第一次连接

打开 **Settings → 远程运行时**：

1. 添加 OpenSSH host 和可选的绝对远端 workspace。
2. 选择出网方式。出网方式与远端根目录共同标识隔离状态树，因此创建后不可更改。
3. 保存配置；此时只写本地元数据。
4. 运行 **Doctor**。Doctor 只连接并检查前置条件，不下载、不安装。
5. 明确点击 **安装已校验运行时**。
6. 显式导入一个 DeepSeek key，再启动远端运行时。
7. 打开 loopback 隧道地址使用完整远端 DSH UI，或直接在插件页查看 workspace 与 Session 历史。

移除配置只删除本地连接元数据和本地审计/缓存；不会删除远端运行时、凭据、workspace 或 Session。

## 状态隔离

默认情况下，每个远端配置拥有：

```text
${XDG_DATA_HOME:-$HOME/.local/share}/dsh-remote-runtime/
  objects/<artifact-sha>.tar.gz
  runtimes/<artifact-sha>/
  profiles/<profile-uuid>/
    runtime.json
    harness/                  # 此配置的 DSH_HOME
      .credentials.yaml
      sessions/
      storages/
    control/                  # 经所有权校验的 pid、port、日志和启动数据
```

内容寻址运行时可以安全复用；所有用户和 Session 状态均位于 profile UUID 之下。

本地连接元数据位于 `cordis.patch.yml` 配置的插件根目录，通常是 `$DSH_HOME/dsh-remote-runtime`。平台支持时，元数据与凭据文件使用 owner-only 权限。

## 网络模式

`remote-direct` 使用远端主机自身的网络；不会复制本地代理设置。

`client-proxy` 在客户端启动带认证的 loopback gateway，并建立仅绑定远端 loopback 的 OpenSSH reverse forward。只允许配置端口上的公网 HTTP(S)。上游代理只按环境变量名选择，URL 与凭据始终留在 Host。SSH 断开后，远端工作仍保留，但依赖该代理的网络请求必须等隧道恢复。

这不是透明网络：UDP、裸 DNS、ICMP、任意入站转发、容器、cron/systemd、sudo 环境策略和 git-over-SSH 不在 v1 保证范围内。

## 安全说明

- SSH 是访问控制边界。所有转发只监听 `127.0.0.1` 或 `::1`；控制面和 Web 都不会绑定 `0.0.0.0`。
- 官方 DSH Web API 因为只用于 loopback，本身没有用户认证。插件控件经 Host 调用；完整远端 UI 只通过本地 SSH 隧道暴露。
- API key 经 SSH 写入 mode `0600` 的配置文件，不进入 SSH argv、DSH argv、Remote 返回或审计事件。
- 远端同 UID 进程可以读取同 UID 文件。文件权限无法阻止一个被明确要求读取自身私有目录的 agent；需要这种隔离时，请使用独立 OS 账号或外部凭据提供方。
- client-proxy 只记录 host、解析地址、端口、allow/deny、字节数、耗时和错误码；不记录 URL、header、query、body 或凭据。

## 开发与验证

```powershell
corepack pnpm install --ignore-scripts
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run pack:check
```

在 Linux 或 Windows WSL 中构建托管运行时；执行 `runtime:verify` 的目标环境需为 glibc 2.28+：

```powershell
corepack pnpm run runtime:build
corepack pnpm run runtime:verify
```

生成的 archive、key、profile、截图和 live log 位于忽略的 `runtime/artifacts/` 与 `test-results/`。CI 在 Linux/Windows 的 Node 22.19 与 24 上检查包，然后把 tarball 安装进隔离的官方 DSH rc.8 Web profile，验证最终配置树。

## 项目状态

这是独立社区插件，与 DeepSeek 无隶属或背书关系。项目只使用 DeepSeek Harness 已发布的扩展点，并保持 Harness 自身不变。

## 许可证

MIT。托管运行时及复用脚手架的说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
