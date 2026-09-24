# Repository Custodian chat agent (runs on Amazon ECS Fargate).
# Stage 1 builds the web client and bundles the agent server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build && node scripts/build.mjs agent

# Stage 2: small runtime image with only the bundle and the static files.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 STATIC_DIR=/app/dist
COPY --from=build /app/dist ./dist
COPY --from=build /app/build/agent/main.mjs ./main.mjs
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "main.mjs"]
