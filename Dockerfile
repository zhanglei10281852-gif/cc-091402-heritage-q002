FROM node:22-alpine AS base
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY reference ./reference
FROM base AS test
ENV NODE_ENV=test
COPY tests ./tests
CMD ["npm", "test"]
FROM base AS runtime
EXPOSE 8000
CMD ["npm", "start"]
