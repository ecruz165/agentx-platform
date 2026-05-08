package com.jefelabs.agentx.controlplane.intent.sse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * In-memory pub/sub for SSE subscribers per intake session. Phase 5.4
 * targets a single-instance deployment; multi-instance routing (sticky
 * load balancing or a Redis-backed broker) lands at Phase 7.
 *
 * <p>Each {@code register} returns an emitter that the controller hands
 * to Spring's SSE machinery. Lifecycle handlers (completion, timeout,
 * error) deregister automatically — callers don't manage cleanup.
 *
 * <p>{@code publish} fans out to all subscribers for the session id;
 * a per-subscriber send failure removes that subscriber but doesn't
 * stop the rest of the broadcast.
 */
@Component
public class IntentSessionEventBus {

    private static final Logger log = LoggerFactory.getLogger(IntentSessionEventBus.class);
    private static final long SSE_TIMEOUT_MS = 30 * 60 * 1000L;  // 30 min

    private final ConcurrentHashMap<UUID, List<SseEmitter>> subscribers = new ConcurrentHashMap<>();

    public SseEmitter register(UUID sessionId) {
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        subscribers.computeIfAbsent(sessionId, k -> new CopyOnWriteArrayList<>()).add(emitter);

        Runnable cleanup = () -> {
            List<SseEmitter> list = subscribers.get(sessionId);
            if (list != null) {
                list.remove(emitter);
                if (list.isEmpty()) subscribers.remove(sessionId, list);
            }
        };
        emitter.onCompletion(cleanup);
        emitter.onTimeout(cleanup);
        emitter.onError(t -> cleanup.run());

        log.debug("SSE subscriber registered for session {} (total now {})",
            sessionId, subscribers.getOrDefault(sessionId, List.of()).size());
        return emitter;
    }

    public void publish(SessionEvent event) {
        List<SseEmitter> list = subscribers.get(event.sessionId());
        if (list == null || list.isEmpty()) {
            log.debug("No SSE subscribers for session {} ({})", event.sessionId(), event.kind());
            return;
        }
        for (SseEmitter emitter : list) {
            try {
                emitter.send(SseEmitter.event()
                    .name(event.kind())
                    .data(event));
            } catch (IOException | IllegalStateException e) {
                log.debug("Removing failed SSE subscriber for session {}: {}",
                    event.sessionId(), e.getMessage());
                list.remove(emitter);
                emitter.completeWithError(e);
            }
        }
    }
}
