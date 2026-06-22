FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
COPY src ./src
COPY assets ./assets
# Bundle the React app locally (no runtime CDN dependency — air-gap compliant).
RUN mkdir -p public/fonts \
 && npm run build \
 && cp src/index.html public/index.html \
 && cp assets/fonts/*.woff2 public/fonts/
EXPOSE 3000
CMD ["node", "server.js"]
