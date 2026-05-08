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

/**
 * Context module's JDBI registrations: column mappers + argument factories
 * for the three enums. Per-enum explicit registration (rather than a
 * generic helper) — JDBI's argument-factory machinery resolves the
 * factory's parameterized supertype reflectively, which fails on
 * method-level type variables.
 */
@Configuration
public class ContextJdbiConfig {

    private final Jdbi jdbi;

    public ContextJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerContextTypes() {
        // SourceKind <-> text
        jdbi.registerColumnMapper(SourceKind.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? SourceKind.fromDbValue(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<SourceKind>(Types.VARCHAR) {
            @Override
            protected Argument build(SourceKind value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });

        // RefreshSchedule <-> text
        jdbi.registerColumnMapper(RefreshSchedule.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? RefreshSchedule.fromDbValue(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<RefreshSchedule>(Types.VARCHAR) {
            @Override
            protected Argument build(RefreshSchedule value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });

        // IngestionStatus <-> text
        jdbi.registerColumnMapper(IngestionStatus.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? IngestionStatus.fromDbValue(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<IngestionStatus>(Types.VARCHAR) {
            @Override
            protected Argument build(IngestionStatus value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
