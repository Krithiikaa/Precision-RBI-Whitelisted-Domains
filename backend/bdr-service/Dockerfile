FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY bdr.js ./
EXPOSE 3002
CMD ["node", "bdr.js"]
