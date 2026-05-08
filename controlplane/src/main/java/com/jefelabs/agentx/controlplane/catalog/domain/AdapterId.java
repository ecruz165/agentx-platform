package com.jefelabs.agentx.controlplane.catalog.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Adapter implementation that runs an agent. Mirrors TS-side
 * {@code AdapterId = 'claude-sdk' | 'opencode-cli'} from
 * {@code harness-core/src/catalog.ts}.
 *
 * <p>Wire format uses the hyphenated names; Java identifiers are UPPER_SNAKE.
 */
public enum AdapterId {
    @JsonProperty("claude-sdk")
    CLAUDE_SDK,

    @JsonProperty("opencode-cli")
    OPENCODE_CLI;

    public String dbValue() {
        return switch (this) {
            case CLAUDE_SDK -> "claude-sdk";
            case OPENCODE_CLI -> "opencode-cli";
        };
    }

    public static AdapterId fromDbValue(String value) {
        return switch (value) {
            case "claude-sdk" -> CLAUDE_SDK;
            case "opencode-cli" -> OPENCODE_CLI;
            default -> throw new IllegalArgumentException("Unknown AdapterId dbValue: " + value);
        };
    }
}
