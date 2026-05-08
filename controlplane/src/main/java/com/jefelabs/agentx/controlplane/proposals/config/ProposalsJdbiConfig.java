package com.jefelabs.agentx.controlplane.proposals.config;

import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import jakarta.annotation.PostConstruct;
import org.jdbi.v3.core.Jdbi;
import org.jdbi.v3.core.argument.AbstractArgumentFactory;
import org.jdbi.v3.core.argument.Argument;
import org.jdbi.v3.core.config.ConfigRegistry;
import org.springframework.context.annotation.Configuration;

import java.sql.Types;

/**
 * JDBI registrations for the proposals module — column mapper +
 * argument factory for {@link ProposalStatus}. Per-enum explicit
 * registration matches the catalog/intent/job pattern.
 */
@Configuration
public class ProposalsJdbiConfig {

    private final Jdbi jdbi;

    public ProposalsJdbiConfig(Jdbi jdbi) {
        this.jdbi = jdbi;
    }

    @PostConstruct
    void registerProposalsTypes() {
        jdbi.registerColumnMapper(ProposalStatus.class, (rs, columnNumber, ctx) -> {
            String value = rs.getString(columnNumber);
            return value != null ? ProposalStatus.fromDbValue(value) : null;
        });
        jdbi.registerArgument(new AbstractArgumentFactory<ProposalStatus>(Types.VARCHAR) {
            @Override
            protected Argument build(ProposalStatus value, ConfigRegistry config) {
                return (position, statement, context) ->
                    statement.setString(position, value != null ? value.dbValue() : null);
            }
        });
    }
}
