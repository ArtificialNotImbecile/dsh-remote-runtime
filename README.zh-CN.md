# DSH Remote Runtime

[English](README.md) | 简体中文

**在 Linux 主机上运行一套隔离的官方 DeepSeek Harness，并通过 OpenSSH 管理。** 这是面向 DSH `0.1.0-rc.8` Web UI 的独立社区插件，提供远端配置、Doctor、已校验运行时安装、隧道、工作区、凭据和 Session 历史；不修改 Harness 源码。

SSH、文件、进程与秘密全部留在插件 Host 侧。浏览器只接收有界 JSON 摘要，永远不会读回已保存凭据。

## 真实演示

素材来自真实 OpenSSH 托管运行时，并使用了真实 DeepSeek API 凭据。Key 在录制前由 Host 导入，从未进入浏览器、截图、GIF、日志或仓库。

<p align="center">
  <img src="docs/assets/readme/remote-runtime-demo.gif" alt="已连接配置、Doctor、凭据状态、工作区、真实 DeepSeek Session 与远端 Harness 界面" width="960">
</p>

<details>
<summary><strong>更多截图</strong></summary>

<table>
  <tr>
    <td><img src="docs/assets/readme/connected-profile.png" alt="已连接配置"><br><sub>已连接配置与运行时</sub></td>
    <td><img src="docs/assets/readme/doctor-install.png" alt="Doctor 检查"><br><sub>只读 Doctor 检查</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/credential-configured.png" alt="已配置凭据"><br><sub>只写凭据状态</sub></td>
    <td><img src="docs/assets/readme/workspaces.png" alt="远端工作区"><br><sub>已保存及 Harness workspace</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/sessions-real-deepseek.png" alt="真实 DeepSeek 记录"><br><sub>官方 Session 历史与提示界面</sub></td>
    <td><img src="docs/assets/readme/remote-ui-real-deepseek.png" alt="远端 Harness 界面"><br><sub>经 loopback 隧道打开完整 DSH UI</sub></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/profile-wizard-host.png" alt="Host 向导"><br><sub>Host 与隔离 workspace</sub></td>
    <td><img src="docs/assets/readme/profile-wizard-egress.png" alt="出网向导"><br><sub>Remote-direct 或 client-proxy</sub></td>
  </tr>
</table>

</details>

## 安装

```powershell
npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add `
  @artificialnotimbecile/dsh-remote-runtime@latest
npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 web
```

安装、更新或移除插件后，请重启已经运行的 Web profile。

<details>
<summary><strong>从本地代码构建</strong></summary>

```powershell
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run check
corepack pnpm pack --pack-destination test-results

npx.cmd --yes @deepseek-ai/dsh@0.1.0-rc.8 plugin --profile web add `
  .\test-results\artificialnotimbecile-dsh-remote-runtime-0.1.2.tgz
```

</details>

## 使用

打开 **Settings → 远程运行时**：

1. 添加 OpenSSH host 和可选远端 workspace。
2. 选择创建后不可修改的 `remote-direct` 或 `client-proxy`。
3. 运行只读 **Doctor**，再明确安装已校验运行时。
4. 通过只写表单导入 DeepSeek Key。
5. 启动运行时并打开 loopback 隧道地址。
6. 浏览 workspace、Session 历史，并发送或取消提示。

Disconnect 只断开连接，远端 Harness 继续运行；Stop 是独立操作。删除本地配置也不会删除远端 runtime 或 Session 数据。

## 主要能力

- 每个 profile UUID 拥有独立远端 `DSH_HOME`，隔离凭据、Session、workspace 与进程状态。
- 使用系统 OpenSSH，保留 SSH config、`IdentityFile`、ssh-agent 与 `ProxyJump`。
- 内容寻址运行时包含 Node 22.19 与官方 DSH rc.8；外层制品和每个解包文件都经过 SHA-256 校验。
- Workspace、Session、history、prompt 与 cancel 全部使用官方 DSH Host API。
- 凭据以 mode `0600` 写入，不返回浏览器状态、日志、快照或进程参数。
- 认证 client-proxy 只允许公网 HTTP(S)；私网、loopback、link-local、CGNAT、metadata、multicast、文档地址及 IPv6 本地范围全部 fail closed。

## 兼容与安全

- 本地 DSH：精确版本 `0.1.0-rc.8`；界面：Web profile。
- 客户端：Windows、macOS 或 Linux；Node `^22.19.0 || >=24`；系统 `ssh`。
- 远端：Linux x64、glibc 2.28+、Bash、`tar`、`gzip`、`sha256sum` 与可写 HOME。
- 所有隧道只监听 loopback；远端 DSH Web API 不会暴露到 `0.0.0.0`。
- SSH 是访问控制边界。需要隔离同 UID 进程时，请使用独立远端 OS 账号。

DeepSeek Harness 仍处于预发布阶段。只有 peer 版本、Typert 生成、组装 profile CI 和真实验收一起迁移并通过后，才会支持后续 DSH 版本。

## 开发

```powershell
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
corepack pnpm run pack:check
```

托管运行时需在 Linux 或 WSL 中构建；执行它需要 glibc 2.28+。生成的 archive、profile、截图和 live log 位于忽略的 `runtime/artifacts/` 与 `test-results/`。

## 许可证

MIT。独立社区插件，与 DeepSeek 无隶属或背书关系。第三方说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
