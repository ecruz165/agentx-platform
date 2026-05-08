package com.jefelabs.agentx.controlplane.intent.api.mapper;

import com.jefelabs.agentx.controlplane.intent.api.dto.IntentSessionDTO;
import com.jefelabs.agentx.controlplane.intent.domain.IntentSession;
import org.mapstruct.Mapper;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface IntentSessionMapper {

    IntentSessionDTO toDTO(IntentSession domain);
}
