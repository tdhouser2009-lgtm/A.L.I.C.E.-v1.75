# Build the TypeScript worker and the shared contracts.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY services/shared/package.json services/shared/tsconfig.json ./services/shared/
COPY services/shared/src ./services/shared/src
RUN npm install --prefix /app/services/shared --workspaces=false && npm run build --prefix /app/services/shared
COPY services/model-worker/package.json services/model-worker/tsconfig.json ./services/model-worker/
WORKDIR /app/services/model-worker
RUN npm install --workspaces=false
COPY services/model-worker/src ./src
RUN npm run build && npm prune --omit=dev --workspaces=false

# Runtime: Python + CPU PyTorch for A.L.I.C.E.'s model core, plus Node for the worker.
FROM python:3.12-slim-bookworm
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch>=2.0"
WORKDIR /app
COPY local_model.py model_bridge.py ./
COPY alice ./alice
COPY --from=build /app/services/shared ./services/shared
COPY --from=build /app/services/model-worker ./services/model-worker
ENV NODE_ENV=production PORT=8081 MODEL_CORE_DIR=/app PYTHON=python3
WORKDIR /app/services/model-worker
EXPOSE 8081
CMD ["node", "dist/src/worker.js"]
