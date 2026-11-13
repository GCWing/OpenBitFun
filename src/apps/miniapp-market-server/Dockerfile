# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS web-builder

WORKDIR /build
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches/ patches/
COPY design-system/LICENSE design-system/LICENSE
COPY design-system/tsconfig.base.json design-system/tsconfig.base.json
COPY design-system/packages/ui/package.json design-system/packages/ui/package.json
COPY design-system/tooling/token-engine/package.json design-system/tooling/token-engine/package.json
COPY design-system/packages/design-tokens/package.json design-system/packages/design-tokens/package.json
COPY design-system/packages/theme-openbitfun/package.json design-system/packages/theme-openbitfun/package.json
COPY src/miniapp-market-web/package.json src/miniapp-market-web/package.json
RUN --mount=type=cache,id=openbitfun-market-pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --ignore-scripts --filter openbitfun-miniapp-market-web...

COPY design-system/packages/ui/ design-system/packages/ui/
COPY design-system/tooling/token-engine/ design-system/tooling/token-engine/
COPY design-system/packages/design-tokens/ design-system/packages/design-tokens/
COPY design-system/packages/theme-openbitfun/ design-system/packages/theme-openbitfun/
COPY src/miniapp-market-web/ src/miniapp-market-web/
COPY src/shared/i18n/contract/locales.json src/shared/i18n/contract/locales.json
RUN pnpm --dir design-system/packages/design-tokens build \
    && pnpm --dir design-system/packages/theme-openbitfun build \
    && pnpm --dir design-system/packages/ui build \
    && pnpm --dir src/miniapp-market-web build

FROM rust:1.96-bookworm AS rust-builder

WORKDIR /build
ARG CARGO_BUILD_JOBS=
ENV CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse \
    CARGO_TERM_COLOR=always

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        libssl-dev \
        pkg-config \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY third_party/eioc/ third_party/eioc/
# Cargo resolves `[patch.crates-io]` path entries from the root manifest even for
# a service-only build, so the vendored engine patches must be present.
COPY third_party/screenshots/ third_party/screenshots/
COPY third_party/tao/ third_party/tao/
COPY third_party/wry/ third_party/wry/
COPY src/ src/

RUN --mount=type=cache,id=openbitfun-market-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=openbitfun-market-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=openbitfun-market-target,target=/build/target,sharing=locked \
    { [ -n "${CARGO_BUILD_JOBS:-}" ] || unset CARGO_BUILD_JOBS; } \
    && cargo build --locked --release -p openbitfun-miniapp-market-server \
    && cp target/release/openbitfun-miniapp-market-server /tmp/openbitfun-miniapp-market-server \
    && strip /tmp/openbitfun-miniapp-market-server

FROM debian:bookworm-slim AS runtime

ARG MARKET_GIT_COMMIT=unknown
LABEL org.opencontainers.image.title="OpenBitFun MiniApp Market" \
      org.opencontainers.image.revision="${MARKET_GIT_COMMIT}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 market \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin market

WORKDIR /app
COPY --from=rust-builder /tmp/openbitfun-miniapp-market-server /app/openbitfun-miniapp-market-server
COPY --from=web-builder /build/src/miniapp-market-web/dist/ /app/web/

RUN mkdir -p /app/data /app/artifacts \
    && chown -R market:market /app/data /app/artifacts

USER 10001:10001

ENV MARKET_BIND=0.0.0.0:9710 \
    MARKET_DATABASE_PATH=/app/data/market.sqlite \
    MARKET_ARTIFACT_DIR=/app/artifacts \
    MARKET_WEB_DIR=/app/web

EXPOSE 9710

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=5 \
  CMD curl -fsS http://127.0.0.1:9710/miniapp/api/v1/health || exit 1

ENTRYPOINT ["/app/openbitfun-miniapp-market-server"]
