# token-codecs — Implementation PRD

**Status:** Draft (2026-04-30)
**Owner:** Edwin Cruz
**Audience:** future implementer (human or agent) picking this up cold
**Companion documents:**
- `.plans/2026-04-30-prd-agent-adapter-lib.md` — sibling lib (deliberately *not* a consumer; codecs compose upstream of the adapter)
- `.plans/2026-04-30-agentic-harness-design.md` § 6.5 (`PhaseConfig.prePlugins` + `postPlugins`) — primary integration points in the harness ecosystem
- `.plans/2026-04-30-prd-harness-core.md` — secondary integration point (host-level transformer composition for non-harness consumers)

---

## 1. Purpose

A standalone TypeScript library that owns **the full request/response codec lifecycle** for agent invocations: token-efficient encoding of structured data on the way *out*, type-checked parsing + validation of structured data on the way *back*, and the measurement / repair / schema-injection plumbing that makes both sides reliable.

The lib exists because every host running non-trivial agent calls solves the same two problems badly:

1. **Request side — token waste on structured payloads.** Tool definitions, retrieved-context blocks, JSON dumps from APIs, GraphRAG results — all sent as JSON, all paying 30–50% structural-noise overhead (`{`, `}`, `"`, `,`, repeated key names) for no semantic value. Across a 30-tool-call phase or a 50KB context block, that's real money and real context-window pressure.

2. **Response side — typed responses are unreliable in practice.** Models return prose with markdown fences, slight JSON malformations, dates as strings, occasional missing brackets at truncation boundaries. Parsing that *as if* the model returned valid JSON fails 20–40% of the time depending on prompt; without repair logic and schema validation, every typed response becomes a retry-or-fail decision the host has to make. And if the schema isn't communicated to the model in the request, the failure rate is higher still.

By centralizing both sides in one library:

1. **Codecs are inherently round-trip primitives.** `Codec.encode` and `Codec.decode` are paired — the same library that knows how to write TOON also knows how to read it. Splitting them across two libs would have meant TOON's spec compliance, version pinning, and round-trip tests fragmenting.
2. **The tokenizer interface is shared.** Density measurement (request side) and truncation diagnostics (response side) both want the same `Tokenizer` contract. One lib avoids the "tokenizer-interface as a third tiny lib" problem.
3. **The harness ecosystem gets paired pre/post-plugins.** Phases declare `prePlugins: ['token-codec-rewrite']` for request-side encoding and `postPlugins: ['token-codec-validate']` for response-side schema validation. Both come from this lib; both share the same registry, manifest format, and tokenizer.
4. **Non-harness hosts compose typed exchanges in three lines.** `runTypedExchange(agent, input, schema)` handles schema injection → invoke → parse → repair → validate, returning a typed value or a structured error.

**Why now:** The harness's `prePlugins` + `postPlugins` slots are type-locked in Layer 1 but unimplemented until M2.7 (per implementation plan). Spec'ing this lib before the first concrete plugins land keeps the harness plugin slots from accidentally couping to a particular codec's API. By the time the harness has a phase that hits context-window pressure (Layer 4 — when ContextProvider results land in prompts), this lib is ready to be composed on both sides.

## 2. Goals (v1)

### Request-side (encode + measure)

- **Three built-in codecs** in v1: `toon` (Token-Oriented Object Notation), `yaml` (well-known fallback, often denser than JSON), `json-min` (baseline — JSON with whitespace stripped, no behavioral change). Custom codecs added via `registerCodec(spec)`. Each codec is round-trip — exposes both `encode` and `decode`.
- **Tokenizer-aware density measurement.** `measure(value, tokenizer, codecs?)` returns per-codec token counts + savings vs. JSON baseline, deterministically.
- **Comprehension benchmark harness.** `comprehensionBench(codec, model, tokenizer)` runs a fixed extraction-task suite against a real model; reports accuracy per codec so consumers know which encodings the model can actually read.
- **Selective transformation.** `transform(input, manifest)` rewrites only manifest-named fields — never user prose by default. The phase declares what's structured.
- **Harness pre-plugin** (`token-codec-rewrite`) — manifest-driven request-side rewriting.
- **Host composition helpers** for direct (non-harness) consumers.

### Response-side (parse + repair + validate)

- **Robust parsing across codecs.** `parse(text, codec)` calls the codec's `decode` with built-in repair: trailing commas, unclosed strings at truncation boundaries, single-quoted strings, fenced markdown blocks (` ```json ... ``` `), preamble prose before the structured block.
- **Format detection + extraction.** `extractCodedBlock(text, hint?)` finds the structured block in mixed prose + structured output (a common shape from chat-tuned models), strips fences, returns the embedded payload.
- **Multi-codec fallback.** `decodeWithFallback(text, codecs[])` tries each codec in order; useful when the model's exact output format is uncertain.
- **Zod-validated typed responses.** `parseTypedResponse<T>(result, schema, opts)` extracts → repairs → validates against a Zod schema → returns `Result<T, ParseError>`.
- **Tokenizer-aware truncation diagnostics.** When `result.finishReason === 'length'` AND parse fails: error message includes "response truncated at token N; last complete object ended at offset M" so the host knows whether to bump `max_tokens` or split the request.
- **Harness post-plugin** (`token-codec-validate`) — schema-validated response parsing.

### Schema lifecycle (the bridge)

- **`prepareRequestForSchema(input, schema, capabilities)`** — augments the request to communicate the expected response schema. Auto-picks the strongest mechanism the adapter supports:
  - Tool-use forcing (Anthropic claude-sdk, claude-code-cli, copilot-sdk OpenAI-compat) — define a `submit_result` tool with the schema, force the model to call it
  - Native structured output (`response_format: { type: 'json_schema' }` for OpenAI-compat backends)
  - Inline prompt augmentation (any backend) — fallback that appends "Respond with JSON matching..." to the system prompt
- **`runTypedExchange(agent, input, schema, opts)`** — convenience wrapper combining `prepareRequestForSchema` → `agent.invoke` → `parseTypedResponse`. Handles validation-failure retry with feedback (capped at `opts.maxRetries`, default 1).

## 3. Non-Goals (v1)

- **Not a tokenizer.** Lib uses tokenizers via the injected interface; ships none of its own. Companion packages may add thin wrappers around upstream tokenizers.
- **Not a content transformer in the sense of `agent-adapter`.** Per the agent-adapter PRD's "Not a content transformer" non-goal, this lib never registers itself as adapter middleware. Composition happens upstream (harness pre/post-plugins) or in the host.
- **Not a prompt template system.** Codecs encode/decode structured data; they don't interpolate variables, render Jinja/Mustache, or compose prompts. (See § 13 D2.)
- **Not a constrained-decoding implementation.** Schema injection in the request is *advisory* (tool-use, JSON mode, prompt) — the lib doesn't constrain the model's output at the token level. That's an adapter/backend concern (e.g., OpenAI's strict JSON schema mode lives in the adapter's request shape). The lib *uses* those mechanisms via `prepareRequestForSchema` but doesn't implement them.
- **Not a compression library.** Compression (gzip/zstd/etc.) is irrelevant — the model sees decompressed bytes; what costs tokens is the textual representation.
- **Not a benchmarking dashboard.** Comprehension benchmark exposes raw results as JSON; visualizing trends is the consumer's responsibility.
- **Not a streaming codec.** All encodes/decodes operate on complete in-memory values. Payloads small enough to send to an LLM fit in memory; streaming validation across response chunks deferred to v1.x (see § 14).
- **Not a schema language.** Schemas are Zod (or any compatible structural-validator interface). Lib doesn't define a schema DSL; it consumes whatever schema the consumer provides.
- **Not a retry orchestrator.** `runTypedExchange` does *one* automatic retry on validation failure as convenience. Multi-attempt retry, exponential backoff, and policy-driven retry live in the harness library's `RetryPolicy`. The lib emits clear errors so harness retry logic can act on them.

## 4. Reference & Provenance

This lib is **clean-room**, not extracted from an existing implementation. The format specs it implements are external:

| Codec | Reference |
|---|---|
| `toon` | [TOON spec — Token-Oriented Object Notation](https://github.com/johannschopplich/toon) (verify spec status during Phase A; vendor a frozen version) |
| `yaml` | YAML 1.2 spec via `yaml` npm package |
| `json-min` | `JSON.stringify(value)` with no spacing |

**JSON-repair heuristics** are clean-room but informed by widely-known patterns (trailing-comma tolerance, single-quote rewriting, unclosed-string completion at truncation boundaries). The repair layer ships with a documented decision tree so consumers can audit what their parser accepts.

**Hardcoded values to think about:**
- TOON's exact format may evolve upstream — vendor a frozen version in `docs/toon-vendored-spec.md`.
- Comprehension fixture suite: 50 tasks × 5 difficulty tiers, hand-authored.
- JSON-repair test corpus: collected from real model outputs (anonymized) plus synthetic truncation cases.

## 5. Package Layout

| | |
|---|---|
| Path | `npm-dependency/token-codecs/` |
| Package name | `@your-org/token-codecs` |
| Lang | TypeScript, Node ≥20, ESM |
| Test runner | `vitest` |
| Runtime deps | `yaml` (YAML codec), `zod` (schema validation) |
| Peer deps (optional) | `@anthropic-ai/tokenizer`, `tiktoken` (consumers wire whichever) |

```
token-codecs/
├── src/
│   ├── index.ts                       # public exports
│   ├── types.ts                       # Codec, Tokenizer, Manifest, MeasureResult, ParseResult
│   ├── registry.ts                    # built-in codec registry + registerCodec()
│   ├── codecs/
│   │   ├── toon/
│   │   │   ├── index.ts               # encode + decode (round-trip)
│   │   │   ├── encoder.ts
│   │   │   ├── decoder.ts
│   │   │   └── shape-detect.ts
│   │   ├── yaml/
│   │   │   └── index.ts               # thin wrapper over `yaml` pkg
│   │   └── json-min/
│   │       └── index.ts
│   ├── transform/                     # request-side selective rewrite
│   │   ├── manifest.ts                # Manifest type + JSONPath matching
│   │   ├── apply.ts
│   │   └── pre-plugin.ts              # harness PluginFactory: token-codec-rewrite
│   ├── measure/                       # request-side density measurement
│   │   ├── density.ts                 # measure() — tokens per codec for a payload
│   │   └── recommend.ts               # pick best codec by token-savings × confidence
│   ├── bench/                         # comprehension benchmark harness
│   │   ├── comprehension.ts
│   │   ├── fixtures/                  # 50 tasks × 5 tiers
│   │   └── runner.ts                  # CLI: bench TOON|YAML|json-min against gpt-4o
│   ├── response/                      # response-side parsing + repair
│   │   ├── parse.ts                   # parse(text, codec) with repair
│   │   ├── extract.ts                 # extractCodedBlock — strip fences, find embedded blocks
│   │   ├── fallback.ts                # decodeWithFallback — try multiple codecs
│   │   ├── repair/
│   │   │   ├── json-repair.ts         # trailing commas, single quotes, unclosed strings
│   │   │   ├── truncation.ts          # detect + handle truncation-at-token-boundary
│   │   │   └── fence-strip.ts         # ```json ... ``` and other markdown fences
│   │   ├── typed-response.ts          # parseTypedResponse<T>(result, schema)
│   │   ├── diagnostics.ts             # tokenizer-aware error context
│   │   └── post-plugin.ts             # harness PluginFactory: token-codec-validate
│   ├── schema-lifecycle/              # the request<->response bridge
│   │   ├── prepare-request.ts         # prepareRequestForSchema(input, schema, capabilities)
│   │   ├── strategies/
│   │   │   ├── tool-use.ts            # inject submit_result tool
│   │   │   ├── json-mode.ts           # set response_format: json_schema
│   │   │   └── prompt-augment.ts      # append "Respond with JSON matching..."
│   │   ├── run-typed-exchange.ts      # full lifecycle convenience wrapper
│   │   └── retry-feedback.ts          # build retry prompt from validation error
│   ├── tokenizer/
│   │   └── interface.ts               # Tokenizer interface (count + tokenize)
│   └── errors.ts                      # TokenCodecsError taxonomy (encode + parse + lifecycle)
├── companion-packages/
│   ├── token-codecs-anthropic-tokenizer/
│   │   └── src/index.ts                            # exports anthropicTokenizer: Tokenizer
│   └── token-codecs-tiktoken/
│       └── src/index.ts                            # exports tiktokenFor(model): Tokenizer
├── test/
├── package.json
├── tsconfig.json
└── README.md
```

## 6. Public API

### Request side — encode + measure

```ts
import { measure, transform, getCodec } from '@your-org/token-codecs';
import { anthropicTokenizer } from '@your-org/token-codecs-anthropic-tokenizer';

// 1. Measure density across codecs for a payload
const result = await measure(payload, anthropicTokenizer);
// {
//   baseline: { codec: 'json', tokens: 4287 },
//   candidates: [
//     { codec: 'toon',     tokens: 2341, saved: 1946, savedPct: 45.4 },
//     { codec: 'yaml',     tokens: 3105, saved: 1182, savedPct: 27.6 },
//   ]
// }

// 2. Apply codec to selected fields of an AgentInput
const transformedInput = transform(agentInput, {
  fieldsToEncode: [
    { path: 'messages[*].content.tool_inputs', codec: 'toon' },
    { path: 'system.context_blocks[*].data',   codec: 'toon' },
  ],
});

// 3. Standalone encode / decode
const toon = getCodec('toon');
const encoded = toon.encode({ users: [{ id: 1 }, { id: 2 }] });
const decoded = toon.decode(encoded);
```

### Response side — parse + repair + validate

```ts
import { parseTypedResponse, parse, extractCodedBlock } from '@your-org/token-codecs';
import { z } from 'zod';

// 1. Typed response with full repair + validation pipeline
const schema = z.object({
  summary: z.string(),
  affected_files: z.array(z.string()),
  risk: z.enum(['low', 'medium', 'high']),
});

const result = await parseTypedResponse(agentInvocationResult, schema, {
  tokenizer: anthropicTokenizer,           // optional; enables truncation diagnostics
  codec: 'json',                            // default; or 'toon' / 'yaml' / 'auto'
});

if (result.ok) {
  // result.value is fully typed as { summary: string; affected_files: string[]; risk: 'low'|'medium'|'high' }
  console.log(result.value.summary);
} else {
  // result.error is a structured ParseError with diagnostics
  console.error(result.error.kind, result.error.message);
  // kind: 'truncation' | 'malformed' | 'schema-mismatch' | 'extraction-failed'
  if (result.error.kind === 'truncation') {
    console.error(`Truncated at token ${result.error.tokenOffset}; last valid object at char ${result.error.lastValidOffset}`);
  }
}

// 2. Lower-level: just parse with repair, no schema
const parsed = parse(messyText, 'json');   // tries repair before throwing

// 3. Extract a coded block from mixed prose + structured output
const block = extractCodedBlock(modelText, { hint: 'json' });
// returns the JSON block, fences stripped, preamble removed
```

### The full schema lifecycle — `runTypedExchange`

```ts
import { runTypedExchange } from '@your-org/token-codecs';
import { createAgent } from '@your-org/agent-adapter';

const agent = createAgent({ spec: { type: 'claude-sdk', ... }, ... });

const schema = z.object({
  diagnosis: z.string(),
  suggested_fix: z.string(),
  confidence: z.number().min(0).max(1),
});

// One call: schema-injected request → invoke → parse → validate → typed result.
// On schema-mismatch, retries once with the validation error fed back to the model.
const result = await runTypedExchange(agent, baseInput, schema, {
  strategy: 'auto',          // 'tool-use' | 'json-mode' | 'prompt-augment' | 'auto' (picks per agent.capabilities)
  maxRetries: 1,
  tokenizer: anthropicTokenizer,
});

if (result.ok) {
  // result.value is fully typed; result.usage rolls up retry-attempt costs
} else {
  // result.error includes which strategy was used + which attempt failed how
}
```

### As harness pre + post-plugins

```ts
import { tokenCodecRewritePlugin, tokenCodecValidatePlugin } from '@your-org/token-codecs';

// In harness PluginRegistry registration:
registry.registerPlugin('token-codec-rewrite',  tokenCodecRewritePlugin);
registry.registerPlugin('token-codec-validate', tokenCodecValidatePlugin);

// In a phase that consumes large structured context AND produces a typed response:
{
  id: 'analyze',
  agent: { type: 'claude-sdk', model: 'claude-sonnet-4-6' },
  outputs: { schema: AnalysisSchema },          // existing PhaseConfig field per harness design
  prePlugins: [{
    ref: 'token-codec-rewrite',
    config: {
      manifest: {
        fieldsToEncode: [
          { path: 'context.graphrag_results', codec: 'toon' },
        ],
      },
      tokenizerRef: 'anthropic',
    },
  }],
  postPlugins: [{
    ref: 'token-codec-validate',
    config: {
      schemaRef: 'AnalysisSchema',              // resolved from harness's schema registry
      strategy: 'auto',
      tokenizerRef: 'anthropic',
    },
  }],
}
```

## 7. Core Types

```ts
// --- Codec primitives ---

export interface Codec {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;

  encode(value: unknown): string;
  decode(serialized: string): unknown;

  encodeIfSupported?(value: unknown): string | null;
  readonly capabilities: CodecCapabilities;
}

export interface CodecCapabilities {
  homogeneousArrays:     boolean;
  heterogeneousArrays:   boolean;
  nestedObjects:         boolean;
  null:                  boolean;
  booleans:              boolean;
  numbers:               boolean;
  strings:               boolean;
  dates:                 'lossless' | 'string-only' | 'unsupported';
  losslessRoundTrip:     boolean;
}

export interface Tokenizer {
  readonly id: string;
  countTokens(text: string): Promise<number> | number;
  tokenize?(text: string): Promise<number[]> | number[];
}

// --- Request-side ---

export interface Manifest {
  fieldsToEncode: Array<{
    path: string;                       // JSONPath
    codec: string;
    fallback?: 'leave-as-is' | 'json-min' | 'throw';
  }>;
}

export interface MeasureResult {
  baseline: { codec: 'json'; tokens: number };
  candidates: Array<{
    codec: string;
    tokens: number;
    saved: number;
    savedPct: number;
    encodedPreview?: string;
  }>;
  tokenizerId: string;
  measuredAt: number;
}

// --- Response-side ---

export type ParseResult<T> =
  | { ok: true;  value: T;  usedCodec: string;  warnings?: string[] }
  | { ok: false; error: ParseError };

export type ParseError =
  | { kind: 'extraction-failed';  message: string;  rawText: string }
  | { kind: 'malformed';           message: string;  rawText: string;  repairAttempted: boolean }
  | { kind: 'truncation';          message: string;  tokenOffset?: number;  lastValidOffset: number;  rawText: string }
  | { kind: 'schema-mismatch';     message: string;  validationErrors: ZodIssue[];  parsedValue: unknown;  rawText: string };

export interface ParseTypedResponseOptions<T> {
  schema: ZodType<T>;
  codec?: string | 'auto';            // 'auto' tries fallback chain
  tokenizer?: Tokenizer;              // enables truncation diagnostics when finishReason === 'length'
  fallbackCodecs?: string[];          // for 'auto' mode; defaults to ['json', 'json-min', 'yaml', 'toon']
  repair?: boolean | RepairOptions;   // default true
}

export interface RepairOptions {
  trailingCommas?:        boolean;    // default true
  singleQuotes?:          boolean;    // default true
  unclosedStrings?:       boolean;    // default true (only on truncation)
  fenceStrip?:            boolean;    // default true
  preambleStrip?:         boolean;    // default true
}

// --- Schema lifecycle ---

export interface RunTypedExchangeOptions<T> {
  strategy?:              'auto' | 'tool-use' | 'json-mode' | 'prompt-augment';
  toolName?:              string;     // for tool-use strategy; default 'submit_result'
  maxRetries?:            number;     // default 1
  retryFeedback?:         'verbose' | 'concise' | 'none';   // how to feed the validation error back
  tokenizer?:             Tokenizer;
  codec?:                 string | 'auto';
}

export type SchemaInjectionStrategy = 'tool-use' | 'json-mode' | 'prompt-augment';

export interface PreparedRequest {
  input: AgentInput;                  // augmented input; ready to pass to agent.invoke
  strategy: SchemaInjectionStrategy;  // which strategy was chosen
  rationale: string;                  // why this strategy (for logging/debugging)
}
```

## 8. Codec Specifications

(unchanged from prior draft — `toon`, `yaml`, `json-min` round-trip codecs with capability matrix)

### 8.1 `toon` — best for homogeneous-array-heavy structured data; falls back to JSON sub-trees for shapes it can't express; lossless within supported shapes; vendored TOON spec.

### 8.2 `yaml` — thin wrapper over `yaml` pkg; broadly model-comprehensible; documented type-coercion edge cases.

### 8.3 `json-min` — `JSON.stringify` with no spacing; safe fallback; trivial implementation.

### 8.4 Custom codecs — `registerCodec(spec)` extension point.

### 8.5 Codec capability matrix

| Feature | toon | yaml | json-min |
|---|---|---|---|
| Homogeneous arrays | ✓ (densest) | ✓ | ✓ |
| Heterogeneous arrays | ✓ (falls back to nested JSON) | ✓ | ✓ |
| Nested objects | ✓ | ✓ | ✓ |
| Lossless round-trip | ✓ (within supported shapes) | ⚠ (typing ambiguities) | ✓ |
| Streaming encode | ✗ | ✗ | ✗ |
| Streaming decode | ✗ | ✗ | ✗ (line-buffered repair only) |

## 9. Tokenizer-Aware Density Measurement

(unchanged — `measure()` + `recommend()` + LRU caching; the request-side optimization story.)

## 10. Comprehension Benchmark Harness

(unchanged — 50 tasks × 5 tiers, opt-in, results feed back into `recommend()`'s `modelComprehensionScore`.)

## 11. Response Codecs (parse + repair + validate)

The decode-side counterpart to encoding. Where encoding is deterministic, decoding is **adversarial** — the model returns whatever it wants, often with quirks. Robust decode = layered: extract → repair → decode → validate.

### 11.1 Layered parsing pipeline

```
model output text
   │
   ▼
[1] extractCodedBlock(text, hint?)
   │   strips markdown fences (```json ... ```), removes pre/postamble prose
   │   returns the candidate structured block + offset metadata
   │
   ▼
[2] repair (codec-specific)
   │   JSON: trailing commas, single quotes, unclosed strings (truncation only)
   │   YAML: tab→space normalization
   │   TOON: vendored repair rules per the frozen spec
   │   Each repair logs what it did → surfaced in `warnings`
   │
   ▼
[3] codec.decode(repaired)
   │   primary codec or fallback chain
   │
   ▼
[4] schema.parse(decoded)
   │   Zod validation; on failure, ZodIssue array goes into ParseError.schema-mismatch
   │
   ▼
ParseResult<T> — typed value or structured error
```

### 11.2 Repair philosophy

**Repair is opt-out, not opt-in.** Default `repair: true` because real-world model output requires it; the lib's value vs. plain `JSON.parse` is precisely that it works on actual responses. Hosts that want strict parsing pass `repair: false` and accept the failure rate.

**Repair is *visible*.** Every repair appends to `ParseResult.warnings` so the host can see what happened (e.g., `"trailing comma at offset 421 removed"`). Auditable; not magic.

**Repair stops at semantic ambiguity.** The repair layer never *guesses* values. Trailing commas are removed (no semantic change); single quotes become double quotes (lexer normalization); unclosed strings at truncation boundaries are closed iff `finishReason === 'length'` indicates truncation. The lib doesn't fabricate field values.

### 11.3 Truncation diagnostics

The most useful single feature on the response side:

```ts
const result = await parseTypedResponse(invocationResult, schema, {
  tokenizer: anthropicTokenizer,
});
// invocationResult.finishReason === 'length' → truncation suspected
// parser walks back to find last complete object boundary
// returns:
//   { ok: false, error: {
//       kind: 'truncation',
//       message: 'Response truncated at token ~4096 (max_tokens). Last complete object ended at character offset 3912 (key="suggested_fix"). Bump max_tokens or split the request.',
//       tokenOffset: 4096,
//       lastValidOffset: 3912,
//       rawText: '...'
//     }
//   }
```

This is where the tokenizer earns its keep on the response side. Without it, "parse failed" is the host's only signal; with it, the host knows whether to bump `max_tokens` or whether the model is just badly behaved.

### 11.4 Multi-codec fallback

`parseTypedResponse(..., { codec: 'auto' })` tries codecs in order: `['json', 'json-min', 'yaml', 'toon']` by default. Useful when the host can't predict the model's output format (e.g., consumer-tunable system prompts, A/B testing different schemas). Each fallback attempt's repair attempts are tracked; the final `ParseResult` notes which codec succeeded via `usedCodec`.

## 12. Schema Lifecycle (the bridge)

The request-side and response-side responsibilities don't make sense in isolation. If you parse responses against a schema, you must also tell the model the schema in the request — otherwise you're paying retry costs for misses you could have prevented.

### 12.1 `prepareRequestForSchema(input, schema, capabilities)`

Auto-picks the strongest schema-injection mechanism the adapter supports:

| Strategy | Adapter prerequisites | Reliability (typical) |
|---|---|---|
| `tool-use` | `capabilities.supportsToolUse === true` | ~98% schema-conforming (model is forced into the tool's input shape) |
| `json-mode` | `capabilities.supportsJsonMode === true` (added to AdapterCapabilities) | ~95% (backend enforces) |
| `prompt-augment` | always available | ~80–90% (model-dependent) |

Selection logic: try `tool-use` → fall back `json-mode` → fall back `prompt-augment`. Hosts can force a specific strategy via `opts.strategy`.

**Each strategy converts `(input, schema)` into an augmented `AgentInput` that has the schema baked into its appropriate slot:**

- `tool-use` injects `tools: [{ name: 'submit_result', input_schema: <zod-to-jsonschema(schema)>, ... }]` and sets `tool_choice: { name: 'submit_result' }`.
- `json-mode` sets `response_format: { type: 'json_schema', schema: <zod-to-jsonschema(schema)> }`.
- `prompt-augment` appends to `systemPrompt`: `"Respond with JSON matching this schema:\n<schema description>\n"` (uses Zod's `.describe()` annotations + a deterministic JSON-schema dump).

The returned `PreparedRequest.rationale` includes a one-line "why this strategy" so logs explain choices.

### 12.2 `runTypedExchange(agent, input, schema, opts)`

The convenience wrapper. Pseudocode:

```
const prepared = prepareRequestForSchema(input, schema, agent.capabilities);
log.debug('typed exchange strategy', prepared.strategy, prepared.rationale);

const result = await agent.invoke(prepared.input);

const parsed = await parseTypedResponse(result, schema, {
  tokenizer: opts.tokenizer,
  codec: prepared.strategy === 'tool-use' ? 'tool-input' : 'auto',
});

if (parsed.ok) return { ok: true, value: parsed.value, usage: result.usage, attempts: 1 };

if (opts.maxRetries > 0 && parsed.error.kind === 'schema-mismatch') {
  const feedback = buildRetryFeedback(parsed.error, opts.retryFeedback ?? 'concise');
  const retryInput = appendRetryFeedback(prepared.input, result, feedback);
  // ... recursive call with maxRetries decremented; usage rolls up
}

return { ok: false, error: parsed.error, usage: result.usage, attempts: 1 };
```

### 12.3 Retry feedback

When validation fails on first attempt, the lib builds a *concise feedback message* to the model — not a verbose dump of the entire ZodIssue array, but a focused "field `risk` must be one of `low|medium|high`; you returned `severe`" message. Default `retryFeedback: 'concise'`. Hosts wanting full verbosity pass `'verbose'`; hosts wanting silent retry pass `'none'`.

The feedback strategy matters: dumping a Zod error JSON to the model as feedback often *worsens* the second attempt (the model gets confused by the meta-structure). Concise natural-language feedback ("change X to Y") works better in practice — hence the default.

### 12.4 Why not multi-attempt retry?

Multi-retry, exponential backoff, and policy-driven retry live in the harness library's `RetryPolicy`. The lib's `runTypedExchange` does *one* convenience retry because validation-mismatch on the first attempt is the most common case and a single corrective pass usually fixes it. Beyond that, the harness owns the policy.

## 13. Integration Patterns

### 13.1 As paired harness pre + post-plugins (primary v1 path)

```ts
{
  id: 'synthesize',
  agent: { type: 'claude-sdk', model: 'claude-sonnet-4-6' },
  outputs: { schema: SynthesisSchema },
  prePlugins: [{
    ref: 'token-codec-rewrite',
    config: {
      manifest: { fieldsToEncode: [{ path: 'context.graphrag_results', codec: 'toon' }] },
      tokenizerRef: 'anthropic',
    },
  }],
  postPlugins: [{
    ref: 'token-codec-validate',
    config: {
      schemaRef: 'SynthesisSchema',
      strategy: 'auto',
      tokenizerRef: 'anthropic',
      maxRetries: 1,
    },
  }],
}
```

The pre-plugin compresses the request; the post-plugin schema-validates the response. They share the same tokenizer registry and codec registry.

### 13.2 Direct host (non-harness) — full lifecycle

```ts
import { createAgent } from '@your-org/agent-adapter';
import { runTypedExchange } from '@your-org/token-codecs';

const agent = createAgent({ spec: ..., ... });
const result = await runTypedExchange(agent, input, AnalysisSchema, {
  strategy: 'auto',
  tokenizer: anthropicTokenizer,
});
```

### 13.3 Standalone density measurement (CI/audit)

```ts
import { measure } from '@your-org/token-codecs';
const result = await measure(payload, anthropicTokenizer);
console.log(`Best codec: ${result.candidates[0].codec} (saves ${result.candidates[0].savedPct}%)`);
```

### 13.4 Standalone response parsing (tools + scripts)

```ts
import { parseTypedResponse } from '@your-org/token-codecs';
const parsed = await parseTypedResponse(invocationResult, schema);
```

## 14. Decisions

### Decided (v1)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Should encode + decode + schema-lifecycle live in one lib or three? | **One lib (`@your-org/token-codecs`).** Codecs are inherently round-trip; tokenizer interface is shared; harness pre/post-plugins naturally pair. | Splitting them would have meant TOON's spec compliance fragmenting across two packages, plus a third `tokenizer-interface` lib just to avoid coupling. One lib keeps the surface coherent. |
| D2 | Include prompt templating? | **No** (per § 3 non-goal). | Templating is variable interpolation + control flow; codecs are encoding/decoding. Different concern. |
| D3 | Tokenizer integration model | **Injectable `Tokenizer` interface; companion packages wrap real tokenizers.** | Keeps the main package zero-tokenizer-dep so it ships fast. Companion packages mirror agent-adapter's peer-dep pattern. |
| D4 | Codec selection algorithm in `recommend()` | **Weighted-sum of savings + comprehension** (defaults 0.7/0.3); consumers re-weight. | Simple, predictable, debuggable. Multi-objective optimization (Pareto front) is over-engineered for v1. |
| D5 | Decode-side scope | **In v1.** Owned by this lib alongside encode-side. | The original v0 PRD deferred decode to a sibling lib; this revision merges them per the round-trip codec argument. The lib is now "full request/response codec lifecycle," not just request-side. |
| D6 | Vendor TOON spec or follow upstream? | **Vendor a frozen version in v1.** | Upstream stability unknown; vendoring insulates consumers. Phase E reviews upstream for v1.x bump. |
| D7 | Caching of `measure()` results | **In-process LRU (1000 entries default), opt-out via `noCache: true`.** | Most consumers measure the same payloads repeatedly during dev/test; caching is free perf. |
| D8 | Comprehension fixture authorship | **50 tasks × 5 tiers, hand-authored, JSON-fixture format, versioned.** | Hand-authored ensures task quality; 50×5 is enough statistical power without being a barrier to running. |
| D9 | Schema-injection strategy selection | **Auto-pick by adapter capabilities (`tool-use` → `json-mode` → `prompt-augment`).** Hosts can override via `opts.strategy`. | Adapters declare capabilities; the lib uses that declaration. Strongest mechanism available wins by default. |
| D10 | Repair: opt-in or opt-out? | **Opt-out (default `repair: true`).** | Real-world model output requires repair; the lib's value vs. plain `JSON.parse` is precisely that it works. Hosts wanting strict parsing pass `repair: false`. |
| D11 | Repair visibility | **Every repair logs to `ParseResult.warnings`.** | Auditable; not magic. Hosts who suspect repair is masking bugs can inspect what happened. |
| D12 | Retry on validation failure | **One automatic retry inside `runTypedExchange`** with concise natural-language feedback; multi-retry delegated to harness `RetryPolicy`. | Single corrective pass fixes most validation-mismatches. Beyond that, retry policy is the harness's concern. |
| D13 | Retry feedback verbosity | **Concise natural-language by default** (`'concise'`); verbose Zod-issue dumps available via opt-in. | Dumping ZodIssue JSON to the model as feedback often worsens the second attempt; concise English fixes it more reliably. |

### Open

| # | Question |
|---|---|
| O1 | Should the harness pre-plugin auto-call `recommend()` per-phase to dynamically pick a codec, or require an explicit codec in the manifest? **Lean: explicit in v1; auto-pick is post-v1 once consumers have stable bench data.** |
| O2 | CSV codec — ship in v1 or v1.x? **Lean: defer to v1.x.** |
| O3 | Should `recommend()` ever recommend "no codec — JSON is best"? **Lean: yes when savings <5%; the noise of changing encoding isn't worth a 4% saving.** |
| O4 | Add a `supportsJsonMode` field to agent-adapter's `AdapterCapabilities`? Required for D9's strategy selection. **Lean: yes — file a small follow-up against the agent-adapter PRD when this lib lands.** |
| O5 | Streaming response parsing (validate as chunks arrive, fail-fast on first violation) — v1 or v1.x? **Lean: v1.x; v1's whole-payload parsing covers the 90% case.** |
| O6 | Fixture suite distribution — bundled or downloaded? **Lean: bundled in v1 (~100KB).** |

## 15. Implementation Phases

**Phase A — Skeleton + types** (~1 day)
1. Package skeleton.
2. `types.ts`, `registry.ts`, `errors.ts`, `tokenizer/interface.ts`.
3. Resolve TOON spec version to vendor.

**Phase B — Codec implementations (round-trip)** (~3 days)
4. `codecs/json-min/`, `codecs/yaml/`, `codecs/toon/{shape-detect, encoder, decoder}.ts`.
5. Property-based round-trip tests across all three codecs.
6. Capability declarations.

**Phase C — Request-side: measurement + transform** (~2 days)
7. `measure/density.ts` + LRU cache; `measure/recommend.ts`.
8. `transform/{manifest, apply}.ts`; `transform/pre-plugin.ts`.

**Phase D — Response-side: parse + repair + validate** (~3.5 days)
9. `response/repair/{json-repair, truncation, fence-strip}.ts` — repair primitives with documented decision tree.
10. `response/extract.ts` — fenced-block + preamble stripping; `response/parse.ts` + `response/fallback.ts`.
11. `response/typed-response.ts` — Zod-validated `parseTypedResponse<T>`; `response/diagnostics.ts` — tokenizer-aware truncation messages.
12. `response/post-plugin.ts` — harness PluginFactory.
13. JSON-repair test corpus (anonymized real outputs + synthetic truncation cases).

**Phase E — Schema lifecycle (the bridge)** (~2 days)
14. `schema-lifecycle/strategies/{tool-use, json-mode, prompt-augment}.ts` — three injection strategies.
15. `schema-lifecycle/prepare-request.ts` — auto-pick by capabilities.
16. `schema-lifecycle/{retry-feedback, run-typed-exchange}.ts` — convenience wrapper + concise-feedback retry.

**Phase F — Comprehension bench** (~2.5 days)
17. Fixture suite authoring (50 tasks × 5 tiers).
18. `bench/{comprehension, runner}.ts`; CLI entry point.
19. Methodology doc.

**Phase G — Companion packages + first consumer** (~1.5 days)
20. `token-codecs-anthropic-tokenizer/` + `token-codecs-tiktoken/`.
21. First-consumer integration: harness phase with paired pre/post-plugins.
22. Vendored TOON spec review against upstream — bump or freeze.

**Phase H — Ship** (~0.5 day)
23. README quickstart; CHANGELOG; internal publish.

Estimated calendar time: **13–16 focused days for v1**, with Phase D + E (response side + schema lifecycle) being the largest single addition. Plan budget: **18 days**.

**Sequencing note:** Phase B is the foundation; Phases C, D run in parallel after B. Phase E depends on D being mostly done (schema lifecycle calls into `parseTypedResponse`). Phase F (comprehension bench) requires B done — benches real codecs against a real model. Phase G first-consumer integration depends on harness pre/post-plugin slots being implemented (M2.7).

## 16. Future Work (v2+)

- **Streaming response validation** — validate as chunks arrive; fail-fast on the first chunk that violates schema (saves tokens by aborting early). Per O5.
- **Constrained-decoding helpers** — for backends with grammar constraints (llama.cpp BNF, OpenAI strict JSON), tighten request-side guarantees beyond schema-injection. Currently out of scope (§3).
- **CSV codec** — purely tabular tool inputs. Per O2.
- **Adaptive recommendation** — `recommend()` learns from comprehension-bench history per `(codec, model)` pair.
- **Multi-segment encoding** — different parts of one payload encoded with different codecs in one pass.
- **Structured-output retries with policy** — promote single-retry to a configurable retry chain with backoff (today: harness-library concern).
- **Token-cost estimation API** — given payload + codec + price table, return expected dollar cost.
- **Browser bundle** — for client-side hosts.
- **Visual diff tool** — JSON ↔ TOON side-by-side for educational/audit purposes.
- **Schema-aware codec selection** — given a Zod schema, recommend a codec based on shape characteristics (homogeneous-array fields → TOON) without needing to encode-and-measure first.

## 17. Out-of-Scope Forever (intentional)

- **Tokenizers themselves.** Lib never bundles a tokenizer.
- **Compression (gzip, zstd).** Irrelevant to token cost.
- **Becoming a prompt-template system.** Variable interpolation, conditionals, partials — not this lib's concern.
- **Becoming an agent-adapter middleware framework.** Per agent-adapter's "Not a content transformer" non-goal, codecs stay upstream of the adapter.
- **Becoming a schema language.** Schemas are Zod; lib consumes them, doesn't define them.
- **Defining a retry policy DSL.** Single retry inside `runTypedExchange` is convenience; multi-attempt policy lives in harness library.
- **Implementing constrained decoding at the model level.** Schema injection is advisory (tool-use, JSON mode, prompt); token-level constraint is the adapter/backend's concern.

## 18. Dependencies

| Dependency | Why | Hard / Soft |
|---|---|---|
| `yaml` (^2) | YAML codec | **Hard** |
| `zod` | Schema validation; manifest validation | **Hard** |
| `zod-to-json-schema` | Convert Zod schemas to JSON Schema for `tool-use` + `json-mode` strategies | **Hard** |
| `@your-org/token-codecs-anthropic-tokenizer` (companion pkg) | Convenience for Anthropic-targeting consumers | **Soft** |
| `@your-org/token-codecs-tiktoken` (companion pkg) | Convenience for OpenAI/Copilot-targeting consumers | **Soft** |
| `@anthropic-ai/tokenizer` (peer of companion) | Tokenizer impl | **Soft** |
| `tiktoken` (peer of companion) | Tokenizer impl | **Soft** |
| `@your-org/agent-adapter` | **None.** Type-only references in docs/examples; not imported. | n/a |
| `agentic-harness` library | Type-only dep for `PluginFactory` if pre/post plugins are consumed | **Soft** |

---

*End of token-codecs PRD.*
