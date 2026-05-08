package com.jefelabs.agentx.controlplane.job.config;

import com.jefelabs.agentx.controlplane.job.domain.JobStatus;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/**
 * Job module's JDBI registrations: column mapper + argument factory for
 * {@link JobStatus}. Same pattern as {@code CatalogJdbiConfig} +
 * {@code HarnessJdbiConfig}. Phase 3b will add {@code StepStatus} when
 * the {@code job_steps} DAO lands.
 */
@Configuration
public class JobJdbiConfig {

    private final Jdbi jdbi;

    public JobJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerJobTypes() {
        jdbi.registerColumnMapper(JobStatus.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? JobStatus.fromDbValue(value) : null;
        });

        jdbi.registerArgument(new AbstractArgumentFactory<JobStatus>(Types.VARCHAR) {
            @Override
            protected Argument build(JobStatus value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
