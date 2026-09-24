# Node 24 LTS (validado com node:sqlite embutido e whatsapp-web.js >= Node 18)
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
# patches/ antes do npm ci: o postinstall (patch-package) corrige o whatsapp-web.js 1.34.7.
# Sem a pasta, o patch-package não acha patches e a imagem sai sem a correção de envio.
COPY patches ./patches
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    TZ=UTC
# Chromium do sistema para o whatsapp-web.js (Puppeteer) + fontes para renderizar o WhatsApp Web
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY docs ./docs
RUN mkdir -p /app/data /app/wa-session && chown -R node:node /app
USER node
EXPOSE 8080
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
