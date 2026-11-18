# Project Plan

**Status**: Planning
**Created**: 2026-10-23
**Mode**: AUGMENT

---

## 1. Project Overview

**Goal**: Extend the existing privacy-conscious local assistant into a home operations workspace with a first-party AI model built and trained from scratch, a dedicated web console, and broad Home Assistant monitoring, control, and configuration capabilities. Make opt-in continuous learning available from user-approved feedback and datasets. Design each module for independent testing.

**App Type**: SPA + API

**API Login**: Yes

**Mode**: AUGMENT

**Deployment Plan**: No deployment plan found

---

## 2. Assistant and Systems Management API — backend

| Component | Technology |
|-----------|-----------|
| **Language** | TypeScript |
| **Runtime** | Node |
| **Package Manager** | npm |
| **Test Runner** | vitest |
| **Mocking Library** | vi.mock |
| **Test Command** | npm test |
| **Orchestration** | docker-compose |

The Node.js HTTP API owns the public `/api/...` contract, input validation, conversation and preference workflows, Home Assistant connection management, policy checks, persistence, and audit records. Keep the Home Assistant adapter behind a typed interface and use the supported REST and WebSocket APIs. A capability catalog should discover the connected Home Assistant version, enabled integrations, entity domains, and available API features so the console can present every supported capability and clearly identify features the instance does not expose.

Home Assistant coverage includes device, entity, area, label, and integration discovery; state and history views; domain-aware controls for every exposed entity domain, including lights, switches, climate, covers, locks, alarm panels, media players, sensors, cameras, and other supported entities; scenes, scripts, automations, blueprints, helpers, schedules, traces, and run history; integration configuration flows; dashboards; notifications; Assist pipelines; logbook and long-term statistics; energy views; and system health, updates, repairs, backups and restores, and Supervisor add-on management when the connected installation exposes those APIs. Discover the feature matrix by Home Assistant version and installation type, and link to its native UI for operations with no supported API. Preserve Home Assistant's own behavior and permissions. Use typed service payloads and show a preview before high-impact, destructive, security-sensitive, or administrative actions. Never expose arbitrary shell execution or silently attempt unsupported APIs.

Keep the default setup local-first: Home Assistant and the assistant services run within a trusted network boundary. The project-owned model core runs inside the model worker; no external model server or hosted inference endpoint is required or called. Any later Azure-hosted deployment requires private connectivity to Home Assistant; do not expose the local Home Assistant API directly to the public internet. Store Home Assistant connection secrets in the configured secret store. The API calls the first-party TypeScript model worker over private JSON HTTP; it does not load model code into route handlers.

## 3. Assistant Web Console — frontend

| Component | Technology |
|-----------|-----------|
| **Language** | TypeScript |
| **Framework** | React + Vite |
| **Package Manager** | npm |
| **Test Runner** | vitest |
| **Mocking Library** | vi.mock |
| **Test Command** | npm test |

The console presents conversations with the first-party model, home overview, device and entity state, per-domain controls, automation and scene management, energy and activity history, integration configuration, capability availability, human review for consequential operations, and Model Lab controls for opt-in learning, evaluation, version promotion, and rollback. Home Assistant actions use typed previews and clear confirmation states.

## 4. First-Party AI and Model Learning Worker — worker

| Component | Technology |
|-----------|-----------|
| **Language** | TypeScript |
| **Runtime** | Node |
| **Package Manager** | npm |
| **Test Runner** | vitest |
| **Mocking Library** | vi.mock |
| **Test Command** | npm test |
| **Orchestration** | docker-compose |

The private TypeScript worker owns the JSON inference/training boundary and calls the project's first-party Python/PyTorch model core through an internal adapter. The custom tokenizer, architecture, training loop, and checkpoints are built in this project and initialized from random weights; do not download pretrained model weights, call Ollama or another model server, or use hosted inference APIs. Promote the existing byte-level Transformer from an optional experiment into the foundation for normal assistant chat, coding help, and typed Home Assistant intents. The API validates and previews intents; the model worker never executes Home Assistant actions or generated code.

Add an opt-in continuous-learning loop. It may use only feedback the user explicitly marks for training and approved local datasets. Keep learning disabled by default; when enabled, periodically train a separate candidate checkpoint, evaluate it on held-out quality and safety cases, and preserve the active checkpoint for rollback. Promote a candidate automatically only when the user explicitly enables auto-promotion and its configured evaluation thresholds pass; otherwise leave it pending human review. Never update active weights in place.

## 5. Services Required

| Azure Service | Role in App | Environment Variable | Default Value (Local) | Classification |
|---------------|------------|---------------------|----------------------|----------------|
| Azure Static Web Apps | Host the React assistant and Home Assistant console | `VITE_API_BASE_URL` | `http://localhost:3000` | Essential |
| Azure Container Apps | Host the public Node.js API and separate private TypeScript worker with its first-party Python/PyTorch model core | `HOME_ASSISTANT_URL`; `MODEL_WORKER_BASE_URL` | `http://homeassistant.local:8123`; `http://model-worker:8081` | Essential |
| PostgreSQL | Store private conversations, preferences, Home Assistant configuration and cached state, capability records, and action audit history | `DATABASE_URL` | `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/assistantdb` | Essential |
| Blob Storage | Store approved training corpora, candidate and active model checkpoints, evaluation artifacts, and approved file exports | `STORAGE_CONNECTION_STRING` | `UseDevelopmentStorage=true` | Essential |
| Azure Key Vault | Store secrets for the explicitly configured Home Assistant connection and other approved connectors | `KEY_VAULT_URI` | Not configured locally | Essential |

External local dependencies are a reachable Home Assistant instance with its supported API enabled, Python 3.10+, PyTorch 2.0+, and user-approved training data. The model code and weights are first-party; no separate model package, model server, pretrained checkpoint, or hosted inference service is used. Keep Home Assistant on the trusted local network unless a private network connection is configured for a cloud deployment.

## 6. Prerequisites

The tool scan found Docker 29.9.2, Docker Compose v5.6.1, and Python at `/usr/bin/python3`. Node.js, npm, the local Vitest executable, PyTorch, and VS Code's `code` command could not be confirmed in this shell. Double-check every `❓` tool before proceeding.

### Run

| Tool | Service(s) | Installed | Version |
|------|------------|-----------|---------|
| Node.js | Assistant Web Console, Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| npm | Assistant Web Console, Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| Vitest | Assistant Web Console, Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| Python | First-party model core and training loop | ✅ | Unknown |
| PyTorch (`torch`) | First-party model core and training loop | ❓ | Unknown |

### Debug

| Tool | Service(s) | Installed | Version |
|------|------------|-----------|---------|
| Docker | Assistant and Systems Management API, First-Party AI and Model Learning Worker, PostgreSQL, Blob Storage emulator | ✅ | 29.9.2 |
| Docker Compose | Assistant and Systems Management API, First-Party AI and Model Learning Worker, PostgreSQL, Blob Storage emulator | ✅ | v5.6.1 |
| VS Code JavaScript debugger (`ms-vscode.js-debug`) | Assistant Web Console, Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| VS Code Containers extension (`ms-azuretools.vscode-containers`) | Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| VS Code Azure Container Apps extension (`ms-azuretools.vscode-azurecontainerapps`) | Assistant and Systems Management API, First-Party AI and Model Learning Worker | ❓ | Unknown |
| VS Code Azure Static Web Apps extension (`ms-azuretools.vscode-azurestaticwebapps`) | Assistant Web Console | ❓ | Unknown |
| VS Code Python extension (`ms-python.python`) | First-party AI model core and learning loop | ❓ | Unknown |
| VS Code Python Debugger (`ms-python.debugpy`) | First-party AI model core and learning loop | ❓ | Unknown |

## 7. Design System & UI

**Component Library**: Fluent UI v9
**Style Direction**: Carry the technology-centered treatment through every page, using dark instrument-panel surfaces, fine grid lines, restrained cyan telemetry glow, and high-contrast labels. Replace the horizontal primary-navigation bar on every page with a page wheel: Home Overview uses the full, slightly slanted wheel, and other pages use a compact expandable wheel at the top-right of the header.
**Typography**: Inter, system-ui

### Color Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `primary` | `#000000` | Home navigation, selected areas, and primary assistant actions |
| `accent`  | `#B96A37` | Energy highlights, automation activity, and attention cues |
| `surface` | `#F3F6F6` | Home overview, room pages, and settings canvas |
| `text`    | `#192A33` | Room names, entity states, conversation content, and review details |
| `muted`   | `#63727B` | Entity identifiers, integration metadata, and timestamps |
| `border`  | `#D7E0E2` | Boundaries between room, device, automation, and activity panels |

### Pages

| Page | Route | Purpose | Layout |
|------|-------|---------|--------|
| Home Overview | `/` | Apply the tech-centered visual treatment throughout the page; replace the top horizontal navigation bar with a slightly slanted, user-controlled wheel of icon links to each planned page, centered around the holographic house. | `header, main, hero, grid, card-list, footer` |
| Conversations | `/conversations` | Continue Home Overview's technology-centered treatment through recent threads, local chat, and typed Home Assistant action previews; use the compact top-right page wheel as primary navigation. | `header, main, split(sidebar\|form)` |
| Devices & Entities | `/home/devices` | Continue the tech-centered treatment through device discovery, with a frameless entity selection, individually emphasized slanted rows, and extra breathing room on the category selector; use the compact top-right page wheel as primary navigation. | `header, main, tabs, table` |
| Automations & Scenes | `/home/automations` | Manage scenes, scripts, blueprints, helpers, schedules, automation state, and execution traces; use the compact top-right page wheel as primary navigation. | `header, main, tabs, card-list, action-bar` |
| Energy & Activity | `/home/insights` | Review energy use, long-term statistics, Home Assistant history, events, and automation activity; use the compact top-right page wheel as primary navigation. | `header, main, grid, table` |
| Integrations & Configuration | `/home/integrations` | Connect an authorized Home Assistant instance, inspect supported capabilities, and access available integration configuration flows and system tools; use the compact top-right page wheel as primary navigation. | `header, main, card-list, form` |
| Approval Queue | `/approvals` | Review consequential and administrative action proposals, decisions, and redacted audit results; use the compact top-right page wheel as primary navigation, and match Awaiting review and History to the shared primary/secondary button styles. | `header, main, tabs, table` |
| Model Lab | `/models` | Monitor the first-party model, opt-in continuous learning, candidate evaluation, version promotion, and rollback; use the compact top-right page wheel as primary navigation. | `header, main, tabs, card-list` |

### Sample Content

These records are illustrative preview fixtures, not claims about the connected Home Assistant instance, its devices, energy history, proposals, or installed models. The scaffold should replace them with live data from the configured services.

Home Overview — focal centerpiece and primary navigation: replace the horizontal navigation bar with a slightly slanted revolving wheel around a luminous wireframe house. The wheel does not autoplay; its icon links are the user controls and are selectable by pointer or keyboard. Link Overview (`/`), Conversations (`/conversations`), Devices & Entities (`/home/devices`), Automations & Scenes (`/home/automations`), Energy & Activity (`/home/insights`), Integrations & Configuration (`/home/integrations`), Approval Queue (`/approvals`), and Model Lab (`/models`) to their distinct pages. Highlight the current page. Place the connection caption below the wheel with clear spacing so it does not overlap wheel options. Selecting a link opens its page and never executes a Home Assistant action. Continue the dark instrument-panel, fine-grid, and cyan telemetry treatment through the retained brand/status header, wheel, snapshot cards, connection status, activity cards, and footer.

Other pages — navigation: remove the horizontal navigation bar from every page. On non-overview pages, the compact expandable radial wheel in the header's top-right corner is the primary navigation; its icon links lead to the same eight planned pages, with the current page visibly selected. Retain the brand/status header.

Approval Queue — view controls: style Awaiting review as the shared primary button and History as the shared secondary button, matching other page actions in shape, spacing, focus, and hover states.

Conversations — visual treatment: continue Home Overview's dark instrument-panel surfaces, fine grid, cyan focus highlights, and restrained glow through navigation, history cards, saved-prompt state, composer, and typed action-preview panel.

Devices & Entities — visual treatment: continue the dark instrument-panel, fine-grid, and cyan telemetry style through navigation, category tabs, entity list, and status details. Remove the entire outer frame around the entity selection; keep the individual rows with subtle slanted right edges. Keep a clear gap at the selector's right end and a faint blue underglow on the selected category.

Home Overview — household snapshot:
| Signal | Value | Context | State |
|--------|-------|---------|-------|
| Home Assistant | local-core | API and event stream | Connected |
| Areas and entities | 6 areas · 42 entities | Capability catalog refreshed 2 min ago | Current |
| Automations | 12 total · 9 enabled | 2 recent runs | Current |
| Energy today | 18.6 kWh | Compared with 21.1 kWh yesterday | Updating |

Home Overview — recent activity:
| Item | Detail | Time | State |
|------|--------|------|-------|
| Kitchen pendants | Turned on at 72% brightness | 7:05 PM | Completed |
| Downstairs climate | Set to 20.5°C heat | 6:45 PM | Automation |
| Garage door | Closed after arrival | 6:12 PM | Confirmed |

Conversations — recent thread:
| Conversation | Latest prompt | Updated | State |
|--------------|---------------|---------|-------|
| Evening routine check | Prepare the downstairs for 9:30 PM. | Today, 8:12 PM | Action preview |
| Energy review | Compare yesterday's evening usage. | Today, 6:40 PM | Local response |
| Garage status | Did the garage close after 6? | Yesterday, 6:18 PM | Read-only answer |

Composer — message: “Set the downstairs lights for movie night.” · Action state: “Preview before sending to Home Assistant”

Devices & Entities — entity inventory:
| Entity | Area | State | Integration |
|--------|------|-------|-------------|
| `light.kitchen_pendants` | Kitchen | On · 72% | Philips Hue |
| `climate.downstairs` | Main floor | 20.5°C · Heat | ecobee |
| `cover.garage_door` | Garage | Closed | Z-Wave JS |

Automations & Scenes — automation:
| Name | Trigger | State | Recent trace |
|------|---------|-------|--------------|
| Evening lights | Sunset + 15 min | Enabled | Completed · 7:15 PM |
| Hold nursery at 19°C | Daily · 7:00 PM–6:00 AM | Enabled | Completed · 7:00 PM |
| Garage left open alert | Open 10 min after sunset | Enabled | No recent run |

Automations & Scenes — scenes: Arrive Home · Dinner · All Lights Off. Helpers: Guest Mode schedule · Quiet Hours toggle.

Energy & Activity — energy summary:
| Measure | Today | Comparison | State |
|---------|-------|------------|-------|
| Whole-home electricity | 18.6 kWh | 11.8% below yesterday | Updated 2 min ago |
| Heat pump | 8.4 kWh | 1.2 kWh above yesterday | Current |
| Grid import | 15.2 kWh | Solar supplied 3.4 kWh | Current |

Energy & Activity — event log:
| Event | Source | Time | State |
|-------|--------|------|-------|
| Kitchen pendants turned on | Manual service call | 7:05 PM | Recorded |
| Downstairs target set to 20.5°C | Evening lights automation | 6:45 PM | Recorded |
| Garage door closed | Z-Wave JS | 6:12 PM | Recorded |

Integrations & Configuration — connection:
| Integration | Coverage | Last update | State |
|-------------|----------|-------------|-------|
| Home Assistant Core | 6 areas · 42 entities | 2 min ago | Connected |
| Zigbee Home Automation | 18 entities | 4 min ago | Available |
| First-party AI model | Byte-level Transformer · project-owned weights | Active checkpoint v0.1 | Ready |

Connection form — Home Assistant URL: `http://homeassistant.local:8123` · Instance name: `local-core` · API status: `Connected`

Approval Queue — proposed operation:
| Proposal | Requested change | Submitted | State |
|----------|------------------|-----------|-------|
| OPS-204 | Unlock front door for a scheduled guest arrival | Today, 7:52 PM | Awaiting review |
| OPS-203 | Change garage auto-close delay to 10 minutes | Today, 7:31 PM | Awaiting review |
| OPS-201 | Reload the water-leak sensor integration | Today, 6:55 PM | Approved · recorded |

Model Lab — first-party model and opt-in learning:
| Record | Configuration or measure | Result | State |
|--------|--------------------------|--------|-------|
| First-party assistant model | Byte-level Transformer · 2 layers · 4 heads · 64 dimensions | Active checkpoint v0.1 | Local |
| Continuous learning | User feedback and approved datasets | Disabled until user opts in | Off |
| Candidate evaluation | 200 held-out prompts | No score recorded | Not run |

## 8. Project Structure

```text
project-root/
├── .azure/
│   ├── requirements.json              # Submitted project answers
│   ├── project-plan.md
│   └── .preview-temp/                 # Planning-only visual previews
├── README.md                          # Document the first-party model and opt-in learning controls
├── app.py                             # Existing local model training GUI
├── local_assistant_gui.py             # Existing desktop chat GUI, wired to first-party inference
├── LocalAssistant.desktop             # Existing desktop launcher
├── scripts/
│   └── launch-local-assistant.sh      # Existing local launch workflow
├── local_model.py                     # First-party byte-level Transformer inference/training core
├── requirements.txt                   # Python/PyTorch model-core dependencies
├── tests/
│   ├── test_local_model.py
│   └── test_worker.py
├── package.json                       # TypeScript workspace configuration
├── docker-compose.yml                 # API, worker, PostgreSQL, and Azurite
└── services/
    ├── assistant-api/
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── src/
│   │   ├── routes/                 # Assistant, Home Assistant, and model-learning API routes
│   │   ├── services/               # Conversations, policy, audit, learning consent, and capability catalog
    │   │   ├── connectors/
    │   │   │   └── home-assistant/     # REST/WebSocket adapter and version-aware features
    │   │   └── repositories/           # PostgreSQL persistence and migrations
    │   └── tests/
    ├── assistant-web/
    │   ├── package.json
    │   ├── vite.config.ts
    │   └── src/
    │       ├── api/                    # Typed API client
    │       ├── components/             # Fluent UI home controls and review dialogs
    │       └── pages/                  # Overview, chat, devices, automations, energy, settings
    └── model-worker/
        ├── Dockerfile
        ├── package.json
        ├── src/
        │   ├── worker.ts               # Private JSON HTTP boundary for first-party inference and learning
        │   ├── model-adapter.ts        # Internal bridge to the project's Python/PyTorch model core
        │   ├── learning-coordinator.ts # Opt-in feedback, candidate training, evaluation, and promotion
        │   └── checkpoint-store.ts     # Versioning and rollback for first-party checkpoints
        └── tests/
```

## 9. Route Definitions

Home Assistant routes expose only capabilities supported by the connected instance. They use typed, domain-aware request schemas and the capability catalog; unsupported operations return a clear capability error. Natural-language output is treated as an intent until the API validates it, applies the configured policy, and obtains any required confirmation.

| # | Method | Path | Description | Request Body | Response Body | Status Codes |
|---|--------|------|-------------|--------------|---------------|--------------|
| 1 | GET | `/api/health` | API, database, worker, and connector health | — | `{ status, services }` | 200, 503 |
| 2 | GET | `/api/conversations` | List private assistant conversations | — | `{ items: [{ id, title, updatedAt }] }` | 200 |
| 3 | POST | `/api/conversations` | Create a conversation | `{ title }` | `{ id, title, createdAt }` | 201, 422 |
| 4 | GET | `/api/conversations/{conversation_id}/messages` | Read conversation messages | — | `{ items: [{ id, role, content, createdAt }] }` | 200, 404 |
| 5 | POST | `/api/conversations/{conversation_id}/messages` | Add a prompt and request a local model response | `{ content }` | `{ userMessage, assistantDraft, reviewRequired }` | 201, 404, 422, 503 |
| 6 | GET | `/api/home/capabilities` | Return discovered Home Assistant version, domains, and supported feature matrix | — | `{ instance, version, features, unsupported }` | 200, 503 |
| 7 | GET | `/api/home/overview` | Return area, entity, automation, energy, and connection summary | — | `{ areas, entities, automations, energy, connection }` | 200, 503 |
| 8 | GET | `/api/home/areas` | List areas and their device/entity counts | — | `{ items: [{ id, name, deviceCount, entityCount }] }` | 200, 503 |
| 9 | PATCH | `/api/home/areas/{area_id}` | Rename an area or update its labels | `{ name, labels }` | `{ id, name, labels }` | 200, 404, 422, 503 |
| 10 | GET | `/api/home/devices` | List devices with integration, area, and health metadata | `?areaId=&integrationId=` | `{ items: [{ id, name, areaId, integration, status }] }` | 200, 503 |
| 11 | GET | `/api/home/devices/{device_id}` | Read device information and linked entities | — | `{ id, name, area, integration, entities }` | 200, 404 |
| 12 | PATCH | `/api/home/devices/{device_id}` | Update supported registry fields such as name, area, or labels | `{ name, areaId, labels }` | `{ id, name, areaId, labels }` | 200, 404, 422, 503 |
| 13 | GET | `/api/home/entities` | Filter entities by area, device, domain, label, or state | `?areaId=&deviceId=&domain=&label=` | `{ items: [{ entityId, name, domain, area, state, attributes }] }` | 200, 503 |
| 14 | GET | `/api/home/entities/{entity_id}` | Read entity state, supported controls, and metadata | — | `{ entityId, state, attributes, capabilities }` | 200, 404, 503 |
| 15 | GET | `/api/home/entities/{entity_id}/history` | Read entity history when recorder data is available | `?start=&end=` | `{ items: [{ state, changedAt }] }` | 200, 404, 503 |
| 16 | POST | `/api/home/entities/{entity_id}/actions` | Preview or run a typed domain service action | `{ action, parameters, preview }` | `{ actionId, preview, status, changedEntities }` | 200, 202, 404, 422, 503 |
| 17 | GET | `/api/home/scenes` | List scenes and linked entities | — | `{ items: [{ id, name, entityCount, lastActivatedAt }] }` | 200, 503 |
| 18 | POST | `/api/home/scenes/{scene_id}/activate` | Activate a supported scene | `{ preview }` | `{ id, status, changedEntities }` | 200, 404, 422, 503 |
| 19 | GET | `/api/home/automations` | List automations, schedules, and enabled state | `?enabled=&areaId=` | `{ items: [{ id, name, enabled, lastTriggeredAt }] }` | 200, 503 |
| 20 | POST | `/api/home/automations` | Create an automation from a validated trigger/condition/action definition | `{ name, triggers, conditions, actions }` | `{ id, name, status }` | 201, 422, 503 |
| 21 | PATCH | `/api/home/automations/{automation_id}` | Update a supported automation definition or enabled state | `{ name, triggers, conditions, actions, enabled }` | `{ id, name, enabled, status }` | 200, 404, 422, 503 |
| 22 | POST | `/api/home/automations/{automation_id}/actions` | Enable, disable, or manually run an automation | `{ action, preview }` | `{ id, action, status, runId }` | 200, 404, 422, 503 |
| 23 | GET | `/api/home/automations/{automation_id}/traces` | Read recent automation traces and execution errors | `?limit=` | `{ items: [{ runId, startedAt, result, trace }] }` | 200, 404, 503 |
| 24 | GET | `/api/home/scripts` | List supported scripts and blueprints | `?kind=script%7Cblueprint` | `{ items: [{ id, name, kind, status }] }` | 200, 503 |
| 25 | POST | `/api/home/scripts/{script_id}/run` | Run a script with validated parameters | `{ parameters, preview }` | `{ id, status, runId }` | 200, 404, 422, 503 |
| 26 | GET | `/api/home/helpers` | List supported helpers and schedules | — | `{ items: [{ id, name, kind, state, schedule }] }` | 200, 503 |
| 27 | GET | `/api/home/history` | Read logbook events and recent state changes | `?start=&end=&entityId=` | `{ items: [{ event, entityId, source, createdAt }] }` | 200, 503 |
| 28 | GET | `/api/home/statistics` | Read long-term statistics when recorder support is enabled | `?statisticIds=&start=&end=` | `{ items: [{ statisticId, points }] }` | 200, 503 |
| 29 | GET | `/api/home/energy` | Read configured energy dashboard and source summaries | `?period=` | `{ period, sources, consumption, production }` | 200, 503 |
| 30 | GET | `/api/home/dashboards` | List dashboards visible through the connected instance | — | `{ items: [{ id, title, path, editable }] }` | 200, 503 |
| 31 | GET | `/api/home/integrations` | List configured integrations, config flows, and health | — | `{ items: [{ id, name, version, status, entities }] }` | 200, 503 |
| 32 | POST | `/api/home/integrations/config-flows` | Start an integration configuration flow when supported | `{ integrationId, input }` | `{ flowId, step, fields }` | 201, 404, 422, 503 |
| 33 | POST | `/api/home/integrations/config-flows/{flow_id}/steps/{step_id}` | Submit a validated configuration-flow step | `{ input }` | `{ flowId, step, fields, status }` | 200, 404, 409, 422, 503 |
| 34 | GET | `/api/home/notifications` | List notifications from supported Home Assistant channels | `?status=&limit=` | `{ items: [{ id, title, channel, createdAt, status }] }` | 200, 503 |
| 35 | GET | `/api/home/diagnostics` | Read supported diagnostics, repairs, and backup capabilities | — | `{ features, items }` | 200, 503 |
| 36 | POST | `/api/home/assist/intents` | Convert a local text or voice transcript into a typed Home Assistant intent | `{ text, conversationId }` | `{ intent, target, parameters, requiresConfirmation }` | 200, 422, 503 |
| 37 | POST | `/api/assistant/actions/{action_id}/confirm` | Confirm or reject a pending high-impact action preview | `{ decision, note }` | `{ id, status, decisionAt, auditRecordId }` | 200, 404, 409, 422 |
| 38 | GET | `/api/operations/proposals` | List proposed administrative and Home Assistant actions | — | `{ items: [{ id, summary, status, submittedAt, decisionAt }] }` | 200 |
| 39 | POST | `/api/operations/proposals` | Create an allowlisted operation proposal | `{ operationId, parameters, rationale }` | `{ id, status, impact, expiresAt }` | 201, 404, 422 |
| 40 | POST | `/api/operations/proposals/{proposal_id}/decision` | Record a human approval or rejection; recording approval does not itself execute the operation | `{ decision, note }` | `{ id, status, decisionAt, auditRecordId }` | 200, 404, 409, 422 |
| 41 | GET | `/api/models/training-runs` | List first-party model training and learning runs | — | `{ items: [{ id, status, step, candidateCheckpointId }] }` | 200 |
| 42 | POST | `/api/models/training-runs` | Queue bounded training on approved data to create a candidate checkpoint | `{ datasetId, maxSteps, config }` | `{ id, status, createdAt, candidateCheckpointId }` | 202, 422, 503 |
| 43 | GET | `/api/models/checkpoints` | List first-party model versions, evaluation results, and rollback availability | — | `{ items: [{ id, createdAt, config, evaluationStatus, active }] }` | 200 |
| 44 | POST | `/api/models/evaluations` | Evaluate a checkpoint on a held-out dataset | `{ checkpointId, datasetId }` | `{ id, status, createdAt }` | 202, 404, 422, 503 |
| 45 | POST | `/internal/v1/inference` | Private API-to-worker inference request using the active first-party checkpoint | `{ requestId, messages, modelVersion }` | `{ requestId, generatedText, modelVersion }` | 200, 422, 503 |
| 46 | GET | `/api/home/voice/pipelines` | List available Assist pipelines and supported input/output modes | — | `{ items: [{ id, name, language, input, output }] }` | 200, 503 |
| 47 | POST | `/api/home/dashboards` | Create a dashboard when the connected instance exposes dashboard management | `{ title, path, views }` | `{ id, title, path, status }` | 201, 404, 422, 503 |
| 48 | PATCH | `/api/home/dashboards/{dashboard_id}` | Update a supported dashboard definition | `{ title, views }` | `{ id, title, status }` | 200, 404, 422, 503 |
| 49 | GET | `/api/home/system/updates` | List Home Assistant Core, OS, and add-on updates when available | — | `{ items: [{ id, name, currentVersion, availableVersion }] }` | 200, 503 |
| 50 | POST | `/api/home/system/updates/{update_id}/actions` | Preview, confirm, or defer an available update | `{ action, preview }` | `{ id, status, confirmationRequired }` | 200, 404, 409, 422, 503 |
| 51 | GET | `/api/home/supervisor/addons` | List add-ons when the connected installation has Supervisor APIs | — | `{ items: [{ id, name, state, version, updateAvailable }] }` | 200, 503 |
| 52 | POST | `/api/home/supervisor/addons/{addon_id}/actions` | Preview and manage supported add-on lifecycle actions | `{ action, preview }` | `{ id, action, status, confirmationRequired }` | 200, 404, 409, 422, 503 |
| 53 | GET | `/api/home/backups` | List backups when backup APIs are available | — | `{ items: [{ id, name, createdAt, size, status }] }` | 200, 503 |
| 54 | POST | `/api/home/backups` | Create an on-demand backup when supported | `{ name, include }` | `{ id, status, createdAt }` | 202, 422, 503 |
| 55 | POST | `/api/home/backups/{backup_id}/restore` | Preview and confirm a backup restore | `{ sections, preview }` | `{ id, status, confirmationRequired }` | 202, 404, 409, 422, 503 |
| 56 | GET | `/api/home/repairs` | List repair issues and system diagnostics when supported | — | `{ items: [{ id, issue, severity, createdAt, status }] }` | 200, 503 |
| 57 | POST | `/api/home/repairs/{repair_id}/actions` | Dismiss or resolve an available repair issue | `{ action, preview }` | `{ id, status }` | 200, 404, 409, 422, 503 |
| 58 | GET | `/api/models/learning/settings` | Read opt-in learning and auto-promotion preferences | — | `{ enabled, autoPromote, retentionDays }` | 200 |
| 59 | PATCH | `/api/models/learning/settings` | Enable or disable feedback learning and separately opt in to automatic promotion | `{ enabled, autoPromote, retentionDays }` | `{ enabled, autoPromote, updatedAt }` | 200, 422 |
| 60 | POST | `/api/models/feedback` | Store explicit model feedback, corrections, and training consent | `{ conversationId, messageId, rating, correction, useForTraining }` | `{ id, status, trainingConsent }` | 201, 422 |
| 61 | GET | `/api/models/learning/runs` | List candidate learning runs and held-out evaluation results | `?status=` | `{ items: [{ id, sourceCount, status, evaluation, candidateCheckpointId }] }` | 200 |
| 62 | POST | `/api/models/learning/runs` | Start a bounded candidate update from consented feedback and approved datasets | `{ datasetIds, feedbackIds, maxSteps }` | `{ id, status, candidateCheckpointId }` | 202, 422, 503 |
| 63 | POST | `/api/models/checkpoints/{checkpoint_id}/promote` | Activate an evaluated candidate after consent or configured auto-promotion policy | `{ evaluationId, decision }` | `{ activeCheckpointId, promotedAt, priorCheckpointId }` | 200, 404, 409, 422 |
| 64 | POST | `/api/models/checkpoints/{checkpoint_id}/rollback` | Restore a prior first-party model checkpoint | `{ reason }` | `{ activeCheckpointId, rolledBackAt }` | 200, 404, 409, 422 |

All errors use `{ "error": { "code": "NOT_FOUND", "message": "Item not found", "details": null } }`; shared codes are `VALIDATION_ERROR` (422), `BAD_REQUEST` (400), `NOT_FOUND` (404), `CONFLICT` (409), `FORBIDDEN` (403), and `INTERNAL_ERROR` (500).

## 10. Next Steps

1. Run **azure-project-scaffold** to execute this plan after it is approved
2. Run **azure-project-integrate** to wire the frontend to live data, smoke-test the backend, and create the migrations
3. Run **azure-debug-plan** → **azure-debug-generate** for Docker emulators and VS Code debugging
4. Run the **azure-deploy** agent when ready; it uses **azure-app-onboard** for architecture, cost estimation, IaC generation, provisioning, and health verification
