FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=5173
ENV SLIDE_STUDIO_DATA_DIR=/var/data
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 5173

CMD ["npm", "start"]
