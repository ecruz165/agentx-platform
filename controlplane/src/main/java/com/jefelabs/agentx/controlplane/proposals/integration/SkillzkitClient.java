package com.jefelabs.agentx.controlplane.proposals.integration;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.jefelabs.agentx.controlplane.proposals.api.dto.ComposeRequestDTO;
import com.jefelabs.agentx.controlplane.proposals.api.dto.ComposeResponseDTO;
import com.jefelabs.agentx.controlplane.proposals.domain.SkillProposal;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Skillzkit contribution client. Submits approved proposals to upstream
 * skillzkit's {@code POST /api/v1/contributions} endpoint
 * (see {@code agentx-toolbox/apps/skillzkit/lib/api/contracts.ts} —
 * {@code CreateContributionRequest} / {@code ContributionResponse}).
 *
 * <p>Per memory {@code project_skillzkit_is_skill_source_of_truth},
 * controlplane's catalog is a CACHE of skillzkit; new skills must
 * round-trip back to skillzkit so the next agentx-load sync picks
 * them up canonically. This client is the round-trip vehicle.
 *
 * <p>Configuration (Spring properties):
 * <ul>
 *   <li>{@code agentx.skillzkit.url} — base URL (e.g.,
 *       {@code https://skillzkit.example.com}). Empty string disables.
 *   <li>{@code agentx.skillzkit.token} — bearer token issued by
 *       skillzkit; mapped on its side to a stable AuthorIdentity.
 * </ul>
 *
 * <p>When the URL is empty (default), {@link #submit} returns
 * {@link SubmitResult.Skipped} so the proposal-approve flow still
 * works in standalone-controlplane setups (e.g., dev / CI without
 * skillzkit running). The skill_proposals row records null
 * remote_status in that case — operators can resubmit later via a
 * dedicated endpoint once skillzkit is wired.
 */
@Component
public class SkillzkitClient {

    private static final Logger log = LoggerFactory.getLogger(SkillzkitClient.class);

    private final RestClient restClient;
    private final String token;
    private final boolean configured;
    private final ObjectMapper mapper;

    public SkillzkitClient(
        @Value("${agentx.skillzkit.url:}") String baseUrl,
        @Value("${agentx.skillzkit.token:}") String token,
        ObjectMapper mapper
    ) {
        this.token = token == null ? "" : token;
        this.configured = baseUrl != null && !baseUrl.isBlank();
        this.restClient = configured
            ? RestClient.builder().baseUrl(baseUrl.replaceAll("/+$", "")).build()
            : null;
        this.mapper = mapper;
        if (configured) {
            log.info("SkillzkitClient configured: url={}", baseUrl);
            if (this.token.isBlank()) {
                log.warn("SkillzkitClient: agentx.skillzkit.url is set but agentx.skillzkit.token is empty — submissions will fail with 401");
            }
        } else {
            log.info("SkillzkitClient disabled: agentx.skillzkit.url is empty");
        }
    }

    /**
     * Submit an approved proposal to skillzkit. Translates the local
     * {@link SkillProposal} into the wire-shape
     * {@link CreateContributionRequest} and POSTs it. Three outcomes:
     *
     * <ul>
     *   <li>{@link SubmitResult.Submitted} — success; carries the
     *       remote contribution id, status, and URL for status polling.
     *   <li>{@link SubmitResult.Failed} — transport / 4xx / 5xx error;
     *       carries a short message that lands in the
     *       {@code remote_error} column. The proposal is still
     *       approved locally; operators can retry.
     *   <li>{@link SubmitResult.Skipped} — skillzkit is not configured
     *       (URL empty). Caller writes null to {@code remote_status}.
     * </ul>
     *
     * <p>Never throws — failures are returned as values. Approval is a
     * side-effecting flow already mid-transaction; an exception here
     * would force the operator to choose between rolling back the
     * approve (UX hostile) or swallowing the error (silent failure).
     * Returning a result lets the caller decide.
     */
    public SubmitResult submit(SkillProposal proposal) {
        if (!configured) {
            return new SubmitResult.Skipped();
        }

        CreateContributionRequest req = buildRequest(proposal);
        try {
            ContributionResponse resp = restClient.post()
                .uri("/api/v1/contributions")
                .contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .body(req)
                .retrieve()
                .onStatus(HttpStatusCode::isError, (request, response) -> {
                    // No-op handler — let .body() return a usable value
                    // for non-2xx with bodies, or throw the default error
                    // for empty bodies. The catch below normalizes.
                })
                .body(ContributionResponse.class);
            if (resp == null || resp.id() == null) {
                return new SubmitResult.Failed("skillzkit returned an empty response body");
            }
            // Skillzkit's Location header is /api/v1/contributions/{id};
            // we don't capture base URL here, so build the public URL
            // from baseUrl + that path. RestClient doesn't easily
            // expose the base URL, so cheat: ask the client for it.
            String url = String.format("/api/v1/contributions/%s", resp.id());
            return new SubmitResult.Submitted(resp.id(), resp.status(), url);
        } catch (RestClientException e) {
            log.warn("SkillzkitClient.submit failed for proposal id={} slug={}: {}",
                proposal.id(), proposal.name(), e.getMessage());
            return new SubmitResult.Failed(truncate(e.getMessage(), 500));
        } catch (RuntimeException e) {
            log.warn("SkillzkitClient.submit unexpected error for proposal id={} slug={}",
                proposal.id(), proposal.name(), e);
            return new SubmitResult.Failed(truncate(e.getMessage(), 500));
        }
    }

    /**
     * Re-fetch a previously-submitted contribution's status. Used by
     * the periodic poller to refresh {@code remote_status} when
     * skillzkit's reviewer (human or automated) advances the
     * lifecycle. Same error-as-value contract as {@link #submit}.
     */
    public FetchResult fetch(String remoteId) {
        if (!configured) {
            return new FetchResult.Skipped();
        }
        try {
            ContributionResponse resp = restClient.get()
                .uri("/api/v1/contributions/{id}", remoteId)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .retrieve()
                .body(ContributionResponse.class);
            if (resp == null || resp.id() == null) {
                return new FetchResult.Failed("skillzkit returned empty body");
            }
            return new FetchResult.Fetched(resp.id(), resp.status());
        } catch (RuntimeException e) {
            log.warn("SkillzkitClient.fetch failed for remoteId={}: {}", remoteId, e.getMessage());
            return new FetchResult.Failed(truncate(e.getMessage(), 500));
        }
    }

    public boolean isConfigured() {
        return configured;
    }

    // ── request shape (mirrors skillzkit's CreateContributionRequest) ───────

    private static CreateContributionRequest buildRequest(SkillProposal p) {
        // Skillzkit expects:
        //   kind:      'skill' (we always submit skills here; commands /
        //              workflows go through different flows in v2)
        //   slug:      the skill name — skillzkit uses this as the
        //              SKILL.md identifier; controlplane proposals use
        //              the same naming convention so this is identical
        //   frontmatter: structured metadata; skillzkit's parser pulls
        //              tags, category, description from here
        //   files:     [{ path: "SKILL.md", content: <markdown body> }]
        //   changelog: optional human-readable note for skillzkit's
        //              version history
        Map<String, Object> frontmatter = new java.util.LinkedHashMap<>();
        frontmatter.put("name", p.name());
        if (p.description() != null) frontmatter.put("description", p.description());
        if (p.category() != null) frontmatter.put("category", p.category());
        if (p.tags() != null && !p.tags().isEmpty()) frontmatter.put("tags", p.tags());

        String body = buildSkillMarkdown(p);

        return new CreateContributionRequest(
            "skill",
            p.name(),
            frontmatter,
            List.of(new ContributionFile("SKILL.md", body)),
            null,                                                   // versionBump
            "Submitted from agentx-controlplane proposal " + p.id() // changelog
        );
    }

    /**
     * Synthesize a SKILL.md body from the proposal. Skillzkit's parser
     * uses front-matter for structured fields and the body for
     * narrative documentation; here we project description (if any)
     * + rationale into a minimal but useful body. Reviewers in
     * skillzkit can edit before merging — this body is a starting
     * point, not the final form.
     */
    private static String buildSkillMarkdown(SkillProposal p) {
        StringBuilder sb = new StringBuilder();
        sb.append("# ").append(p.name()).append('\n').append('\n');
        if (p.description() != null && !p.description().isBlank()) {
            sb.append(p.description()).append('\n').append('\n');
        }
        if (p.rationale() != null && !p.rationale().isBlank()) {
            sb.append("## Why this skill is needed\n\n");
            sb.append(p.rationale()).append('\n').append('\n');
        }
        if (p.sourceJobId() != null) {
            sb.append("> Proposed from agentx job `").append(p.sourceJobId()).append("`\n");
        }
        return sb.toString();
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    // ── wire-shape DTOs (private; mirror skillzkit contracts.ts) ─────────────

    /** Maps to skillzkit's CreateContributionRequest. */
    record CreateContributionRequest(
        String kind,
        String slug,
        Map<String, Object> frontmatter,
        List<ContributionFile> files,
        String versionBump,
        String changelog
    ) {
    }

    /** Maps to skillzkit's ContributionFile (one entry per file in the bundle). */
    record ContributionFile(String path, String content) {
    }

    /** Maps to skillzkit's ContributionResponse — partial: only the
     *  fields we actually use to update local state. Skillzkit may
     *  return more (findings, version, promoted, author); Jackson
     *  ignores unknown properties by default in this codebase. */
    record ContributionResponse(String id, String status) {
    }

    // ── result types ─────────────────────────────────────────────────────────

    public sealed interface SubmitResult permits SubmitResult.Submitted, SubmitResult.Failed, SubmitResult.Skipped {
        record Submitted(String remoteId, String remoteStatus, String remoteUrl) implements SubmitResult {}
        record Failed(String error) implements SubmitResult {}
        record Skipped() implements SubmitResult {}
    }

    public sealed interface FetchResult permits FetchResult.Fetched, FetchResult.Failed, FetchResult.Skipped {
        record Fetched(String remoteId, String remoteStatus) implements FetchResult {}
        record Failed(String error) implements FetchResult {}
        record Skipped() implements FetchResult {}
    }

    // ── compose-from-scratch (controlplane-ui /compose page) ─────────────────

    /**
     * Submit a compose-from-scratch contribution. Unlike {@link #submit},
     * this path doesn't translate from a local SkillProposal — it
     * forwards the caller's {@link ComposeRequestDTO} (already in the
     * skillzkit wire shape) and returns either:
     *
     * <ul>
     *   <li>{@link ComposeResult.Submitted} — 2xx success; full
     *       ContributionResponse data.
     *   <li>{@link ComposeResult.ApiError} — 4xx with parsed envelope
     *       (code + message + details). Maps to the same HTTP status
     *       on the controlplane side via the controller.
     *   <li>{@link ComposeResult.TransportError} — network / 5xx /
     *       parse failure.
     *   <li>{@link ComposeResult.Skipped} — skillzkit not configured.
     * </ul>
     *
     * Uses {@code RestClient.exchange} so we can handle non-2xx
     * bodies without an exception path; the existing {@link #submit}
     * uses {@code .retrieve().body(...)} which throws on 4xx and
     * collapses error details into a generic message — fine for the
     * proposal flow but not for the compose UI which needs structured
     * findings.
     */
    public ComposeResult submitContribution(ComposeRequestDTO req) {
        if (!configured) {
            return new ComposeResult.Skipped();
        }
        try {
            return restClient.post()
                .uri("/api/v1/contributions")
                .contentType(MediaType.APPLICATION_JSON)
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .body(req)
                .exchange((reqEntity, response) -> parseComposeResponse(response));
        } catch (RestClientResponseException e) {
            // Some configurations rethrow before exchange callback runs
            return parseErrorBody(e.getStatusCode().value(), e.getResponseBodyAsString());
        } catch (RestClientException e) {
            log.warn("SkillzkitClient.submitContribution transport failure for slug={}: {}",
                req.slug(), e.getMessage());
            return new ComposeResult.TransportError(truncate(e.getMessage(), 500));
        } catch (RuntimeException e) {
            log.warn("SkillzkitClient.submitContribution unexpected error for slug={}",
                req.slug(), e);
            return new ComposeResult.TransportError(truncate(e.getMessage(), 500));
        }
    }

    private ComposeResult parseComposeResponse(
        org.springframework.http.client.ClientHttpResponse response
    ) {
        int status;
        String body;
        try {
            status = response.getStatusCode().value();
            byte[] bytes = response.getBody().readAllBytes();
            body = new String(bytes, StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            return new ComposeResult.TransportError(
                "Could not read skillzkit response body: " + e.getMessage()
            );
        }
        if (status >= 200 && status < 300) {
            try {
                ComposeResponseDTO dto = mapper.readValue(body, ComposeResponseDTO.class);
                return new ComposeResult.Submitted(dto);
            } catch (JsonProcessingException e) {
                return new ComposeResult.TransportError(
                    "skillzkit returned a 2xx response we could not parse: " + e.getMessage()
                );
            }
        }
        return parseErrorBody(status, body);
    }

    private ComposeResult parseErrorBody(int status, String body) {
        if (body == null || body.isBlank()) {
            return new ComposeResult.ApiError(
                status, "internal_error",
                "skillzkit returned status " + status + " with no body",
                Map.of()
            );
        }
        try {
            JsonNode envelope = mapper.readTree(body);
            String code = envelope.path("code").asText("internal_error");
            String message = envelope.path("message").asText("skillzkit error");
            JsonNode detailsNode = envelope.path("details");
            Map<String, Object> details = detailsNode.isObject()
                ? mapper.convertValue(detailsNode, new TypeReference<Map<String, Object>>() {})
                : new HashMap<>();
            return new ComposeResult.ApiError(status, code, message, details);
        } catch (JsonProcessingException e) {
            return new ComposeResult.ApiError(
                status, "internal_error",
                "skillzkit returned non-JSON error body (status " + status + ")",
                Map.of("raw", truncate(body, 500))
            );
        }
    }

    public sealed interface ComposeResult permits
        ComposeResult.Submitted,
        ComposeResult.ApiError,
        ComposeResult.TransportError,
        ComposeResult.Skipped {

        record Submitted(ComposeResponseDTO response) implements ComposeResult {}

        /** Skillzkit returned a structured 4xx. Carries the envelope's
         *  code / message / details + the original HTTP status so the
         *  controller can re-emit the same status without re-mapping. */
        record ApiError(
            int httpStatus,
            String code,
            String message,
            Map<String, Object> details
        ) implements ComposeResult {}

        /** Network failure, 5xx, or response we couldn't parse. The
         *  controller surfaces this as 502 Bad Gateway with a generic
         *  envelope. */
        record TransportError(String message) implements ComposeResult {}

        /** Skillzkit is not configured (agentx.skillzkit.url empty).
         *  Controller surfaces as 503. */
        record Skipped() implements ComposeResult {}
    }
}
