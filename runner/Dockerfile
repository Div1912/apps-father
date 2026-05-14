# syntax=docker/dockerfile:1.6
#
# apps-father-runner — base image for per-project workers.
#
# Layout inside the container:
#   /runner                          — worker-entry.js + lib/* + node_modules with platform-baked deps
#     /runner/worker-entry.js
#     /runner/lib/*.js
#     /runner/node_modules           — express, ws, dotenv, better-sqlite3, grammy
#   /workspace                       — bind-mounted from host: /srv/apps-father/projects/<id>
#     /workspace/{release,development}/{frontend,backend,data}
#     /workspace/node_modules        — user-declared deps installed via npm_install tool (per-project)
#     /workspace/package.json
#
# NODE_PATH is set so user routes.js can require platform-baked deps AND its own packages:
#   NODE_PATH=/workspace/node_modules:/runner/node_modules
#
# Security:
#   - Runs as the unprivileged "node" user (uid 1000, baked into node:20-alpine).
#   - --read-only at run time; only /workspace and /tmp are writable.
#   - --network attached to the apps-father-runners bridge with --icc=false.
#   - --memory / --cpus / --pids-limit applied at run time.

FROM node:20-alpine

# Tools the runner image needs at runtime:
#   - tini      → PID 1 reaper (handles SIGTERM correctly so docker stop drains gracefully)
#   - python3 / make / g++ → required to build better-sqlite3's native binding on alpine
#                            (removed after install in the next layer)
RUN apk add --no-cache tini \
 && apk add --no-cache --virtual .build-deps python3 make g++

WORKDIR /runner

# Install platform-baked deps. We use --ignore-scripts so any compromised
# postinstall in transitive deps cannot escalate. better-sqlite3 builds via
# `prebuild-install` which the install command runs explicitly below.
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm rebuild better-sqlite3 \
 && apk del .build-deps \
 && npm cache clean --force

# Copy worker entry + helpers last so changes in those files don't bust the
# npm cache layer above.
COPY worker-entry.js ./
COPY lib ./lib

# Default env that the supervisor overrides per container.
ENV NODE_ENV=production \
    NODE_PATH=/workspace/node_modules:/runner/node_modules \
    BIND_HOST=0.0.0.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

USER node

# tini reaps zombies and forwards SIGTERM/SIGINT cleanly to the worker.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/runner/worker-entry.js"]
