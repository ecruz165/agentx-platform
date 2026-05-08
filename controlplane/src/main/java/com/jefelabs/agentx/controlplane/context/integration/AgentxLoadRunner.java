package com.jefelabs.agentx.controlplane.context.integration;

import com.jefelabs.agentx.controlplane.context.domain.ContextSource;
import com.jefelabs.agentx.controlplane.context.persistence.IngestionJobDao;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Spawns the {@code @ecruz165/context-loader-cli} (agentx-load) as a
 * subprocess to ingest a context source into the central Neo4j graph.
 * Per prd-context-module.md F3, D1: one source of truth for chunkers
 * (the TS implementation), no Java reimplementation.
 *
 * <p>The CLI emits one {@code IngestionEvent} JSON per line on stdout
 * when invoked with {@code --output json}. This runner reads each line,
 * parses by {@code kind}, and updates the {@code ingestion_jobs} row at
 * key transitions:
 *
 * <ul>
 *   <li>{@code source-completed} (terminal success) — extracts
 *       {@code chunksWritten}, marks the row COMPLETED.</li>
 *   <li>{@code error} (terminal failure) — extracts {@code message},
 *       marks the row FAILED.</li>
 *   <li>Per-item / per-chunk events (item-walked, chunk-produced,
 *       chunk-embedded, node-written, edge-written) — counted for
 *       progress reporting in Phase 4.4.</li>
 * </ul>
 *
 * <p>{@code @Async} runs each invocation on a Spring-managed virtual
 * thread (per umbrella PRD D14); HTTP submission returns immediately.
 *
 * <p>Configurable via {@code agentx.context-loader.*}:
 * <ul>
 *   <li>{@code command} (list) — prefix args; e.g.
 *       {@code [bun, ../packages/context-loader-cli/src/bin.ts]} for dev,
 *       {@code [agentx-load]} for the static binary in production.</li>
 *   <li>{@code working-dir} — cwd for the subprocess; resolves workspace deps.</li>
 * </ul>
 */
@Component
public class AgentxLoadRunner {

    private static final Logger log = LoggerFactory.getLogger(AgentxLoadRunner.class);

    private final Jdbi jdbi;
    private final ObjectMapper objectMapper;
    private final List<String> baseCommand;
    private final String workingDir;
    private final String neo4jUri;
    private final String neo4jUser;
    private final String neo4jPassword;
    private final String embedderUrl;
    private final String embedderModel;
    private final int embedderDim;

    public AgentxLoadRunner(
        Jdbi jdbi,
        ObjectMapper objectMapper,
        @Value("${agentx.context-loader.command:bun,packages/context-loader-cli/src/bin.ts}") String baseCommandCsv,
        @Value("${agentx.context-loader.working-dir:..}") String workingDir,
        @Value("${agentx.neo4j.uri:bolt://localhost:7687}") String neo4jUri,
        @Value("${agentx.neo4j.user:neo4j}") String neo4jUser,
        @Value("${agentx.neo4j.password:controlplane}") String neo4jPassword,
        @Value("${agentx.embedder.url:http://localhost:8081}") String embedderUrl,
        @Value("${agentx.embedder.model:BAAI/bge-small-en-v1.5}") String embedderModel,
        @Value("${agentx.embedder.dimension:384}") int embedderDim
    ) {
        this.jdbi = jdbi;
        this.objectMapper = objectMapper;
        this.baseCommand = java.util.Arrays.stream(baseCommandCsv.split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .toList();
        this.workingDir = workingDir;
        this.neo4jUri = neo4jUri;
        this.neo4jUser = neo4jUser;
        this.neo4jPassword = neo4jPassword;
        this.embedderUrl = embedderUrl + "/v1";  // CLI expects /v1 root
        this.embedderModel = embedderModel;
        this.embedderDim = embedderDim;
        log.info("AgentxLoadRunner configured: command={} cwd={} neo4j={} embedder={}",
            this.baseCommand, workingDir, neo4jUri, embedderUrl);
    }

    /**
     * Spawn the CLI for the given source and update its ingestion_jobs row
     * as events arrive. Returns immediately (virtual-thread-backed @Async);
     * caller polls {@code /api/context/sources/{id}/ingestions} for status.
     */
    @Async
    public void runIngestion(ContextSource source, UUID ingestionJobId) {
        IngestionJobDao dao = jdbi.onDemand(IngestionJobDao.class);
        dao.markRunning(ingestionJobId);

        List<String> command = buildCommand(source);
        log.info("[ingest {}] starting: {}", ingestionJobId, command);

        int chunkCount = 0;
        String terminalError = null;

        try {
            ProcessBuilder pb = new ProcessBuilder(command)
                .directory(new File(workingDir))
                .redirectErrorStream(false);
            Process process = pb.start();

            // Read stdout — one IngestionEvent JSON per line
            try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))
            ) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isBlank()) continue;
                    try {
                        JsonNode event = objectMapper.readTree(line);
                        String kind = event.path("kind").asText("");
                        if ("source-completed".equals(kind)) {
                            chunkCount = event.path("chunksWritten").asInt(0);
                            log.info("[ingest {}] source-completed: chunksWritten={}",
                                ingestionJobId, chunkCount);
                        } else if ("error".equals(kind)) {
                            terminalError = event.path("message").asText("CLI error");
                            log.warn("[ingest {}] error event: {}", ingestionJobId, terminalError);
                        } else {
                            log.debug("[ingest {}] event: kind={}", ingestionJobId, kind);
                        }
                    } catch (Exception parseErr) {
                        log.warn("[ingest {}] failed to parse stdout line: {}",
                            ingestionJobId, line);
                    }
                }
            }

            // Drain stderr separately for context on failures
            String stderr = readAll(process.getErrorStream());

            int exitCode = process.waitFor();
            if (exitCode == 0 && terminalError == null) {
                dao.markCompleted(ingestionJobId, chunkCount);
                log.info("[ingest {}] completed: {} chunks", ingestionJobId, chunkCount);
            } else {
                String reason = terminalError != null
                    ? terminalError
                    : ("CLI exit=" + exitCode + (stderr.isBlank() ? "" : "; stderr: " + stderr));
                dao.markFailed(ingestionJobId, reason);
                log.warn("[ingest {}] failed: {}", ingestionJobId, reason);
            }
        } catch (IOException e) {
            String reason = "spawn failed: " + e.getMessage();
            dao.markFailed(ingestionJobId, reason);
            log.error("[ingest {}] {}", ingestionJobId, reason, e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            dao.markFailed(ingestionJobId, "interrupted");
            log.warn("[ingest {}] interrupted", ingestionJobId);
        }
    }

    /** Compose the full CLI argv from base command + source-specific args. */
    private List<String> buildCommand(ContextSource source) {
        List<String> args = new ArrayList<>(baseCommand);
        args.add(source.target());
        args.add("--type");          args.add(source.kind().dbValue());
        args.add("--backend");       args.add(neo4jUri);
        args.add("--backend-user");  args.add(neo4jUser);
        args.add("--backend-password"); args.add(neo4jPassword);
        args.add("--embedder-url");  args.add(embedderUrl);
        args.add("--embedder-model"); args.add(embedderModel);
        args.add("--embedder-dim");  args.add(String.valueOf(embedderDim));
        args.add("--output");        args.add("json");
        return args;
    }

    private String readAll(java.io.InputStream stream) throws IOException {
        try (BufferedReader r = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = r.readLine()) != null) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(line);
            }
            return sb.toString();
        }
    }
}
