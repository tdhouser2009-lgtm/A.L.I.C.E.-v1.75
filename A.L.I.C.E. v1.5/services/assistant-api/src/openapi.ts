import { ErrorCode } from "@assistant/shared";

export const openApi = {
  openapi: "3.1.0",
  info: { title: "Private Assistant Workspace API", version: "1.0.0" },
  servers: [{ url: "/" }],
  paths: {
    "/openapi.json": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "OpenAPI document" } } } },
    "/api/health": { get: { summary: "API and dependency health", responses: { "200": { description: "Healthy" }, "503": { description: "Unavailable" } } } },
    "/api/auth/register": { post: { summary: "Register account", responses: { "201": { description: "Registered" } } } },
    "/api/auth/login": { post: { summary: "Create short-lived session", responses: { "200": { description: "Authenticated" } } } },
    "/api/auth/me": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Current user" } } } },
    "/api/auth/logout": { post: { responses: { "204": { description: "Signed out" } } } },
    "/api/conversations": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Conversation list" } } }, post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "201": { description: "Created" } } } },
    "/api/conversations/{conversation_id}/messages": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Messages" } } }, post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "201": { description: "Prompt and reviewed draft" } } } },
    "/api/systems": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Enrolled systems" } } } },
    "/api/systems/events": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Server-sent events" } } } },
    "/api/systems/{system_id}/diagnostics": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Allowlisted diagnostics" } } } },
    "/api/systems/{system_id}/diagnostics/{diagnostic_id}": { post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Read-only diagnostic result" } } } },
    "/api/terminal/activity": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Diagnostic activity" } } } },
    "/api/operations/proposals": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Proposal list" } } }, post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "201": { description: "Proposal created; no operation performed" } } } },
    "/api/operations/proposals/{proposal_id}/decision": { post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Human decision recorded only" } } } },
    "/api/models/training-runs": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Training runs" } } }, post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "202": { description: "Training queued" } } } },
    "/api/models/checkpoints": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Checkpoints" } } } },
    "/api/models/evaluations": { get: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "200": { description: "Evaluation records" } } }, post: { security: [{ cookieAuth: [] }, { bearerAuth: [] }], responses: { "202": { description: "Evaluation queued" } } } },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "assistant_session" },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "details"],
            properties: {
              code: { type: "string", enum: Object.values(ErrorCode) },
              message: { type: "string" },
              details: { oneOf: [{ type: "object" }, { type: "null" }] },
            },
          },
        },
      },
    },
  },
} as const;
