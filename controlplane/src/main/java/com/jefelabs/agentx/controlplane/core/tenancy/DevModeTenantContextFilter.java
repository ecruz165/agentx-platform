package com.jefelabs.agentx.controlplane.core.tenancy;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Optional;

/**
 * Phase 0 stand-in: populates {@link TenantContext} from request headers
 * ({@code X-Org-Id}, {@code X-User-Id}) for local development. Defaults applied
 * when headers are missing so curl-style smoke tests work without ceremony.
 *
 * <p>At Phase 7 this filter is replaced by an OAuth2-driven populator that reads
 * the same {@code TenantContext} fields from the {@code Authentication} principal.
 * Domain-module code reading {@link TenantContext#current()} is unchanged across
 * phases — only the populator swaps. Marked {@link ConditionalOnMissingBean} so
 * the Phase 7 replacement displaces this without requiring profile flags.
 */
@Component
@ConditionalOnMissingBean(name = "tenantContextPopulatorFilter")
public class DevModeTenantContextFilter extends OncePerRequestFilter {

    private static final String ORG_ID_HEADER = "X-Org-Id";
    private static final String USER_ID_HEADER = "X-User-Id";
    private static final String DEV_DEFAULT_ORG = "dev-org";
    private static final String DEV_DEFAULT_USER = "dev-user";

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse resp, FilterChain chain)
        throws ServletException, IOException {

        String orgId = Optional.ofNullable(req.getHeader(ORG_ID_HEADER)).orElse(DEV_DEFAULT_ORG);
        String userId = Optional.ofNullable(req.getHeader(USER_ID_HEADER)).orElse(DEV_DEFAULT_USER);

        TenantContext.set(new TenantContext(orgId, userId));
        try {
            chain.doFilter(req, resp);
        } finally {
            TenantContext.clear();
        }
    }
}
