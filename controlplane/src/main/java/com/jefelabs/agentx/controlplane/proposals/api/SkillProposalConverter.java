package com.jefelabs.agentx.controlplane.proposals.api;

import com.jefelabs.agentx.controlplane.proposals.domain.ProposalStatus;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/**
 * Lowercase-friendly @RequestParam binding for {@link ProposalStatus}.
 * Mirrors CatalogItemTypeConverter — Spring's default Enum.valueOf
 * wants UPPERCASE; our wire format is lowercase ('proposed', etc.).
 */
@Component
public class SkillProposalConverter implements Converter<String, ProposalStatus> {
    @Override
    public ProposalStatus convert(String source) {
        return ProposalStatus.fromDbValue(source);
    }
}
