# syntax=docker/dockerfile:1
#
# One image, three stages: install, build, run.
#
# The runtime stage is built from `pnpm deploy`, not from the workspace, so it
# carries the API's production dependencies and nothing else — no pnpm store, no
# devDependencies, no source, no test runner. Build it from the repository root:
#
#   docker build -f infra/Dockerfile -t ara:local .
#   docker run --rm -p 8080:8080 ara:local
#
# The build context is filtered by the repository root's .dockerignore, which is
# the only location every builder reads — including `az acr build`, which is how
# infra/deploy.sh builds this without a local Docker daemon. See ADR-033.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Corepack installs the pnpm version pinned by the root package.json's
# `packageManager` field. The prompt is disabled because a build has nobody to
# answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---- deps -------------------------------------------------------------------
# Only the manifests, so the install layer is reused on every commit that does not
# change a dependency — which is most of them.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
# `pnpm build` compiles the shared contracts, then the API, then the web bundle,
# in that order — pnpm resolves it from the workspace graph.
#
# `--legacy` is required because this workspace links workspace packages rather
# than injecting them; see ADR-032.
FROM deps AS build
COPY . .
RUN pnpm build
RUN pnpm --filter @ara/api deploy --legacy --prod /runtime

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production

# The two directories the app reads from disk. Both are set explicitly rather than
# resolved relative to the source tree, which does not exist in this image.
ENV FIXTURES_DIR=/app/fixtures
ENV WEB_DIR=/app/web
ENV PORT=8080

WORKDIR /app
COPY --from=build /runtime/package.json ./package.json
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
COPY --from=build /repo/fixtures ./fixtures

# `node` is a non-root user the base image already provides. Owning nothing it
# writes to is the point: the app never writes to disk.
USER node

EXPOSE 8080

# Liveness only. It deliberately does not check the model or the search provider —
# a third party being down is not a reason to have this container restarted.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Source maps cost a little memory and buy a stack trace that points at the
# TypeScript line rather than the compiled one — worth it on a service this size.
CMD ["node", "--enable-source-maps", "dist/main.js"]
