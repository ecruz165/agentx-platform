package com.jefelabs.agentx.controlplane.proposals.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.Map;

/**
 * Generic error envelope returned on non-2xx responses from the
 * compose endpoint. Mirrors skillzkit's {@code ApiError} shape +
 * controlplane-ui's {@code ApiError} client class - the UI parses
 * {@code code} and {@code details} to render context-appropriate
 * remediation hints (validation findings, slug-conflict version,
 * author-mismatch owner id).
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ApiErrorEnvelopeDTO(
    /** Stable machine-readable code: "validation_failed",
     *  "author_mismatch", "slug_conflict", "unauthorized",
     *  "internal_error", "skillzkit_unavailable". */
    String code,
    /** Human-readable message. */
    String message,
    /** Free-form per-code structured details. For
     *  "validation_failed", carries {@code findings: [...]}; for
     *  "author_mismatch", carries {@code ownerAuthorId}; for
     *  "slug_conflict", carries {@code version}. */
    Map<String, Object> details
) {
}
