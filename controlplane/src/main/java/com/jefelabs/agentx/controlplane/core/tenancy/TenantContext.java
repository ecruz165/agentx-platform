package com.jefelabs.agentx.controlplane.core.tenancy;

/**
 * Request-scoped tenant identity. Populated by a filter (dev-mode in Phase 0,
 * OAuth-driven in Phase 7) and read by every domain module via {@link #current()}.
 *
 * <p>Held in a {@link ThreadLocal}. With Java 21 virtual threads each request runs on
 * its own virtual thread; the thread-local lives for that thread's lifetime and is
 * cleared by the filter's finally block.
 */
public record TenantContext(String orgId, String userId) {

    private static final ThreadLocal<TenantContext> CURRENT = new ThreadLocal<>();

    /** Returns the active tenant context. Never null when invoked from request-scoped code. */
    public static TenantContext current() {
        TenantContext ctx = CURRENT.get();
        if (ctx == null) {
            throw new IllegalStateException(
                "TenantContext not set — the request did not pass through the populator filter. "
                + "Phase 0 expects DevModeTenantContextFilter; Phase 7 swaps in the OAuth-driven populator."
            );
        }
        return ctx;
    }

    static void set(TenantContext ctx) {
        CURRENT.set(ctx);
    }

    static void clear() {
        CURRENT.remove();
    }
}
