package com.jefelabs.agentx.controlplane.context.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Context-source content type. Mirrors prd-context-module.md F4 and the
 * TS-side {@code SourceTypeId} from {@code @ecruz165/context-loader-core}.
 */
public enum SourceKind {
    @JsonProperty("oss-package")    OSS_PACKAGE,
    @JsonProperty("prose-markdown") PROSE_MARKDOWN,
    @JsonProperty("crawled-web")    CRAWLED_WEB,
    @JsonProperty("oss-docs")       OSS_DOCS;

    public String dbValue() {
        return switch (this) {
            case OSS_PACKAGE -> "oss-package";
            case PROSE_MARKDOWN -> "prose-markdown";
            case CRAWLED_WEB -> "crawled-web";
            case OSS_DOCS -> "oss-docs";
        };
    }

    public static SourceKind fromDbValue(String value) {
        return switch (value) {
            case "oss-package" -> OSS_PACKAGE;
            case "prose-markdown" -> PROSE_MARKDOWN;
            case "crawled-web" -> CRAWLED_WEB;
            case "oss-docs" -> OSS_DOCS;
            default -> throw new IllegalArgumentException("Unknown SourceKind dbValue: " + value);
        };
    }
}
