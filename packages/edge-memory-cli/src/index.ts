/**
 * Library entry — re-exports the testable run() so consumers can embed
 * the CLI logic without spawning a subprocess. Cold-start matters for
 * the bin path (bin.ts), not for library consumers.
 */
export { type RunIO, run } from './main.ts';
