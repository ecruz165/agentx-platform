package com.jefelabs.agentx.controlplane.harness.api.dto;

/**
 * Response of {@code POST /api/registry/harnesses}. The harness keeps the
 * {@code sessionToken} and presents it on subsequent heartbeat calls.
 *
 * <p>Phase 2 MVP: token is an opaque random string with no signing or
 * expiry. Phase 7 auth replaces this with a signed/scoped token per
 * prd-control-plane-operational-hardening.md §6.3.
 */
public record RegisterHarnessResponseDTO(
    String harnessId,
    String sessionToken,
    HarnessDTO harness
) {
}
