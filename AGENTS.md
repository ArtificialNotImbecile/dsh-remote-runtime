# DSH Remote Runtime contributor rules

This repository is a standalone community plugin. Never require or propose a DeepSeek Harness source change; use only its published plugin, slot, Typert Remote, and Host API surfaces.

- Target DeepSeek Harness `0.1.0-rc.8` exactly until a tested compatibility update changes every peer dependency and assembled-profile check together.
- Host code owns SSH, filesystem access, processes, runtime artifacts, credentials, tunnels, and network policy. Browser code receives only JSON-safe summaries and write-only credential inputs.
- Never log, snapshot, return, or commit API keys, proxy credentials, private keys, authorization headers, or `.env` content.
- Doctor and status refreshes are read-only. Runtime install, credential import, process start/stop, and profile removal must remain explicit user actions.
- Bind every local and remote forwarding listener to loopback. Client-proxy egress rejects private, loopback, link-local, CGNAT, metadata, multicast, documentation, and IPv6 ULA/link-local destinations after DNS resolution.
- A profile UUID owns a distinct remote `DSH_HOME`; changing display or SSH fields must not move that identity. Egress mode and remote root are immutable.
- OpenSSH config, IdentityFile, ssh-agent, and ProxyJump remain the authentication surface. Do not add password storage.
- Build and test the package, pack it, install the tarball into an isolated official DSH rc.8 Web profile, and boot that profile before delivery. Live tests use a disposable SSH target and inject the DeepSeek key only into child process environment.
- Generated screenshots, logs, profiles, keys, runtime archives, and acceptance output belong under ignored `test-results/` or `runtime/artifacts/`.
