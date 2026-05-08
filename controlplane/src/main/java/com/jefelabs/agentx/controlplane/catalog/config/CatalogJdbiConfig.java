package com.jefelabs.agentx.controlplane.catalog.config;

import com.jefelabs.agentx.controlplane.catalog.domain.AdapterId;
import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/**
 * Catalog module's JDBI registrations: type mappers + argument factories
 * for catalog-owned types ({@link FlowKind}) so they round-trip correctly
 * to Postgres' {@code text}-typed CHECK-constrained columns.
 *
 * <p>Lives in {@code catalog} (not {@code core}) per the open-module
 * principle: {@code core.config.JdbiConfig} produces the global {@link Jdbi}
 * bean, and each domain module augments it with module-specific types.
 * This way {@code core} doesn't need to know about catalog types.
 */
@Configuration
public class CatalogJdbiConfig {

    private final Jdbi jdbi;

    public CatalogJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerCatalogTypes() {
        // FlowKind <-> text column ('work' / 'job-definition' / 'post-job')
        jdbi.registerColumnMapper(FlowKind.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? FlowKind.fromDbValue(value) : null;
        });

        jdbi.registerArgument(new AbstractArgumentFactory<FlowKind>(Types.VARCHAR) {
            @Override
            protected Argument build(FlowKind value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });

        // AdapterId <-> text column ('claude-sdk' / 'opencode-cli')
        jdbi.registerColumnMapper(AdapterId.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? AdapterId.fromDbValue(value) : null;
        });

        jdbi.registerArgument(new AbstractArgumentFactory<AdapterId>(Types.VARCHAR) {
            @Override
            protected Argument build(AdapterId value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
