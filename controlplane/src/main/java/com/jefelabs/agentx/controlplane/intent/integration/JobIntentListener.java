package com.jefelabs.agentx.controlplane.intent.integration;

import com.jefelabs.agentx.controlplane.core.events.JobIntentProducedEvent;
import com.jefelabs.agentx.controlplane.core.events.PipelineSpecProducedEvent;
import com.jefelabs.agentx.controlplane.intent.service.IntentService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * Phase 5.5 listener for cross-module events from the Job module.
 *
 * <p>{@link JobIntentProducedEvent} fires when a {@code job-definition}
 * pipeline completes; we look up the session whose intake_job_id matches
 * and transition it to {@code intent-ready}.
 *
 * <p>{@link PipelineSpecProducedEvent} (Phase 5.6 forward-compat) fires
 * when an architect sub-pipeline produces a proposed PipelineDef. The
 * listener flags the session as {@code pipeline-creation-required}; the
 * Web UI surfaces the proposal for approval. Has no producer until the
 * {@code call} step kind lands; included now so the listener contract is
 * stable when it does.
 *
 * <p>Uses plain {@code @EventListener} (synchronous, no transaction
 * required) rather than {@code @ApplicationModuleListener} because
 * {@code JobEngine.runJob} is intentionally non-transactional (parallel
 * virtual-thread Fork/Map branches don't share a tx). The transactional
 * variant silently drops events when there's no surrounding tx;
 * synchronous in-process delivery is the right contract here. Durability
 * is acceptable to lose for v1 since session reconciliation is recoverable
 * (a poller could re-scan for completed intake jobs whose sessions are
 * still {@code awaiting-message} on restart).
 */
@Component
public class JobIntentListener {

    private static final Logger log = LoggerFactory.getLogger(JobIntentListener.class);

    private final IntentService intentService;

    public JobIntentListener(IntentService intentService) {
        this.intentService = intentService;
    }

    @EventListener
    void onJobIntentProduced(JobIntentProducedEvent event) {
        log.info("Received JobIntentProducedEvent: org={} jobId={} flowId={}",
            event.orgId(), event.jobId(), event.flowId());
        intentService.markIntentReady(event.orgId(), event.jobId(), event.intent());
    }

    @EventListener
    void onPipelineSpecProduced(PipelineSpecProducedEvent event) {
        log.info("Received PipelineSpecProducedEvent: org={} parentJobId={} architectJobId={}",
            event.orgId(), event.parentJobId(), event.architectJobId());
        intentService.markPipelineCreationRequired(
            event.orgId(), event.parentJobId(), event.pipelineSpec()
        );
    }
}
