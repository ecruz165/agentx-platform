package com.jefelabs.agentx.controlplane.catalog.api.mapper;

import com.jefelabs.agentx.controlplane.catalog.api.dto.AgentCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.AgentDTO;
import com.jefelabs.agentx.controlplane.catalog.domain.Agent;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;

/**
 * MapStruct DTO ↔ domain mapper for catalog agents. Spring-injected;
 * controller converts inbound DTO → domain via {@link #toDomain} before
 * calling the service, then back via {@link #toDTO} on response.
 */
@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface AgentMapper {

    @Mapping(target = "orgId", source = "orgId")
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "createdBy", ignore = true)
    @Mapping(target = "updatedBy", ignore = true)
    Agent toDomain(AgentCreateRequestDTO dto, String orgId);

    AgentDTO toDTO(Agent domain);
}
