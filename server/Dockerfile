FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir /data && chown node /data
COPY src ./src
COPY test ./test
ENV DATA_DIR=/data
USER node
EXPOSE 3000
CMD ["node", "src/index.js"]
