package com.jefelabs.agentx.controlplane.catalog.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * skillzkit catalog category. Mirrors AgentDef.skillz keys
 * ({@code routers}, {@code tools}, {@code integrations}, {@code tasks},
 * {@code workflows}) flattened into a single discriminator stored on
 * each skill row.
 *
 * <p>{@code router} is a SKILL (router agent) in skillzkit terms; the
 * other four are Command sub-types.
 */
public enum SkillCategory {
    @JsonProperty("router") ROUTER,
    @JsonProperty("tool") TOOL,
    @JsonProperty("integration") INTEGRATION,
    @JsonProperty("task") TASK,
    @JsonProperty("workflow") WORKFLOW;

    public String dbValue() {
        return switch (this) {
            case ROUTER -> "router";
            case TOOL -> "tool";
            case INTEGRATION -> "integration";
            case TASK -> "task";
            case WORKFLOW -> "workflow";
        };
    }

    public static SkillCategory fromDbValue(String value) {
        return switch (value) {
            case "router" -> ROUTER;
            case "tool" -> TOOL;
            case "integration" -> INTEGRATION;
            case "task" -> TASK;
            case "workflow" -> WORKFLOW;
            default -> throw new IllegalArgumentException("Unknown SkillCategory dbValue: " + value);
        };
    }
}
