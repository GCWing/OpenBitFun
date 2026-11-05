# OpenBitFun Server (Web App Backend)

This directory contains the `openbitfun-server` application, which serves the web backend runtime for OpenBitFun.

> **Deprecated:** This Web Server was already deprecated before the current App Server refactor. Changes made here
> during that refactor are intended to validate protocol and host boundaries; they do not promise feature completeness,
> Desktop parity, backward compatibility, or production readiness.

For **Remote Connect**, the official Relay is ready to use without deploying this
server. Start with the [Relay FAQ](../relay-server/FAQ.md). For private Relay
deployment with a matching client build, use:

- [Relay Server README](../relay-server/README.md)
- [Versioned deployment guide](../../../deploy/relay-v1/README.md)

`src/apps/server` and `src/apps/relay-server` are different components. `src/apps/server` is the main web app backend, while `src/apps/relay-server` is the relay service used by Remote Connect.

When exercising configured OpenCode plugins, use `pnpm run server:dev` or
`pnpm run server:build`. These commands prepare the extension Host first; a
compatible `bun` command (or `OPENBITFUN_BUN_COMMAND`) is required at runtime. The
release build stages `resources/ext-host` beside the server binary; deploy that
directory with the binary.
