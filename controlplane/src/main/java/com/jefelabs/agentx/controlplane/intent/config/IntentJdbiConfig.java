package com.jefelabs.agentx.controlplane.intent.config;

import com.jefelabs.agentx.controlplane.intent.domain.SessionStatus;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/**
 * Intent module's JDBI registrations: column mapper + argument factory
 * for {@link SessionStatus}. Per-enum explicit registration mirrors the
 * pattern used by Catalog/Context/Harness/Job (a generic helper trips
 * JDBI's reflective type resolution on method-level type variables).
 */
@Configuration
public class IntentJdbiConfig {

    private final Jdbi jdbi;

    public IntentJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerIntentTypes() {
        jdbi.registerColumnMapper(SessionStatus.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? SessionStatus.fromDbValue(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<SessionStatus>(Types.VARCHAR) {
            @Override
            protected Argument build(SessionStatus value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
