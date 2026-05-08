package com.jefelabs.agentx.controlplane.harness.config;

import com.jefelabs.agentx.controlplane.harness.domain.HarnessStatus;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/**
 * Harness module's JDBI registrations: column mapper + argument factory
 * for {@link HarnessStatus}. Same pattern as catalog's
 * {@code CatalogJdbiConfig}.
 */
@Configuration
public class HarnessJdbiConfig {

    private final Jdbi jdbi;

    public HarnessJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerHarnessTypes() {
        jdbi.registerColumnMapper(HarnessStatus.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? HarnessStatus.fromDbValue(value) : null;
        });

        jdbi.registerArgument(new AbstractArgumentFactory<HarnessStatus>(Types.VARCHAR) {
            @Override
            protected Argument build(HarnessStatus value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
