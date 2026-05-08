package com.jefelabs.agentx.controlplane.job.api;

import com.jefelabs.agentx.controlplane.core.tenancy.TenantContext;
import com.jefelabs.agentx.controlplane.job.api.dto.JobDTO;
import com.jefelabs.agentx.controlplane.job.api.dto.SubmitJobRequestDTO;
import com.jefelabs.agentx.controlplane.job.api.mapper.JobMapper;
import com.jefelabs.agentx.controlplane.job.engine.JobEngine;
import com.jefelabs.agentx.controlplane.job.service.JobService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;

/**
 * Thin HTTP edge for jobs. Phase 3a: submit / get / list / cancel.
 * Step events SSE stream + per-step queries arrive with the engine in 3b.
 */
@RestController
@RequestMapping("/api/jobs")
public class JobController {

    private final JobService jobService;
    private final JobMapper jobMapper;
    private final JobEngine jobEngine;

    public JobController(JobService jobService, JobMapper jobMapper, JobEngine jobEngine) {
        this.jobService = jobService;
        this.jobMapper = jobMapper;
        this.jobEngine = jobEngine;
    }

    @PostMapping
    public ResponseEntity<JobDTO> submit(@RequestBody SubmitJobRequestDTO body) {
        var tenant = TenantContext.current();
        var intent = jobMapper.toIntent(body);
        var job = jobService.submit(tenant.orgId(), tenant.userId(), intent);
        return ResponseEntity.status(HttpStatus.CREATED).body(jobMapper.toDTO(job));
    }

    @GetMapping("/{id}")
    public ResponseEntity<JobDTO> getById(@PathVariable String id) {
        var tenant = TenantContext.current();
        return jobService.findById(tenant.orgId(), id)
            .map(jobMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    @GetMapping
    public List<JobDTO> list(
        @RequestParam(defaultValue = "50") int limit,
        @RequestParam(defaultValue = "0") int offset
    ) {
        var tenant = TenantContext.current();
        return jobService.listByOrg(tenant.orgId(), limit, offset).stream()
            .map(jobMapper::toDTO)
            .toList();
    }

    @PostMapping("/{id}/cancel")
    public ResponseEntity<JobDTO> cancel(@PathVariable String id) {
        var tenant = TenantContext.current();
        return jobService.cancel(tenant.orgId(), id)
            .map(jobMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }

    /**
     * Manual engine trigger. Phase 3b ships this as the only execution path
     * so testing is deterministic; Phase 3.x adds a {@code @Scheduled} poller
     * that picks up queued jobs automatically.
     */
    @PostMapping("/{id}/start")
    public ResponseEntity<JobDTO> start(@PathVariable String id) {
        var tenant = TenantContext.current();
        return jobService.findById(tenant.orgId(), id)
            .map(jobEngine::runJob)
            .map(jobMapper::toDTO)
            .map(ResponseEntity::ok)
            .orElseGet(() -> ResponseEntity.notFound().build());
    }
}
