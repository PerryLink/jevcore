# Glama (https://glama.ai/mcp/servers/PerryLink/jevcore) builds this image in its
# own sandbox and introspects the MCP server over stdio: it must answer
# `initialize` and `tools/list` unattended, with no credential present.
#
# The server satisfies that by falling back to the offline mock provider, which is
# pinned explicitly below so introspection can never depend on an API key.
# Logs go to stderr; JSON-RPC goes to stdout only.

# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

# `COPY . .` is deliberate: pnpm-workspace.yaml globs `packages/*`, so a partial
# copy that omits any workspace manifest breaks `--frozen-lockfile`.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter jevcore run build && pnpm --filter jevcore-mcp run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV JEV_PROVIDER=mock
COPY --from=build /app /app
ENTRYPOINT ["node", "packages/mcp/lib/bin.js"]
