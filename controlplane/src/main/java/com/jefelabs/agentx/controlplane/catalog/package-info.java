/**
 * Catalog module — system of record for pipelines, agents, skills, and products.
 *
 * <p>Closed module. Public surface exposed via Spring beans (REST controllers + read-only
 * services). Cross-module communication via published {@code CatalogChangedEvent}s.
 *
 * <p>See {@code .plans/2026-05-07-prd-catalog-module.md}.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Catalog"
)
package com.jefelabs.agentx.controlplane.catalog;
