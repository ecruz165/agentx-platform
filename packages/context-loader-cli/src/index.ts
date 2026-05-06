/**
 * @agentx/context-loader-cli — public barrel (mostly empty).
 *
 * The CLI package's primary surface is the `agentx-load` binary (see ./bin.ts).
 * This index file exists for consumers (e.g., harness-cli's workspace shim)
 * that want to invoke CLI behaviors programmatically without spawning a
 * subprocess. Phase A: nothing exported yet; Phase F+ adds programmatic
 * entry points if needed.
 */

// Re-export core types for convenience so consumers don't have to import
// from two places when wrapping the CLI.
export type {
  IngestionEvent,
  SourceRef,
  SourceTypeId,
} from '@agentx/context-loader-core';
