FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
COPY prompts/ prompts/
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY --from=builder /app/dist dist/
COPY prompts/ prompts/

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/main.js"]
