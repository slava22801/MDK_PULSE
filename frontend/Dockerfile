# syntax=docker/dockerfile:1

# ── Сборка ──
FROM node:22-alpine AS builder

WORKDIR /app

# Слой зависимостей отдельно: правки исходников не переустанавливают пакеты.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# SSR-сборка React Router 7 → build/client + build/server
RUN npm run build

# ── Рантайм: production-зависимости + собранный бандл ──
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY --from=builder /app/build ./build
COPY --from=builder /app/public ./public

RUN addgroup -S pulse && adduser -S pulse -G pulse && chown -R pulse:pulse /app
USER pulse

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["npx", "react-router-serve", "./build/server/index.js"]