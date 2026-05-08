package com.jefelabs.agentx.controlplane.core.config;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;
import java.io.IOException;

/**
 * Local-dev embedded Postgres. Zonky downloads + spawns a real Postgres binary
 * (currently 17.5) as a JVM child process and exposes it as a {@link DataSource}.
 *
 * <p><b>Auto-config priority (Spring Boot resolves in this order):</b>
 * <ol>
 *   <li>Explicit {@code spring.datasource.url} (env var or {@code application.yml})
 *       → external Postgres wins. Embedded skipped.</li>
 *   <li>{@code spring-boot-docker-compose} detects a {@code postgres} service in
 *       {@code compose.yaml} → injects datasource properties. Embedded skipped.</li>
 *   <li>Neither of the above → this {@code @Bean} fires, embedded Postgres spawns.</li>
 * </ol>
 *
 * <p>The {@link ConditionalOnMissingBean} guard makes this bean lose to any
 * upstream {@code DataSource} bean, which is exactly the behavior we want.
 *
 * <p><b>Disabling embedded explicitly:</b> set
 * {@code agentx.embedded-postgres.enabled=false} (e.g., in production).
 */
@Configuration
@ConditionalOnProperty(name = "agentx.embedded-postgres.enabled", havingValue = "true", matchIfMissing = true)
public class EmbeddedPostgresConfig {

    private static final Logger log = LoggerFactory.getLogger(EmbeddedPostgresConfig.class);

    private EmbeddedPostgres embeddedPostgres;

    /**
     * Spawns the embedded Postgres process and returns its pooled DataSource.
     * Loses to any other {@code DataSource} bean via {@link ConditionalOnMissingBean}.
     */
    @Bean
    @ConditionalOnMissingBean(DataSource.class)
    public DataSource embeddedPostgresDataSource() throws IOException {
        log.info("Starting embedded Postgres (zonky) — first run extracts the native binary; subsequent runs use the cached copy");
        embeddedPostgres = EmbeddedPostgres.builder().start();
        log.info("Embedded Postgres listening on port {}", embeddedPostgres.getPort());
        return embeddedPostgres.getPostgresDatabase();
    }

    @PreDestroy
    public void shutdown() throws IOException {
        if (embeddedPostgres != null) {
            log.info("Stopping embedded Postgres");
            embeddedPostgres.close();
        }
    }
}
