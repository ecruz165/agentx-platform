package com.jefelabs.agentx.controlplane.core.types;

import tools.jackson.databind.JsonNode;

/**
 * The command-shape that crosses every job-submission boundary in the
 * platform: from Intent → Job (chat-driven), from Job's REST API → Job
 * (programmatic), and from a future CallStep → Job (sub-job nesting).
 *
 * <p>Lives in {@code core} (an open module) so both {@code intent} and
 * {@code job} can reference it without declaring a peer dependency
 * (per the layering captured in {@code prd-core-module.md} D2).
 *
 * <p>Fields:
 * <ul>
 *   <li>{@code flowId} — required; the catalog FlowDef to execute.</li>
 *   <li>{@code productId} — required; the product context (drives
 *       repo resolution + context source enablement).</li>
 *   <li>{@code input} — runtime input as opaque JSON.</li>
 *   <li>{@code set} — optional accepts-set selector (e.g. "frontier",
 *       "cheap"); falls back to "default" per AgentDef.accepts rules.</li>
 *   <li>{@code config} — optional per-job overrides (e.g. model
 *       endpoint, reasoning effort) passed through to adapters.</li>
 * </ul>
 */
public record JobIntent(
    String flowId,
    String productId,
    JsonNode input,
    String set,
    JsonNode config
) {
}
