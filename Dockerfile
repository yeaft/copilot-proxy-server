FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# The builder needs esbuild's platform-specific optional binary.
# Runtime-only Windows broker dependencies are omitted in the final image below.
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

# MSAL core, proper-lockfile and sql.js are pure JS. No native compiler is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 6628

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --spider -q http://localhost:6628/ || exit 1

ENTRYPOINT ["node", "dist/index.js"]
