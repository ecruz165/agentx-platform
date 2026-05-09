package com.jefelabs.agentx.controlplane.proposals.integration;

import com.jefelabs.agentx.controlplane.proposals.persistence.SkillProposalDao;
import com.jefelabs.agentx.controlplane.proposals.persistence.SkillProposalDaoRow;
import com.jefelabs.agentx.controlplane.proposals.service.SkillProposalService;
import org.jdbi.v3.core.Jdbi;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * Periodic re-fetch of skillzkit contribution status. Walks
 * {@code skill_proposals} rows whose {@code remote_status} is in flight
 * ({@code 'pending'} or {@code 'reviewing'}) and asks skillzkit for the
 * current state.
 *
 * <p>The actual refresh logic — including dropping the local
 * catalog_items draft on terminal-accepted — lives on
 * {@link SkillProposalService#refreshRemoteStatus}. This class is just
 * the scheduling shell: one cron tick = one fan-out over the in-flight
 * batch, with each row's exception isolated so a single bad row
 * doesn't kill the whole tick.
 *
 * <p>Disable via {@code agentx.skillzkit.poller.enabled=false} (tests,
 * profiles without skillzkit reachable). When enabled but the client
 * itself is unconfigured ({@code agentx.skillzkit.url} is empty),
 * {@link #poll} early-returns — there's nothing to fetch and no
 * harm in skipping.
 */
@Component
@ConditionalOnProperty(
    name = "agentx.skillzkit.poller.enabled",
    havingValue = "true",
    matchIfMissing = true
)
public class SkillzkitStatusPoller {

    private static final Logger log = LoggerFactory.getLogger(SkillzkitStatusPoller.class);

    /**
     * Cap the per-tick batch so a backlog of 10k in-flight proposals
     * (catastrophic skillzkit outage during a heavy approval period)
     * doesn't translate into 10k synchronous HTTP calls in one tick.
     * The DAO sorts by {@code remote_synced_at ASC NULLS FIRST}, so
     * stalest rows get refreshed first and the next tick picks up
     * where this one left off.
     */
    private static final int BATCH_LIMIT = 50;

    private final Jdbi jdbi;
    private final SkillzkitClient client;
    private final SkillProposalService service;

    public SkillzkitStatusPoller(
        Jdbi jdbi,
        SkillzkitClient client,
        SkillProposalService service
    ) {
        this.jdbi = jdbi;
        this.client = client;
        this.service = service;
        log.info("SkillzkitStatusPoller initialized; clientConfigured={}", client.isConfigured());
    }

    /**
     * Default poll interval is 60s — fast enough to reflect skillzkit
     * decisions in the admin UI without user friction; slow enough
     * that an idle controlplane doesn't hammer skillzkit. Tunable via
     * {@code agentx.skillzkit.poller.fixed-delay-ms}.
     *
     * <p>Uses {@code fixedDelay} (not {@code fixedRate}) so a slow
     * skillzkit response can't queue a second tick on top of an
     * already-running one — each tick starts after the previous
     * completes.
     */
    @Scheduled(fixedDelayString = "${agentx.skillzkit.poller.fixed-delay-ms:60000}")
    public void poll() {
        if (!client.isConfigured()) return;

        List<SkillProposalDaoRow> inFlight = jdbi.onDemand(SkillProposalDao.class)
            .listRemoteInFlight(BATCH_LIMIT);
        if (inFlight.isEmpty()) {
            return;
        }

        log.debug("Polling {} in-flight skill proposal(s)", inFlight.size());
        int updated = 0;
        int failed = 0;
        for (SkillProposalDaoRow row : inFlight) {
            try {
                if (service.refreshRemoteStatus(row.orgId(), row.id(), row.remoteId())) {
                    updated++;
                }
            } catch (RuntimeException e) {
                // Per-row isolation: one transactional refresh call can
                // fail (HTTP exception, broken JSON, lock timeout) without
                // taking down the rest of the batch. Log + continue.
                failed++;
                log.warn("refreshRemoteStatus failed for proposal id={} remoteId={}: {}",
                    row.id(), row.remoteId(), e.getMessage());
            }
        }
        if (updated > 0 || failed > 0) {
            log.info("SkillzkitStatusPoller tick: scanned={} updated={} failed={}",
                inFlight.size(), updated, failed);
        }
    }
}
