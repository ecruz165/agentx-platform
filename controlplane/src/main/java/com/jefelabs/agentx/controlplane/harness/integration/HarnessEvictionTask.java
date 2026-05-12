package com.jefelabs.agentx.controlplane.harness.integration;

import com.jefelabs.agentx.controlplane.harness.service.HarnessService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;

/**
 * W1a — periodically evicts harnesses whose heartbeat has gone stale,
 * marking them {@code DISCONNECTED} so {@code HarnessRouter} stops
 * dispatching jobs to dead endpoints.
 *
 * <p>The harness-server launcher heartbeats every ~30s; a harness with
 * no heartbeat for {@value #STALENESS_SECONDS}s — or one that registered
 * but never heartbeated for that long — is evicted. ({@code @Scheduled}
 * is enabled application-wide via {@code @EnableScheduling} on
 * {@code ControlplaneApplication}.)
 */
@Component
public class HarnessEvictionTask {

    private static final Logger log = LoggerFactory.getLogger(HarnessEvictionTask.class);

    /** Heartbeat-staleness threshold; ~4× the 30s heartbeat interval. */
    private static final long STALENESS_SECONDS = 120;
    private static final long SWEEP_INTERVAL_MS = 30_000;

    private final HarnessService harnessService;

    public HarnessEvictionTask(HarnessService harnessService) {
        this.harnessService = harnessService;
    }

    @Scheduled(fixedDelay = SWEEP_INTERVAL_MS, initialDelay = SWEEP_INTERVAL_MS)
    public void evictStale() {
        try {
            int n = harnessService.evictStaleHarnesses(Duration.ofSeconds(STALENESS_SECONDS));
            if (n > 0) {
                log.info("harness eviction sweep: marked {} stale harness(es) disconnected", n);
            }
        } catch (RuntimeException e) {
            // Don't let a transient DB blip kill the scheduler thread.
            log.warn("harness eviction sweep failed: {}", e.getMessage());
        }
    }
}
