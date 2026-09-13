# Chrysalis in a container.
#
#   docker compose up -d        (see docker-compose.yml)
#
# Settings and data live in the /chrysalis volume: config.yaml, data/.
# Every setting can also be passed as a CHRYSALIS_* environment variable.

FROM oven/bun:1.4.0 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
COPY client-agent/package.json client-agent/bun.lock client-agent/
RUN bun install --frozen-lockfile && cd client-agent && bun install --frozen-lockfile
COPY . .
RUN bun run dist host --no-archive \
 && mkdir /out && mv out/dist/Chrysalis-*-linux-*/* /out/

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
