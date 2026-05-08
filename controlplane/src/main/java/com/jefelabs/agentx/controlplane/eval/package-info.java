/**
 * Eval module — test-suite fixtures + benchmark-run orchestration.
 *
 * <p>Closed module. Depends on {@code job} (via {@code JobService.submit}
 * — exposed at {@code job.service} via @NamedInterface) for the actual
 * submission of fixture-derived jobs.
 *
 * <p>Slice 3 of the eval-harness work — slices 1+2 ship the per-job
 * benchmark tagging + compare endpoint; this slice adds the suite
 * surface so a single API call submits N jobs from a stored fixture.
 */
@org.springframework.modulith.ApplicationModule(
    displayName = "Eval"
)
package com.jefelabs.agentx.controlplane.eval;
