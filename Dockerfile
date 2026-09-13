# Chrysalis in a container.
#
#   docker compose up -d        (see docker-compose.yml)
#
# Settings and data live in the /chrysalis volume: config.yaml, data/.
# Every setting can also be passed as a CHRYSALIS_* environment variable.

# The engine is compiled on the build machine's own architecture for the
# image's target (Bun cross-compiles), so multi-arch images need no emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0 AS build
ARG TARGETARCH
ARG CHRYSALIS_VERSION=
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
COPY client-agent/package.json client-agent/bun.lock client-agent/
RUN bun install --frozen-lockfile && cd client-agent && bun install --frozen-lockfile
COPY . .
RUN arch=$([ "$TARGETARCH" = "arm64" ] && echo arm64 || echo x64) \
 && CHRYSALIS_VERSION="$CHRYSALIS_VERSION" bun run dist "linux-$arch" --no-archive \
 && mkdir /out && mv out/dist/Chrysalis-*-linux-$arch/* /out/

FROM debian:bookworm-slim
# ca-certificates for model providers over HTTPS; git lets apps come from SSH remotes
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 chrysalis \
 && mkdir /chrysalis && chown chrysalis /chrysalis
COPY --from=build /out /opt/chrysalis
USER chrysalis
ENV CHRYSALIS_HOME=/chrysalis \
    CHRYSALIS_LAN=true \
    CHRYSALIS_OPEN_BROWSER=false
VOLUME /chrysalis
EXPOSE 8788
STOPSIGNAL SIGTERM
ENTRYPOINT ["/opt/chrysalis/chrysalis"]
