package com.jefelabs.agentx.controlplane.catalog.sse;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * In-memory pub/sub for catalog change events. Same shape as
 * IntentSessionEventBus — single global subscriber list, auto-cleanup
 * on emitter completion / timeout / error. v1 fans out to all
 * subscribers regardless of org; the receiver is responsible for
 * re-fetching its own org's catalog so cross-org leakage is moot at
 * the data layer (just slightly wasteful refetches).
 *
 * <p>Listens to Spring's ApplicationEventPublisher via
 * {@link EventListener} so services don't need to know about this
 * class — they just publish a {@link CatalogChangedEvent} and the bus
 * picks it up.
 */
@Component
public class CatalogEventBus {

    private static final Logger log = LoggerFactory.getLogger(CatalogEventBus.class);
    private static final long SSE_TIMEOUT_MS = 30 * 60 * 1000L;  // 30 min

    private final List<SseEmitter> subscribers = new CopyOnWriteArrayList<>();

    public SseEmitter register() {
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        subscribers.add(emitter);

        Runnable cleanup = () -> subscribers.remove(emitter);
        emitter.onCompletion(cleanup);
        emitter.onTimeout(cleanup);
        emitter.onError(t -> cleanup.run());

        log.debug("CatalogEventBus: subscriber registered (total now {})", subscribers.size());
        return emitter;
    }

    @EventListener
    public void onCatalogChanged(CatalogChangedEvent event) {
        if (subscribers.isEmpty()) {
            log.debug("CatalogEventBus: no subscribers, drop event {}", event);
            return;
        }
        for (SseEmitter emitter : subscribers) {
            try {
                emitter.send(SseEmitter.event()
                    .name("catalog-changed")
                    .data(event));
            } catch (IOException | IllegalStateException e) {
                log.debug("CatalogEventBus: removing failed subscriber: {}", e.getMessage());
                subscribers.remove(emitter);
                emitter.completeWithError(e);
            }
        }
        log.debug("CatalogEventBus: dispatched {} to {} subscriber(s)", event, subscribers.size());
    }
}
