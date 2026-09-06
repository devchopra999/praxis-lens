FROM node:20-alpine

# docker-cli/compose-plugin let this service drive `docker compose`; git is needed for repository-manager.
# python3/pip install aider-chat, the CLI aider-manager.js shells out to.
RUN apk add --no-cache docker-cli docker-cli-compose git python3 py3-pip \
  && pip install --no-cache-dir --break-system-packages aider-chat

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
