FROM node:22-bookworm-slim
WORKDIR /app
COPY services/shared/package.json services/shared/tsconfig.json ./services/shared/
COPY services/shared/src ./services/shared/src
RUN npm install --prefix /app/services/shared --workspaces=false \
  && npm run build --prefix /app/services/shared
COPY services/assistant-api/package.json services/assistant-api/tsconfig.json ./services/assistant-api/
WORKDIR /app/services/assistant-api
RUN npm install --workspaces=false
COPY services/assistant-api/src ./src
RUN npm run build
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
