# Pipeline catalog

`pipelines.json` is the workspace-scoped pipeline catalog. The harness-server
loads it at startup and uses it to register agents on every job submitted via
`POST /v1/jobs`.

## Schema

```ts
interface PipelineCatalog {
  pipelines: Array<{
    id: string;                  // unique within file
    description?: string;
    agents: Array<{
      id: string;                // unique within pipeline
      role: string;              // shown in TUI middle column
      adapter: 'claude-sdk' | 'opencode-cli';
      systemPrompt?: string;     // passed as `system` to the adapter
    }>;
  }>;
}
```

Validated by `packages/harness-server/src/catalog.ts`. Errors at load time
fail loud — fix the file or boot fails.

## Authority

This file is **admin-owned**. Per the project's authority model, clients
submit *intent* (a pipeline id + input). They do not design pipelines.
Treat changes here like infrastructure changes: review, test, commit.

## What to customize

The committed `pipelines.json` is a *starter*. The system prompts contain
literal `TODO:` markers — replace them with your team's real prompts before
running anything in production. Likely additions to the schema as your
pipelines mature (these are TODO in `catalog.ts`):

- per-agent `model` override
- per-agent `timeoutMs`, `maxRetries`, `temperature`
- tool/skill bindings (which MCP servers each agent may call)
- `dependsOn: string[]` for fan-in / fan-out within a pipeline
- `inputSchema` / `outputSchema` for inter-agent message contracts

Add fields when you have a concrete consumer. Don't speculate.

## Future

When the central Spring Modulith Catalog service lands, this file is replaced
by an HTTP/gRPC call behind the same `loadCatalog()` surface. The local
fallback (this file) is the reference shape; the central service must accept
the same schema.
