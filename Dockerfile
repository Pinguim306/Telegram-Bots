FROM node:22-slim AS build

WORKDIR /app

# better-sqlite3 pode precisar compilar se não houver binário pré-compilado para a plataforma.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# config/ é lido em tempo de execução: montar como volume permite ajustar
# limiares e códigos de referral sem rebuild da imagem.
COPY config ./config

RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

VOLUME ["/app/data"]

CMD ["node", "dist/bots/signals/index.js"]
