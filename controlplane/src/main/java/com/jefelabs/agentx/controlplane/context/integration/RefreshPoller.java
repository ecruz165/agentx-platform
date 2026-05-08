package com.jefelabs.agentx.controlplane.context.integration;

import com.jefelabs.agentx.controlplane.context.persistence.ContextSourceDao;
import com.jefelabs.agentx.controlplane.context.persistence.ContextSourceDaoRow;
import com.jefelabs.agentx.controlplane.context.service.ContextService;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Phase 4.4 — periodically scans {@code context_sources} and re-triggers
 * ingestion for sources whose cadence has elapsed. The "due" predicate
 * (cadence + in-flight exclusion) lives entirely in
 * {@link ContextSourceDao#findDueForRefresh(long, long)}; this class is just
 * a scheduled fan-out: each due source delegates to the same
 * {@link ContextService#triggerIngestion(String, String)} the manual API
 * endpoint uses, so there's exactly one ingestion code path.
 *
 * <p>Disable via {@code agentx.context-loader.refresh-poller.enabled=false}
 * (tests, profiles where the Bun/Neo4j stack isn't available). Cron schedule
 * and cadence intervals are configurable so tests can run a tight loop
 * without changing schema.
 */
@Component
@ConditionalOnProperty(
    name = "agentx.context-loader.refresh-poller.enabled",
    havingValue = "true",
    matchIfMissing = true
)
public class RefreshPoller {

    private static final Logger log = LoggerFactory.getLogger(RefreshPoller.class);

    private final Jdbi jdbi;
    private final ContextService contextService;
    private final long dailySeconds;
    private final long weeklySeconds;

    public RefreshPoller(
        Jdbi jdbi,
        ContextService contextService,
        @Value("${agentx.context-loader.refresh-poller.daily-seconds:86400}") long dailySeconds,
        @Value("${agentx.context-loader.refresh-poller.weekly-seconds:604800}") long weeklySeconds
    ) {
        this.jdbi = jdbi;
        this.contextService = contextService;
        this.dailySeconds = dailySeconds;
        this.weeklySeconds = weeklySeconds;
        log.info("RefreshPoller configured: dailySeconds={} weeklySeconds={}",
            dailySeconds, weeklySeconds);
    }

    /**
     * Runs on the configured cron schedule. Default is hourly; tests override
     * via {@code agentx.context-loader.refresh-poller.cron}.
     *
     * <p>Returns void and swallows per-source errors so that a single bad
     * source can't poison the rest of the batch — each ingestion is
     * independent and the next tick will retry.
     */
    @Scheduled(cron = "${agentx.context-loader.refresh-poller.cron:0 0 * * * *}")
    public void pollAndRefresh() {
        List<ContextSourceDaoRow> due = jdbi.onDemand(ContextSourceDao.class)
            .findDueForRefresh(dailySeconds, weeklySeconds);

        if (due.isEmpty()) {
            log.debug("RefreshPoller tick: nothing due");
            return;
        }
        log.info("RefreshPoller tick: {} source(s) due for refresh", due.size());

        for (ContextSourceDaoRow row : due) {
            try {
                contextService.triggerIngestion(row.orgId(), row.id())
                    .ifPresent(job -> log.info("RefreshPoller queued ingestion for {}/{} → job {}",
                        row.orgId(), row.id(), job.id()));
            } catch (RuntimeException e) {
                log.warn("RefreshPoller failed to trigger {}/{}: {}",
                    row.orgId(), row.id(), e.getMessage());
            }
        }
    }
}
