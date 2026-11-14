# syntax=docker/dockerfile:1.7
# OpenBitFun Relay Server standalone Docker build.
# The reduced repository-root context contains only the relay app and services.
#
# Rebuild caching:
# - Cargo registry/git/target use BuildKit cache mounts so redeploys reuse
#   downloaded crates and compiled dependency objects across builds.
# - Binaries are copied out of the target cache mount into /out within the same
#   RUN (cache mounts are not part of the image filesystem).
#
# China mirrors (optional):
#   docker compose build --build-arg OPENBITFUN_USE_CN_MIRROR=1
#   Also: OPENBITFUN_APT_MIRROR, OPENBITFUN_CARGO_SPARSE_URL

# Pin a minor toolchain so floating `rust:1-bookworm` updates do not bust the
# entire builder cache on every upstream image refresh.
FROM rust:1.96-bookworm AS builder

WORKDIR /build/src/apps/relay-server

# Optional: limit rustc parallelism on small or low-memory VPS hosts.
#   docker compose build --build-arg CARGO_BUILD_JOBS=1
# Note: empty value must NOT be set as ENV — cargo chokes on empty string.
ARG CARGO_BUILD_JOBS=
ARG OPENBITFUN_USE_CN_MIRROR=0
ARG OPENBITFUN_APT_MIRROR=mirrors.aliyun.com
ARG OPENBITFUN_CARGO_SPARSE_URL=sparse+https://rsproxy.cn/index/

ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_TERM_COLOR=always \
    CARGO_REGISTRIES_CRATES_IO_PROTOCOL=sparse

# Configure apt + cargo mirrors inside the builder when deploying from China.
RUN set -eux; \
    if [ "${OPENBITFUN_USE_CN_MIRROR}" = "1" ]; then \
      sed -i \
        -e "s|deb.debian.org/debian|${OPENBITFUN_APT_MIRROR}/debian|g" \
        -e "s|security.debian.org/debian-security|${OPENBITFUN_APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list 2>/dev/null || true; \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i \
          -e "s|deb.debian.org/debian|${OPENBITFUN_APT_MIRROR}/debian|g" \
          -e "s|security.debian.org/debian-security|${OPENBITFUN_APT_MIRROR}/debian-security|g" \
          /etc/apt/sources.list.d/debian.sources; \
      fi; \
      mkdir -p /usr/local/cargo; \
      # `[source.*]` alone is what redirects crates.io. A matching
      # `[registries.*]` table would only matter for crates that name the
      # registry explicitly, which none here do — and an unused named registry
      # is something Cargo may start warning about.
      #
      # No `git-fetch-with-cli` either: `git` is not installed in this builder,
      # so it would turn any future git dependency into a CN-only build failure
      # while global builds kept working.
      printf '%s\n' \
        '[source.crates-io]' \
        'replace-with = "openbitfun-rsproxy-sparse"' \
        '' \
        '[source.openbitfun-rsproxy-sparse]' \
        "registry = \"${OPENBITFUN_CARGO_SPARSE_URL}\"" \
        > /usr/local/cargo/config.toml; \
    fi

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 \
      install -y --no-install-recommends \
        pkg-config \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        python3 \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /out

COPY src/apps/relay-server/Cargo.toml ./Cargo.toml
COPY src/crates/services/relay-service/Cargo.toml ../../crates/services/relay-service/Cargo.toml
COPY src/crates/services/page-function-runtime/Cargo.toml ../../crates/services/page-function-runtime/Cargo.toml

# Warm dependency objects into the BuildKit target cache. Placeholder sources
# live only in this layer; real sources are copied afterward.
RUN --mount=type=cache,id=openbitfun-relay-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=openbitfun-relay-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=openbitfun-relay-target,target=/build/src/apps/relay-server/target,sharing=locked \
    mkdir -p src/bin \
        ../../crates/services/relay-service/src \
        ../../crates/services/page-function-runtime/src \
    && printf 'fn main() {}\n' > src/main.rs \
    && printf 'pub use openbitfun_relay_service::*;\n' > src/lib.rs \
    && printf 'fn main() {}\n' > src/bin/relay_admin.rs \
    && printf '// placeholder\n' > ../../crates/services/relay-service/src/lib.rs \
    && printf '// placeholder\n' > ../../crates/services/page-function-runtime/src/lib.rs \
    && { [ -n "${CARGO_BUILD_JOBS:-}" ] || unset CARGO_BUILD_JOBS; } \
    && cargo build --release \
    && rm -rf src \
        ../../crates/services/relay-service/src \
        ../../crates/services/page-function-runtime/src

COPY src/apps/relay-server/src/ ./src/
COPY src/crates/services/relay-service/src/ ../../crates/services/relay-service/src/
COPY src/crates/services/page-function-runtime/src/ ../../crates/services/page-function-runtime/src/

# Rebuild workspace crates against cached dependency objects, then copy
# release binaries out of the cache mount into the image.
RUN --mount=type=cache,id=openbitfun-relay-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=openbitfun-relay-cargo-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=openbitfun-relay-target,target=/build/src/apps/relay-server/target,sharing=locked \
    rm -f target/release/openbitfun-relay-server \
        target/release/relay-admin \
        target/release/deps/*openbitfun_relay_service* \
        target/release/deps/*openbitfun_page_function_runtime* \
        target/release/deps/*openbitfun_relay_server* \
        target/release/deps/*relay_admin* \
    && rm -rf target/release/.fingerprint/openbitfun-relay-service-* \
        target/release/.fingerprint/openbitfun-page-function-runtime-* \
        target/release/.fingerprint/openbitfun-relay-server-* \
        target/release/.fingerprint/relay-admin-* \
    && touch ../../crates/services/relay-service/src/lib.rs \
        ../../crates/services/page-function-runtime/src/lib.rs \
        src/lib.rs \
        src/main.rs \
        src/bin/relay_admin.rs \
    && { [ -n "${CARGO_BUILD_JOBS:-}" ] || unset CARGO_BUILD_JOBS; } \
    && cargo build --release \
    && cp target/release/openbitfun-relay-server target/release/relay-admin /out/ \
    && (strip /out/openbitfun-relay-server /out/relay-admin || true)

FROM debian:bookworm-slim

ARG RELAY_GIT_COMMIT=unknown
ARG OPENBITFUN_USE_CN_MIRROR=0
ARG OPENBITFUN_APT_MIRROR=mirrors.aliyun.com

LABEL org.opencontainers.image.title="OpenBitFun Relay Server" \
      org.opencontainers.image.description="Self-hosted relay server for OpenBitFun" \
      org.opencontainers.image.source="https://github.com/openBitFun/OpenBitFun" \
      org.opencontainers.image.revision="${RELAY_GIT_COMMIT}" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive

RUN set -eux; \
    if [ "${OPENBITFUN_USE_CN_MIRROR}" = "1" ]; then \
      sed -i \
        -e "s|deb.debian.org/debian|${OPENBITFUN_APT_MIRROR}/debian|g" \
        -e "s|security.debian.org/debian-security|${OPENBITFUN_APT_MIRROR}/debian-security|g" \
        /etc/apt/sources.list 2>/dev/null || true; \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i \
          -e "s|deb.debian.org/debian|${OPENBITFUN_APT_MIRROR}/debian|g" \
          -e "s|security.debian.org/debian-security|${OPENBITFUN_APT_MIRROR}/debian-security|g" \
          /etc/apt/sources.list.d/debian.sources; \
      fi; \
    fi; \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=20 -o Acquire::https::Timeout=20 \
      install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /out/openbitfun-relay-server /app/openbitfun-relay-server
COPY --from=builder /out/relay-admin /app/relay-admin
COPY src/apps/relay-server/static/ /app/static/
RUN mkdir -p /app/static /app/data /app/room-web

ENV RELAY_PORT=9700
ENV RELAY_STATIC_DIR=/app/static
EXPOSE 9700

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${RELAY_PORT}/health" || exit 1

CMD ["/app/openbitfun-relay-server"]
