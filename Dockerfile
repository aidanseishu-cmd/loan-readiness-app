# This image installs a real Chromium alongside Node so PDF export
# (puppeteer-core, see lib/pdf.js) works without needing puppeteer's own
# ~200MB Chromium download. lib/pdf.js already checks /usr/bin/chromium as
# one of its auto-detected paths, so no PUPPETEER_EXECUTABLE_PATH is needed
# with this image — it's set explicitly below anyway for clarity.
#
# NOTE: this Dockerfile has not been build-tested — there was no Docker
# available in the environment it was written in. It follows standard,
# well-documented patterns (Node's own slim image + Debian's chromium
# package), but if the build fails on Render, check the build log there;
# the most likely culprit is a missing shared library chromium needs, in
# which case add it to the apt-get install line below.

FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
