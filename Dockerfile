FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm install
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN npm install --omit=dev && npm cache clean --force
EXPOSE 9900
CMD ["npm", "start"]
