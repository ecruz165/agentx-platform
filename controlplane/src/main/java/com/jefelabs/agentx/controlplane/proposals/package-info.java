/**
 * Skill proposals — the governance queue between agent reflections
 * ("I needed a skill that didn't exist") and the unified catalog.
 * Proposals are reviewed by an admin; approving seeds a draft into
 * {@code catalog_items} (type=skill); a future iteration pushes the
 * draft back to @ecruz165/skillzkit as a real PR.
 *
 * <p>Closed module. Depends on catalog.service via the existing
 * {@code @NamedInterface("services")} so approval can write to the
 * unified catalog.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Proposals"
)
package com.jefelabs.agentx.controlplane.proposals;
