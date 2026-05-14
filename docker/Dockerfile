FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json bun.lock ./
RUN npm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
COPY prompts/ prompts/
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN npm install --frozen-lockfile --production
COPY --from=builder /app/dist dist/
COPY prompts/ prompts/

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/main.js"]
