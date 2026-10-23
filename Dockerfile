# liara-agent web UI (Next.js) for local Docker runs.
#   docker compose up -d --build      → http://localhost:3200
# Secrets are NOT baked into the image: compose passes .env at runtime (env_file).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# build tools only matter if better-sqlite3 has no prebuilt binary for this platform
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
# Route modules may read config while Next collects page data; no real credentials exist at build time.
RUN LIARA_API_TOKEN=build-time-placeholder npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# git: the deploy assistant can clone a public GitHub repo
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3000 \
  HOSTNAME=0.0.0.0
# Playbooks (YAML), knowledge docs and demo fixtures are read from the source tree at runtime.
COPY --from=build /app ./
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
