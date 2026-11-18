# Integration Handoff

## Backend
- API: `services/assistant-api/`; Node.js `node:http`; `npm run dev --workspace=services/assistant-api`; port `3000`; health `GET /api/health`; build `npm run build --workspace=services/assistant-api`.
- Worker: `services/model-worker/`; private JSON HTTP on port `8081`; `npm run dev --workspace=services/model-worker`; build `npm run build --workspace=services/model-worker`; root Python `local_model.py` via `services/model-worker/worker-bridge.py` (requires Python and PyTorch).
- Full local stack: `docker compose up --build`; stop with `docker compose down`.

## Frontend
- Folder: `services/assistant-web/`; build `npm --prefix services/assistant-web run build`; dev `npm --prefix services/assistant-web run dev`.
- Live-client seam: `services/assistant-web/src/api/index.ts` exports the typed live client from `client.ts`; page/component call sites use the `ApiClient` interface.
- Mock-only client, data, preview state, test, and switcher were removed during integration. Authentication UI/session in `AuthContext.tsx` and `AuthPages.tsx` uses live registration/login/current-user/logout endpoints; no seeded user is expected.

## Public API routes
- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/{conversation_id}/messages`
- `POST /api/conversations/{conversation_id}/messages`
- `GET /api/systems`
- `GET /api/systems/events` (SSE)
- `GET /api/systems/{system_id}/diagnostics`
- `POST /api/systems/{system_id}/diagnostics/{diagnostic_id}`
- `GET /api/terminal/activity`
- `GET /api/operations/proposals`
- `POST /api/operations/proposals`
- `POST /api/operations/proposals/{proposal_id}/decision`
- `GET /api/models/training-runs`
- `POST /api/models/training-runs`
- `GET /api/models/checkpoints`
- `POST /api/models/evaluations`
- OpenAPI: `GET /openapi.json`

## Private worker routes
- `POST /internal/v1/inference`
- `POST /internal/v1/training-runs`
- `GET /internal/v1/training-runs/{run_id}`
- `POST /internal/v1/evaluations`
- `GET /internal/v1/evaluations/{evaluation_id}`

## Database and migrations
- PostgreSQL; driver `pg`; connection variable `DATABASE_URL` (example in `.env.example`).
- PostgreSQL migrations use Knex under `services/assistant-api/migrations/`; apply them with `npm run migrate --workspace=services/assistant-api` after setting `DATABASE_URL`.
- Collections/tables are documented in `services/assistant-api/README.md` (users, conversations, conversation_messages, enrolled_systems, diagnostic_activity, operation_proposals, audit_records, approved_corpora, training_runs, model_checkpoints, model_evaluations).
- **Create schema migrations only; explicitly create NO seed data.**
- Local dependencies/emulators: `docker-compose.yml` provisions PostgreSQL and Azurite when Docker Compose is available. The Azurite VS Code extension can start the emulator locally; production endpoints use `AZURE_STORAGE_BLOB_ENDPOINT` and `KEY_VAULT_URI` with managed identity.

## Shared contracts and auth
- Shared package: `services/shared/`, import alias `@assistant/shared`; schemas and shared backend types exported from `services/shared/src/index.ts`.
- Auth endpoints and middleware are implemented in `services/assistant-api/src/server.ts`; auth interface/service in `services/assistant-api/src/auth-service.ts`; token/cookie handling in `services/assistant-api/src/security.ts`.
- Production signing configuration: `JWT_SECRET` (required outside Development); session cookie is HttpOnly and Secure outside Development.

## Services
- Essential: Azure Static Web Apps (`VITE_API_BASE_URL`), Azure Container Apps (public API + private model worker; `MODEL_WORKER_BASE_URL`), PostgreSQL (`DATABASE_URL`), Blob Storage (`AZURE_STORAGE_BLOB_ENDPOINT`; local `AZURITE_CONNECTION_STRING`), Azure Key Vault (`KEY_VAULT_URI`).
- Enhancement: none specified.

## Integration results (2026-10-22)

The UI preview approval gate was bypassed at the user's direction. Integration work proceeded, but the integration is **not complete** because the required local dependencies are unavailable in this environment.

- **Schema implementation verified:** `services/assistant-api/migrations/20261022000000_initial_schema.cjs` defines the 11 relational tables documented above, with keys, foreign keys, checks, and indexes. It contains no data inserts or seed/fixture content.
- **Migration application blocked:** `npm run migrate --workspace=services/assistant-api` was attempted against local PostgreSQL and failed with `ECONNREFUSED 127.0.0.1:5432`. No migration was applied.
- **Frontend wiring verified:** `src/api/index.ts` selects the typed live client; Vite proxies `/api` and `/openapi.json` to `localhost:3000`. Mock-client, mock-data, preview-state, and switcher references are absent from `services/assistant-web/src`.
- **Builds and tests:** `npm run build` passed for all workspaces (Vite reported a large-chunk advisory). API tests passed (2); worker tests passed (1); Python tests passed (4; PyTorch emitted a NumPy-unavailable warning). The frontend test command has no test files and exits with code 1.
- **Backend and worker startup blocked:** API startup failed its PostgreSQL connection check (`ECONNREFUSED 127.0.0.1:5432`); worker startup failed its Azurite connection check (`ECONNREFUSED 127.0.0.1:10000`). Docker and local PostgreSQL executables are unavailable here.
- **End-to-end verification pending:** Because the API and worker could not start without PostgreSQL and Azurite, no live frontend-to-backend request or write path could be verified.

No Azure resources were deployed and no commit was made. Keep project status at `Integrating` until migrations apply, endpoint smoke checks pass, and the live end-to-end path is verified.

### Follow-up integration pass (2026-10-22)

- Removed the mock login defaults and aligned account creation validation with the API's 12-character password minimum.
- Conversation and system pages now select the first live record instead of requesting mock-only IDs.
- Proposal API responses now preserve rationale separately from the allowlisted operation summary; expired proposals are displayed as expired rather than awaiting review.
- Replaced remaining fixture/demo wording in the integrated UI and documented how to apply the schema-only Knex migration.
- **Validation:** `npm run build` passed for all workspaces; API tests passed (2), worker tests passed (1), and `git diff --check` passed.
- **Still blocked:** PostgreSQL and Azurite are not running and no Docker/Podman runtime is installed. The migration cannot be applied and endpoint plus live frontend/backend smoke checks remain pending; integration is not complete.

### Local service verification (2026-10-22)

- Started the installed Azurite extension's service entry point on `127.0.0.1:10000-10002`. The repository's Azure Storage SDK requests API version `2026-10-06`, which this Azurite release does not yet accept by default, so local startup uses Azurite's `--skipApiVersionCheck` option.
- Fixed the Azurite development connection strings in `.env.example` and `docker-compose.yml`: the previous shortened account key did not authenticate. With the documented development key, the model worker created its local containers and `GET /health` returned HTTP 200.
- PostgreSQL still blocks the public API and migration. The installed PostgreSQL VS Code extension is a client; its local-server option uses Docker, but no PostgreSQL server, Docker, or Podman is available. A user-level package download required approval that was unavailable. No `.env` or PostgreSQL endpoint is configured.
- Python 3.14 is present, but the project's required `torch` dependency is absent. Worker health is verified, but inference/training/evaluation operations cannot be fully smoke-tested until that dependency is installed.
- **Current status:** frontend/backend builds and API/worker unit tests pass; Azurite and worker health pass. Migration application, public API smoke tests, and full end-to-end validation remain pending PostgreSQL connectivity (and model operations additionally require PyTorch).

### Completed integration pass (2026-10-23)

- Applied `20261022000000_initial_schema.cjs` with Knex to a temporary PGlite PostgreSQL-wire server; verified all 11 application tables and zero initial application rows. The migration creates schema only; no seed data was added. Native PostgreSQL was unavailable because Docker, Podman, and PostgreSQL server binaries are not installed.
- Started Azurite, the model worker, and the public API. Health returned `200`; all public route patterns and all private worker route patterns returned their expected success, validation, not-found, or documented service-unavailable status.
- Fixed PostgreSQL parameter type inference in auth audit writes: actor UUID and text entity ID now use separate bind parameters. Registration, login, and logout passed after the fix.
- Installed CPU PyTorch 2.14.1 in a temporary virtual environment outside the repository. All four Python model tests passed; worker inference returned `200`.
- Built API, worker, and frontend successfully. API tests passed (2), worker tests passed (1); frontend source search found no mock, preview-state, or fixture references.
- Browser E2E through Vite's `/api` proxy: registration and login succeeded; empty live overview rendered; conversation list returned `200`; posting a prompt returned `201` with a generated assistant draft; reloaded UI rendered both persisted messages from the API.
- Validation used an in-memory PGlite-compatible runtime rather than a native PostgreSQL server. Test account and conversation records were temporary and disappeared when the database process stopped. No Azure resources were deployed and no commit was made.
- **Status:** integration steps complete; native PostgreSQL verification remains an environment-level follow-up.
