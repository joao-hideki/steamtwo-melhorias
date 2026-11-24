# Imagem única usada pelos serviços migrate, api e sync do docker-compose.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# node-pg-migrate (devDependency) é necessário para rodar as migrações no container.
RUN npm ci --no-audit --no-fund --include=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY server ./server
COPY shared ./shared
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1
CMD ["node", "server/index.js"]
