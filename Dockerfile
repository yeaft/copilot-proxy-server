FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

# dist/index.js is a self-contained ESM bundle using only Node 22 built-ins (including node:sqlite);
# dist/assets/ holds the dashboard UI files it serves.
COPY package.json ./
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 6628

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --spider -q http://localhost:6628/ || exit 1

ENTRYPOINT ["node", "--no-warnings=ExperimentalWarning", "dist/index.js"]
