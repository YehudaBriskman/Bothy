# Multi-stage: node builds the Vite app, nginx serves the static dist/.
FROM node:24-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json* ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
