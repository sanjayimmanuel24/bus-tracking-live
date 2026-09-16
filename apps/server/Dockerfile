# Server image.
#
# The build context is the repository root, because the server depends on the
# @citybus/shared workspace and a context scoped to apps/server could not see it.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# Install the server's workspace only; the web build is a separate artifact.
RUN npm ci --omit=dev --workspace @citybus/server --include-workspace-root

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared ./packages/shared
COPY apps/server ./apps/server

# tsx runs TypeScript directly. For a service this size the startup cost is
# negligible and it keeps one source of truth rather than a build artifact that
# can drift from it.
RUN npm install --no-save tsx@^4.19.2

# Run unprivileged; the node image ships a suitable user.
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/server/src/index.ts"]
