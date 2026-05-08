package com.jefelabs.agentx.controlplane.dispatch.policy;

import com.jefelabs.agentx.controlplane.dispatch.domain.StepContext;
import com.jefelabs.agentx.controlplane.harness.domain.Harness;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Round-robin policy: rotates through eligible harnesses with a per-org
 * counter. Simplest fair policy and the v1 default per
 * prd-dispatch-module.md D3.
 *
 * <p>State is in-memory (per process); when the dispatch module gains
 * multi-replica support (v2+), the counter moves into Postgres or a shared
 * cache. For v1 single-node it's fine.
 */
@Component
public class RoundRobinPolicy implements RoutingPolicy {

    private final Map<String, AtomicLong> counters = new ConcurrentHashMap<>();

    @Override
    public String name() {
        return "round-robin";
    }

    @Override
    public Optional<Harness> select(List<Harness> eligible, StepContext context) {
        if (eligible.isEmpty()) return Optional.empty();
        AtomicLong counter = counters.computeIfAbsent(context.orgId(), k -> new AtomicLong());
        long index = Math.floorMod(counter.getAndIncrement(), eligible.size());
        return Optional.of(eligible.get((int) index));
    }
}
