FROM node:22.20.0-bookworm-slim AS builder
WORKDIR /app
ENV CI=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Compiles Solidity, validates launch code and produces the real Vite browser interface.
RUN npm run build
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22.20.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=builder --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=40s --timeout=10s --start-period=90s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","console/runtime.mjs"]
