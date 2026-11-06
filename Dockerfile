# 빌드: 관리자 웹 + 서버를 한 이미지로
FROM node:25-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web build && pnpm --filter server build

FROM node:25-slim
WORKDIR /app
ENV NODE_ENV=production WEB_DIR=/app/web/dist DATA_DIR=/data
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod --filter server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
WORKDIR /app/server
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
