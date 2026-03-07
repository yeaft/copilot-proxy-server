FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json tsup.config.ts ./
COPY src/ src/

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

# better-sqlite3 is a native module and must be installed in the runner
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && apk del python3 make g++

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

EXPOSE 6628

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --spider -q http://localhost:6628/ || exit 1

ENTRYPOINT ["node", "dist/index.js"]
