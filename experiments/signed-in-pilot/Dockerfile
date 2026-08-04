FROM node@sha256:cd84903a12dbd26b46f1f3b8144a2568c41c5d37ddd0c7a80a34c7a19786b35f

ARG CODEX_VERSION=0.146.0

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git time \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && codex --version

RUN useradd --create-home --uid 10001 experiment
RUN install -d -o experiment -g experiment -m 0700 /experiment/workspace

USER experiment
WORKDIR /experiment/workspace

ENV HOME=/experiment/home \
    CODEX_HOME=/experiment/home/.codex \
    XDG_CACHE_HOME=/experiment/home/.cache \
    XDG_CONFIG_HOME=/experiment/home/.config \
    XDG_DATA_HOME=/experiment/home/.local/share \
    TMPDIR=/experiment/tmp

LABEL org.opencontainers.image.title="Nelos signed-in pilot worker" \
      org.opencontainers.image.description="Isolated Linux ARM64 Codex CLI acquisition image" \
      org.opencontainers.image.version="0.146.0"
