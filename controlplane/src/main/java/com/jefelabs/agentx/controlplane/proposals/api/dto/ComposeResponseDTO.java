package com.jefelabs.agentx.controlplane.proposals.api.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

/**
 * Response body for a successful compose submission. Mirrors
 * skillzkit's {@code ContributionResponse} so the UI's typed client
 * (controlplane-ui/src/lib/api.ts {@code ComposeResponse}) maps 1:1.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ComposeResponseDTO(
    /** Content-addressable id: "{kind}:{slug}@{version}". */
    String id,
    String slug,
    String kind,
    /** "pending" | "reviewing" | "accepted" | "rejected" | "promoted". */
    String status,
    /** Set when the contribution lands in storage. */
    String version,
    /** Whether the catalog index points at this version. */
    boolean promoted,
    AuthorDTO author,
    /** Non-blocking findings (low/medium severity). High-severity
     *  findings are returned as a 422 error envelope, not in this
     *  field. */
    List<FindingDTO> findings,
    String createdAt
) {

    public record AuthorDTO(String id, String displayName, String email) {
    }

    public record FindingDTO(
        /** "low" | "medium" | "high". */
        String severity,
        /** "structural" | "bundle" | "quality" | "tag-fit" | "safety". */
        String axis,
        String message,
        /** Optional file path within the bundle. */
        String fileRef
    ) {
    }
}
