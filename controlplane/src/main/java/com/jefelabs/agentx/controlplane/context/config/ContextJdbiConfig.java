package com.jefelabs.agentx.controlplane.context.config;

import com.jefelabs.agentx.controlplane.context.domain.IngestionStatus;
import com.jefelabs.agentx.controlplane.context.domain.RefreshSchedule;
import com.jefelabs.agentx.controlplane.context.domain.SourceKind;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/** Context module's JDBI registrations: column mappers + argument factories for the three enums. */
@Configuration
public class ContextJdbiConfig {

    private final Jdbi jdbi;

    public ContextJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerContextTypes() {
        registerEnum(SourceKind.class, SourceKind::fromDbValue, SourceKind::dbValue);
        registerEnum(RefreshSchedule.class, RefreshSchedule::fromDbValue, RefreshSchedule::dbValue);
        registerEnum(IngestionStatus.class, IngestionStatus::fromDbValue, IngestionStatus::dbValue);
    }

    private <E extends Enum<E>> void registerEnum(
        Class<E> type,
        java.util.function.Function<String, E> fromDb,
        java.util.function.Function<E, String> toDb
    ) {
        jdbi.registerColumnMapper(type, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? fromDb.apply(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<E>(Types.VARCHAR) {
            @Override
            protected Argument build(E value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? toDb.apply(value) : null);
            }
        });
    }
}
