# Puppeteer needs a real Chromium + its shared-library dependencies, which
# aren't present in slim/base Node images — using Puppeteer's own official
# image guarantees a Chromium build that matches the installed `puppeteer`
# version and already has every required system library preinstalled.
FROM ghcr.io/puppeteer/puppeteer:25.5.0

WORKDIR /app

# Puppeteer's image runs as a non-root `pptruser` by default; that user
# needs ownership of the app directory before `npm ci` writes into it.
USER root
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN chown -R pptruser:pptruser /app
USER pptruser

ENV PORT=3000
EXPOSE 3000

CMD ["node", "src/server.js"]
