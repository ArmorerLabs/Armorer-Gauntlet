FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/daemon/package.json apps/daemon/package.json
COPY apps/pwa/package.json apps/pwa/package.json
COPY apps/relay/package.json apps/relay/package.json
COPY packages/codex-protocol/package.json packages/codex-protocol/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS source
COPY . .

FROM source AS relay-build
RUN npm run build -w @armorer/gauntlet-shared -w @armorer/gauntlet-relay

FROM source AS pwa-build
ARG PUBLIC_VAPID_PUBLIC_KEY=
ENV PUBLIC_VAPID_PUBLIC_KEY=$PUBLIC_VAPID_PUBLIC_KEY
RUN npm run build -w @armorer/gauntlet-shared -w @armorer/gauntlet-pwa

FROM node:22-alpine AS relay
WORKDIR /app
ENV NODE_ENV=production
COPY --from=relay-build /app /app
EXPOSE 8787
CMD ["node", "apps/relay/dist/index.js", "--host", "0.0.0.0", "--port", "8787"]

FROM node:22-alpine AS pwa
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
COPY --from=pwa-build /app /app
EXPOSE 3000
CMD ["node", "apps/pwa/build/index.js"]
