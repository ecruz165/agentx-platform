package com.jefelabs.agentx.controlplane.core.web;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * Forwards client-side router paths to the SPA's bundled
 * {@code /index.html} so React Router can handle the route.
 *
 * <p>The Phase 6 UI is bundled into Spring's static resources at
 * image-build time (per controlplane/Dockerfile). Spring serves
 * {@code index.html} + {@code /assets/...} automatically, but a fresh
 * navigation to e.g. {@code /intake/abc-123} 404s without an explicit
 * forward, because Spring's dispatcher looks for a controller mapping
 * matching {@code /intake/abc-123} and finds none.
 *
 * <p>The patterns below cover the SPA's known route prefixes
 * ({@code /}, {@code /intake}, {@code /sessions}, {@code /jobs},
 * {@code /catalog}). They run AFTER {@code @RestController} mappings
 * (Spring's path-matching priority), so {@code /api/...} routes still
 * reach their handlers normally. They run AFTER the static resource
 * handler too, so {@code /assets/foo.js} still resolves to the bundled
 * file, not the forward.
 *
 * <p>Adding a new top-level SPA route? Add it here.
 */
@Configuration
public class SpaForwardConfig implements WebMvcConfigurer {

    @Override
    public void addViewControllers(ViewControllerRegistry registry) {
        registry.addViewController("/").setViewName("forward:/index.html");
        registry.addViewController("/intake").setViewName("forward:/index.html");
        registry.addViewController("/intake/{sessionId}").setViewName("forward:/index.html");
        registry.addViewController("/sessions").setViewName("forward:/index.html");
        registry.addViewController("/jobs").setViewName("forward:/index.html");
        registry.addViewController("/catalog").setViewName("forward:/index.html");
        registry.addViewController("/benchmarks").setViewName("forward:/index.html");
    }
}
