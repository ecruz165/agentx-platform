package com.jefelabs.agentx.controlplane.catalog.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Type discriminator for {@link CatalogItem}, mirroring agentx-skillz's
 * 6 manifest types (singular form, lowercase). Wire format and DB column
 * use the same lowercase string.
 */
public enum CatalogItemType {
    @JsonProperty("skill")    SKILL,
    @JsonProperty("workflow") WORKFLOW,
    @JsonProperty("prompt")   PROMPT,
    @JsonProperty("persona")  PERSONA,
    @JsonProperty("context")  CONTEXT,
    @JsonProperty("template") TEMPLATE;

    public String dbValue() {
        return name().toLowerCase();
    }

    public static CatalogItemType fromDbValue(String v) {
        return switch (v) {
            case "skill"    -> SKILL;
            case "workflow" -> WORKFLOW;
            case "prompt"   -> PROMPT;
            case "persona"  -> PERSONA;
            case "context"  -> CONTEXT;
            case "template" -> TEMPLATE;
            default -> throw new IllegalArgumentException("Unknown CatalogItemType: " + v);
        };
    }
}
