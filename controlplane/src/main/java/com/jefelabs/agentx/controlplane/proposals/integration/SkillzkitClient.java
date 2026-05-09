package com.jefelabs.agentx.controlplane.proposals.integration;

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

    public SkillzkitClient(
        @Value("${agentx.skillzkit.url:}") String baseUrl,
        @Value("${agentx.skillzkit.token:}") String token
    ) {
        this.token = token == null ? "" : token;
        this.configured = baseUrl != null && !baseUrl.isBlank();
        this.restClient = configured
            ? RestClient.builder().baseUrl(baseUrl.replaceAll("/+$", "")).build()
            : null;
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
}
