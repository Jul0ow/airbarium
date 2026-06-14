# syntax=docker/dockerfile:1

# --- deps: install all dependencies (drizzle-kit needed by the migration job) ---
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# --- runtime: Bun runs TypeScript directly, no build step ---
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json drizzle.config.ts ./
COPY src ./src
USER bun
EXPOSE 3000
CMD ["bun", "run", "start"]
