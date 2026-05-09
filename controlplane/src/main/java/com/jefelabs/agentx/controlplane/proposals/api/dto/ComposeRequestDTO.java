package com.jefelabs.agentx.controlplane.proposals.api.dto;

import java.util.List;
import java.util.Map;

/**
 * Request body for {@code POST /api/skill-proposals/compose} —
 * author-from-scratch contributions submitted directly from
 * controlplane-ui's /compose page (or any other client). Mirrors
 * skillzkit's {@code CreateContributionRequest} wire shape so the
 * controlplane proxy can pass the payload through with minimal
 * translation.
 *
 * <p>Differs from the proposal-driven flow ({@link SkillProposalDTO}):
 * compose has no local SkillProposal record; the caller has authored
 * the bundle directly and we forward it. If skillzkit accepts, the
 * caller gets the contribution id + version back without persisting
 * anything in controlplane's proposal table.
 */
public record ComposeRequestDTO(
    /** "command" | "workflow" | "skill". */
    String kind,
    /** Slash-command slug (commands/workflows) or skill name. */
    String slug,
    /** Frontmatter parsed from the primary file - keys depend on kind. */
    Map<String, Object> frontmatter,
    /** Bundle files. Single .md for command/workflow; SKILL.md +
     *  optional companions for skill. */
    List<ComposeFileDTO> files,
    /** Optional - "major" | "minor" | "patch". Defaults to patch. */
    String versionBump,
    /** Optional changelog message for the version. */
    String changelog
) {

    public record ComposeFileDTO(String path, String content) {
    }
}
