# Agen, as one container.
#
# The app and the thing that builds markets are deployed together, which is not the
# obvious choice and is the right one here. A market build takes minutes, shells out to
# `forge`, and writes a workspace to disk — none of which a serverless function can do.
# Splitting the two would mean a second service, a protocol between them, and a way to
# authenticate it, all before the first public build has run. One container that can
# serve a page and compile Solidity is smaller in every dimension that matters today.
#
# What that costs, so it is written down rather than discovered: the image carries a
# Solidity toolchain, an in-flight build dies with a restart (the job stays on disk at
# whatever stage it reached), and scaling the web tier means scaling the compiler with
# it. All three are fixed by moving the runner out, and none of them are worth fixing
# before the first real build has run.

FROM node:22-bookworm-slim

# git: foundryup wants it. curl/ca-certificates: to fetch foundry at all.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*

# Foundry. `forge` is a hard runtime dependency: the pipeline compiles and tests every
# market it generates by invoking it, so an image without it serves a site that fails at
# the first build rather than at boot.
#
# Installed from the release archive rather than through foundryup, which insists on
# fetching a sigstore attestation and dies against the TLS-terminating proxy in front of
# this builder. The checksum published beside the archive is verified here instead, so
# the download is still checked rather than merely trusted.
#
# Pinned, and pinned to the version the contracts were tested with locally: a toolchain
# that drifts between the machine where a market's tests pass and the machine where they
# run for a stranger is a difference nobody would think to look for.
ENV FOUNDRY_DIR=/opt/foundry
ENV PATH=/opt/foundry/bin:$PATH
ARG FOUNDRY_VERSION=v1.7.1
ARG TARGETARCH
RUN set -eux; \
  arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  base="https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}"; \
  file="foundry_${FOUNDRY_VERSION}_linux_${arch}.tar.gz"; \
  curl -fsSL "${base}/${file}" -o /tmp/foundry.tar.gz; \
  curl -fsSL "${base}/foundry_${FOUNDRY_VERSION}_linux_${arch}.sha256" -o /tmp/foundry.sha256; \
  echo "$(cut -d' ' -f1 /tmp/foundry.sha256)  /tmp/foundry.tar.gz" | sha256sum -c -; \
  mkdir -p /opt/foundry/bin; \
  tar -xzf /tmp/foundry.tar.gz -C /opt/foundry/bin; \
  rm /tmp/foundry.tar.gz /tmp/foundry.sha256; \
  forge --version

WORKDIR /app

# Dependencies first, so that editing a source file does not re-resolve the workspace.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/agen/package.json apps/agen/
COPY packages/market-compiler/package.json packages/market-compiler/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/sdk/package.json packages/sdk/
COPY packages/ui/package.json packages/ui/
COPY packages/runtime/package.json packages/runtime/
COPY apps/web/package.json apps/web/
COPY apps/indexer/package.json apps/indexer/
COPY apps/landing/package.json apps/landing/

RUN corepack enable && corepack prepare pnpm@10.30.0 --activate
RUN pnpm install --frozen-lockfile

COPY . .

# The Solidity dependency tree every generated market compiles against.
#
# It is not in the build context and cannot be: `packages/contracts/vendor/` is
# gitignored, and the CLI that uploads this repository honours .gitignore. The first
# public build got as far as compiling and then failed on `v4-core/` resolving to a
# directory that did not exist — the app was fine, the image was missing v4.
#
# Fetched here rather than copied, which is better anyway: the script pulls immutable
# commit tarballs pinned to the bytecode deployed on chain, so the image cannot drift
# from what the contracts were verified against.
RUN bash scripts/vendor-contracts-deps.sh

# Everything the browser is told, it is told here.
#
# Next replaces a `NEXT_PUBLIC_` expression with its value during `next build` and the
# expression is gone from the bundle afterwards, so these cannot be supplied the way the
# server's variables are. A value set on the host after this image was built is a value
# the browser never sees — which is not an error anywhere, just a page that quietly
# describes the wrong deployment. Railway passes service variables to a Docker build as
# build arguments, but only a declared `ARG` receives one, so each is named here.
#
# None of them are required. The chain and Agen's three addresses come from the
# deployment record in `@verdant/config` when unset, which is how a production build
# should learn them; these stay for a fork or a devnet pointed at something else. Nothing
# here is a secret — a WalletConnect id identifies the app to the relay and ships in the
# bundle by necessity.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
ARG NEXT_PUBLIC_CHAIN_ID
ARG NEXT_PUBLIC_RPC_URL
ARG NEXT_PUBLIC_AGEN_FACTORY
ARG NEXT_PUBLIC_AGEN_DEPLOYER
ARG NEXT_PUBLIC_AGEN_REGISTRY
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID \
  NEXT_PUBLIC_CHAIN_ID=$NEXT_PUBLIC_CHAIN_ID \
  NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL \
  NEXT_PUBLIC_AGEN_FACTORY=$NEXT_PUBLIC_AGEN_FACTORY \
  NEXT_PUBLIC_AGEN_DEPLOYER=$NEXT_PUBLIC_AGEN_DEPLOYER \
  NEXT_PUBLIC_AGEN_REGISTRY=$NEXT_PUBLIC_AGEN_REGISTRY

# Only what serving needs, in dependency order: the packages the app imports, then the
# app, then what the feed imports.
#
# `@verdant/sdk` is here because the token page cannot be built without it — it encodes
# the launch transaction, quotes a trade and parses a candle series. It is easy to leave
# out and hard to notice: a workspace package resolves to its `dist`, a laptop has one
# left over from some earlier build, and the missing step only surfaces in a clean image
# as four `Module not found` lines at the end of a ten-minute build.
#
# The indexer's dependencies are built here too, because this image runs the indexer as
# well. Railway uses a Dockerfile at the root for every service that has one, so the
# feed stopped being able to build the day this file arrived and went on serving an
# image from before it — a service that looks deployed, answers health checks, and is
# months behind the schema the site expects. `scripts/railway-start.sh` already chooses
# which process to be from the service name; this is the other half of that.
#
# Written as the dependency closure rather than a list, so a package the feed picks up
# later is built without anyone remembering this line exists. `@verdant/indexer` itself
# has no build step.
RUN pnpm --filter @verdant/config build
RUN pnpm --filter @verdant/sdk build
RUN pnpm --filter @verdant/market-compiler build
RUN pnpm --filter "@verdant/indexer^..." build
RUN pnpm --filter @verdant/agen build

# Pre-fetch the Solidity compiler the generated markets pin. Without this the first
# build a visitor starts pays for the download, inside a stage that is being timed, and
# fails outright if egress is ever restricted.
RUN mkdir -p /tmp/solcwarm/src \
  && printf '[profile.default]\nsrc = "src"\nsolc = "0.8.26"\n' > /tmp/solcwarm/foundry.toml \
  && printf '// SPDX-License-Identifier: MIT\npragma solidity 0.8.26;\ncontract W {}\n' > /tmp/solcwarm/src/W.sol \
  && cd /tmp/solcwarm && forge build \
  && rm -rf /tmp/solcwarm

# Where the pipeline looks for the vendored v4 sources and where it writes job
# workspaces. Derived from the working directory otherwise, which is right in the repo
# and wrong here.
ENV AGEN_REPO_ROOT=/app
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["pnpm", "--filter", "@verdant/agen", "start"]
