package com.jefelabs.agentx.controlplane.catalog.integration;

import com.jefelabs.agentx.controlplane.catalog.domain.Skill;

import java.util.List;

/**
 * Seam between the controlplane's Skill catalog and {@code @ecruz165/skillzkit}
 * (the external skill catalog distributed via npm + git as markdown files +
 * metadata).
 *
 * <p>Per project decision (memory: {@code project_skillzkit_is_skill_source_of_truth}):
 * skillzkit is the canonical source of truth for skill *definitions*; the
 * controlplane's {@code skills} table caches them so org-scoped browse +
 * filter + enablement stays performant. Implementations of this interface
 * pull from skillzkit and upsert into the local cache.
 *
 * <p><b>Phase 1 status:</b> stub interface only. The actual implementation
 * lands in Phase 1.x once the skillzkit distribution shape is decided
 * (manifest API vs. crawl markdown vs. published JSON index). Until then,
 * the {@code POST /api/catalog/skills} endpoint allows manual seeding.
 *
 * <p>Triggers (when implemented):
 * <ul>
 *   <li>Bootstrap on first app startup (no skills cached yet).</li>
 *   <li>Scheduled refresh (default: daily — configurable via Spring scheduling).</li>
 *   <li>Manual {@code POST /api/catalog/skills/sync} (operator-driven).</li>
 * </ul>
 */
public interface SkillzkitSyncService {

    /**
     * Pull the latest skill catalog from skillzkit and upsert into the local
     * {@code skills} table for the given org. Returns the skills that were
     * synced (newly inserted or updated).
     *
     * @param orgId tenant scope — sync runs per-org so per-tenant filtering
     *              (curated subsets, enablement policies) can layer on top.
     */
    List<Skill> sync(String orgId);
}
