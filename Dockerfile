FROM node:20-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install

COPY prisma ./prisma
RUN npx prisma generate

COPY . .

EXPOSE 3000

# Runs directly via tsx — no separate build step needed.
# `npm run typecheck` is available separately for CI / pre-commit checks.
CMD ["npx", "tsx", "src/index.ts"]
