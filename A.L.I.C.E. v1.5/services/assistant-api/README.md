# Assistant API backend

`npm run build --workspace=services/assistant-api` builds the public Node `node:http` API.
It requires the shared workspace to be built first. `npm run dev --workspace=services/assistant-api`
starts a watch-mode development server; no process is started by the scaffold.

## Persistence contract

The initial PostgreSQL schema is managed by Knex migrations in `migrations/`. Apply it with
`npm run migrate --workspace=services/assistant-api` after setting `DATABASE_URL`. Migrations
create schema only; no seed or demonstration rows are added. The schema contains these tables:

| Collection / concept | PostgreSQL table |
| --- | --- |
| Accounts and password hashes | `users` |
| Private conversation headers | `conversations` |
| User and assistant messages | `conversation_messages` |
| Enrolled connector inventory and latest health snapshot | `enrolled_systems` |
| Read-only diagnostic audit/activity | `diagnostic_activity` |
| Human-reviewed operation proposals | `operation_proposals` |
| Append-only audit records | `audit_records` |
| Approved training corpora | `approved_corpora` |
| Training run state | `training_runs` |
| Versioned model checkpoints | `model_checkpoints` |
| Evaluation requests and measured results | `model_evaluations` |

All owner-scoped tables include `owner_id`; connector credentials are referenced only
through enrolled-system records and read from the Key Vault provider. Multi-table writes
use explicit PostgreSQL transactions. The migration command creates the schema but no sample rows.

Blob object mappings are `model-checkpoints/{checkpoint-id}.pt` for versioned model
weights and `approved-corpora/{approved-id}.txt` for approved training/evaluation data.
The enrolled-system `connector_secret_name` reference is the only route to a Key Vault
secret; secret values are never returned or logged.

`GET /openapi.json` serves the public API contract. Internal worker endpoints are only
implemented by the model-worker service, which has no host-published port.

For the full local stack, copy `.env.example` to `.env` and run `docker compose up --build`.
To run the Node processes directly, start the PostgreSQL and Azurite dependencies, run
`PORT=8081 npm run dev --workspace=services/model-worker`, then
`npm run dev --workspace=services/assistant-api`. The API uses an exact configured web
origin for credentialed CORS and CSRF origin checks.
