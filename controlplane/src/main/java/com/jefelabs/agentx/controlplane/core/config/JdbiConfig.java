package com.jefelabs.agentx.controlplane.core.config;

import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.jackson2.Jackson2Plugin;
import org.jdbi.v3.postgres.PostgresPlugin;
import org.jdbi.v3.spring.SpringConnectionFactory;
import org.jdbi.v3.sqlobject.SqlObjectPlugin;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.TransactionAwareDataSourceProxy;

import javax.sql.DataSource;

/**
 * Wires JDBI v3 against the application {@link DataSource} (embedded Postgres for local
 * dev, external for production — see {@link EmbeddedPostgresConfig}).
 *
 * <p>Plugins installed:
 * <ul>
 *   <li>{@code SqlObjectPlugin} — enables annotation-driven DAOs ({@code @SqlQuery},
 *       {@code @SqlUpdate}, {@code @SqlBatch}).</li>
 *   <li>{@code PostgresPlugin} — Postgres-specific type bindings (UUID, JSONB, INET,
 *       arrays, hstore). Required for our Postgres-only deployment target.</li>
 *   <li>{@code Jackson2Plugin} — JSON/JSONB column ↔ Java object conversion via Jackson
 *       (per {@code feedback_jdbi_for_dao.md} note on Jackson conversion). Use
 *       {@code @Json} on bind parameters or column-mapped fields to invoke it.</li>
 * </ul>
 *
 * <p>The {@link TransactionAwareDataSourceProxy} wrapping ensures JDBI participates in
 * Spring-managed transactions — methods annotated {@code @Transactional} on services
 * still control DAO call boundaries.
 *
 * <p>DAOs are obtained via {@code Jdbi.onDemand(DaoInterface.class)} — typically
 * exposed as Spring beans by per-module {@code @Configuration} classes within each
 * domain module. {@code core} does not expose any DAOs itself.
 */
@Configuration
public class JdbiConfig {

    @Bean
    public Jdbi jdbi(DataSource dataSource) {
        DataSource txAware = new TransactionAwareDataSourceProxy(dataSource);
        return Jdbi.create(new SpringConnectionFactory(txAware))
            .installPlugin(new SqlObjectPlugin())
            .installPlugin(new PostgresPlugin())
            .installPlugin(new Jackson2Plugin());
    }
}
