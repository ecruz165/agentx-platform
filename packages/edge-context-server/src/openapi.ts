/**
 * OpenAPI 3.1 spec for edge-context-server (PRD F20).
 *
 * Hand-curated rather than codegen'd — every route is small enough that
 * a single file is easier to read + diff than scattering decorators
 * across the routing code. When a new route lands in index.ts, add it
 * here too. CI guard could enforce this in v1.x; today it's discipline.
 *
 * Served at GET /openapi.json. Tooling (Postman, Insomnia, Stoplight)
 * can import directly. The spec describes the routes as if they were
 * served over HTTP+TCP — Unix domain socket transport is not part of
 * the OpenAPI vocabulary, so consumers have to know to point their
 * tool at the socket. Documented in the spec's `description`.
 */

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'edge-context-server',
    version: '1.0.0',
    description:
      'Per-workspace knowledge-graph server. Listens on a Unix domain ' +
      'socket — point your HTTP client at the socket file rather than a ' +
      'TCP port. v1 is UDS-only; TCP listener is deferred to v1.x.',
  },
  servers: [{ url: 'unix:///root/.harness/run/context.sock' }],
  paths: {
    '/health': {
      get: {
        summary: 'Liveness + backend state',
        responses: {
          '200': {
            description: 'Server is reachable; body reports backend state',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Health' } } },
          },
        },
      },
    },
    '/v1/stats': {
      get: {
        summary: 'Graph metrics',
        responses: {
          '200': {
            description: 'Node + edge counts and indexed labels',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Stats' } } },
          },
        },
      },
    },
    '/v1/context/query': {
      post: {
        summary: 'Hybrid graph + similarity search',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/QueryRequest' } } },
        },
        responses: { '200': { description: 'Search hits' } },
      },
    },
    '/v1/traverse': {
      post: {
        summary: 'Depth-bounded subgraph from a seed entity',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/TraverseRequest' } },
          },
        },
        responses: { '200': { description: 'Subgraph (nodes + edges)' } },
      },
    },
    '/v1/related': {
      post: {
        summary: 'Single-predicate adjacency from a seed entity',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RelatedRequest' } },
          },
        },
        responses: { '200': { description: 'Related node hits' } },
      },
    },
    '/v1/query': {
      post: {
        summary: 'Admin Cypher passthrough (UDS-only, READ-mode)',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CypherRequest' } },
          },
        },
        responses: {
          '200': { description: 'Row-shaped result' },
          '403': { description: 'Caller is not on the UDS' },
        },
      },
    },
    '/v1/ingest/repo': {
      post: {
        summary: 'Start tree-sitter ingestion of a repo (local path or git URL)',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RepoIngestRequest' } },
          },
        },
        responses: {
          '202': { description: 'Ingest started; returns ingestId for status polling / WS' },
          '400': { description: 'Malformed body' },
          '503': { description: 'Ingest backend not configured' },
        },
      },
    },
    '/v1/ingest/jira': {
      post: {
        summary: 'Ingest Jira issues by JQL',
        description: 'Reads JIRA_TOKEN, JIRA_BASE_URL, JIRA_EMAIL from server env. Atlassian Cloud uses Basic auth (email:token); set JIRA_AUTH_SCHEME=Bearer for self-hosted.',
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/JiraIngestRequest' } },
          },
        },
        responses: {
          '202': { description: 'Ingest started; returns ingestId' },
          '400': { description: 'Malformed body' },
          '503': { description: 'Ingest backend not configured' },
        },
      },
    },
    '/v1/ingest/confluence': {
      post: {
        summary: 'Ingest Confluence space pages',
        description: 'Reads CONFLUENCE_TOKEN, CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL from server env.',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ConfluenceIngestRequest' },
            },
          },
        },
        responses: {
          '202': { description: 'Ingest started; returns ingestId' },
          '400': { description: 'Malformed body' },
          '503': { description: 'Ingest backend not configured' },
        },
      },
    },
    '/v1/ingest/github-issues': {
      post: {
        summary: 'Ingest issues from a GitHub repository',
        description:
          'Reads GITHUB_TOKEN from server env. Returns 202 + ingestId. Issues are written as Issue nodes with title, body, state, labels, url. Pull requests filtered out automatically.',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/GithubIssuesIngestRequest' },
            },
          },
        },
        responses: {
          '202': { description: 'Ingest started; returns ingestId' },
          '400': { description: 'Malformed body' },
          '503': { description: 'Ingest backend not configured' },
        },
      },
    },
    '/v1/ingest/crawl': {
      post: {
        summary: 'Fetch a URL, run readability extraction, ingest as a Doc',
        description:
          'v1 supports scope:page only (single URL). Strict robots.txt enforcement; ' +
          '1 req/sec per host by default. Recursive scopes (subtree, site) deferred.',
        requestBody: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CrawlIngestRequest' },
            },
          },
        },
        responses: {
          '202': { description: 'Crawl started; returns ingestId' },
          '400': { description: 'Malformed body' },
          '503': { description: 'Ingest backend not configured' },
        },
      },
    },
    '/v1/ingest/upload': {
      post: {
        summary: 'Upload a file (PDF, doc, image, dataset) for embedding + graph node creation',
        requestBody: {
          content: { 'multipart/form-data': { schema: { type: 'object' } } },
        },
        responses: {
          '202': { description: 'Upload accepted; returns docId + ingestId' },
          '413': { description: 'Upload exceeds 50 MB cap' },
        },
      },
    },
    '/v1/ingest/{ingestId}': {
      get: {
        summary: 'Get status of an ingest run',
        parameters: [
          {
            name: 'ingestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Ingest status + buffered events' },
          '404': { description: 'Ingest not found' },
        },
      },
      delete: {
        summary: 'Cancel an in-flight ingest',
        parameters: [
          {
            name: 'ingestId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': { description: 'Cancellation issued' },
          '404': { description: 'Ingest not found' },
        },
      },
    },
    '/v1/ingest': {
      get: {
        summary: 'List all ingests this process has handled',
        responses: { '200': { description: 'Array of ingest statuses' } },
      },
    },
    '/v1/uploads': {
      get: {
        summary: 'List stored uploads',
        responses: { '200': { description: 'Array of upload entries' } },
      },
    },
    '/v1/uploads/{docId}': {
      delete: {
        summary: 'Remove an uploaded file + its Doc node + embeddings',
        parameters: [
          {
            name: 'docId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Upload not found' },
        },
      },
    },
    '/v1/ingest/events': {
      get: {
        summary: 'WebSocket upgrade — stream of ingestion events',
        description:
          'Send `{ "subscribe": "<ingestId>" }` after connect to filter to one ingest.',
        responses: {
          '101': { description: 'Upgraded to WebSocket' },
          '400': { description: 'Not a valid upgrade request' },
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'This document',
        responses: { '200': { description: 'OpenAPI 3.1 spec' } },
      },
    },
    '/v1/plugins': {
      get: {
        summary: 'List registered plugins',
        responses: {
          '200': { description: 'Array of { id, description }' },
        },
      },
    },
    '/v1/plugins/{pluginId}/{sub}': {
      parameters: [
        { name: 'pluginId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'sub', in: 'path', required: true, schema: { type: 'string' } },
      ],
      get: { summary: 'Dispatched to plugin GET handler', responses: { '200': { description: 'plugin response' } } },
      post: { summary: 'Dispatched to plugin POST handler', responses: { '200': { description: 'plugin response' } } },
    },
    '/metrics': {
      get: {
        summary: 'Prometheus-style text exposition',
        responses: {
          '200': {
            description: 'Counters in Prom text format',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Health: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          state: { type: 'string', enum: ['warm', 'no-backend', 'backend-error'] },
          backend: { type: 'string' },
          uptimeMs: { type: 'integer' },
        },
      },
      Stats: {
        type: 'object',
        properties: {
          nodeCount: { type: 'integer' },
          edgeCount: { type: 'integer' },
          indexedLabels: { type: 'array', items: { type: 'string' } },
        },
      },
      QueryRequest: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string' },
          productId: { type: 'string' },
          topK: { type: 'integer' },
          labels: { type: 'array', items: { type: 'string' } },
        },
      },
      TraverseRequest: {
        type: 'object',
        required: ['entity', 'depth'],
        properties: {
          entity: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 5 },
          predicates: { type: 'array', items: { type: 'string' } },
          productId: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      RelatedRequest: {
        type: 'object',
        required: ['entity', 'predicate', 'depth'],
        properties: {
          entity: { type: 'string' },
          predicate: { type: 'string' },
          depth: { type: 'integer', minimum: 1, maximum: 5 },
          productId: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
      CypherRequest: {
        type: 'object',
        required: ['cypher'],
        properties: {
          cypher: { type: 'string' },
          params: { type: 'object', additionalProperties: true },
          limit: { type: 'integer' },
        },
      },
      JiraIngestRequest: {
        type: 'object',
        required: ['name', 'jql'],
        properties: {
          name: { type: 'string' },
          jql: { type: 'string', minLength: 1 },
          maxResults: { type: 'integer', minimum: 1, maximum: 1000 },
          fields: { type: 'array', items: { type: 'string' } },
          productId: { type: 'string' },
        },
      },
      ConfluenceIngestRequest: {
        type: 'object',
        required: ['name', 'space'],
        properties: {
          name: { type: 'string' },
          space: { type: 'string', minLength: 1 },
          maxResults: { type: 'integer', minimum: 1, maximum: 1000 },
          productId: { type: 'string' },
        },
      },
      GithubIssuesIngestRequest: {
        type: 'object',
        required: ['name', 'repo'],
        properties: {
          name: { type: 'string' },
          repo: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' },
          labels: { type: 'array', items: { type: 'string' } },
          state: { type: 'string', enum: ['open', 'closed', 'all'] },
          since: { type: 'string', format: 'date-time' },
          maxPages: { type: 'integer', minimum: 1, maximum: 100 },
          productId: { type: 'string' },
        },
      },
      CrawlIngestRequest: {
        type: 'object',
        required: ['name', 'url'],
        properties: {
          name: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          productId: { type: 'string' },
          rateLimitPerHost: { type: 'number', minimum: 0.1 },
          ifNoneMatch: { type: 'string' },
          ifModifiedSince: { type: 'string' },
        },
      },
      RepoIngestRequest: {
        type: 'object',
        required: ['name', 'source'],
        properties: {
          name: { type: 'string' },
          sourceTypeId: { type: 'string' },
          productId: { type: 'string' },
          source: {
            oneOf: [
              {
                type: 'object',
                required: ['type', 'path'],
                properties: {
                  type: { type: 'string', enum: ['local'] },
                  path: { type: 'string' },
                },
              },
              {
                type: 'object',
                required: ['type', 'cloneUrl'],
                properties: {
                  type: { type: 'string', enum: ['git'] },
                  cloneUrl: { type: 'string' },
                  branch: { type: 'string' },
                },
              },
            ],
          },
        },
      },
    },
  },
} as const;
