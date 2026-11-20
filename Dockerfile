FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
COPY tsconfig.json ./
USER node
EXPOSE 8080
ENTRYPOINT ["./node_modules/.bin/tsx", "server/index.ts"]
