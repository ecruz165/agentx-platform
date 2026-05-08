package com.jefelabs.agentx.controlplane.job.api.dto;

import tools.jackson.databind.JsonNode;

/**
 * Wire format for {@code POST /api/jobs/{id}/reflection}. Posted by
 * an agent (or human) after a job's terminal state to capture the
 * post-hoc retrospective: actual story points, free-text reflection,
 * and structured surprises (each surprise object can declare
 * {@code kind: 'missing-skill'} which the controller forwards into
 * the {@code skill_proposals} queue).
 *
 * <p>Example:
 * <pre>{@code
 * {
 *   "actualPoints": 8,
 *   "reflection": "I underestimated; the auth handshake was tricky.",
 *   "surprises": [
 *     {
 *       "kind": "missing-skill",
 *       "name": "aws/sigv4-signing",
 *       "description": "Sign HTTP requests with AWS SigV4",
 *       "category": "tool",
 *       "tags": ["aws","auth"],
 *       "why": "Had to hand-roll signing because no skill existed"
 *     }
 *   ]
 * }
 * }</pre>
 */
public record JobReflectionRequestDTO(
    Double actualPoints,
    String reflection,
    JsonNode surprises
) {
}
