package com.jefelabs.agentx.controlplane.context.api.mapper;

import com.jefelabs.agentx.controlplane.context.api.dto.ContextSourceDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.IngestionJobDTO;
import com.jefelabs.agentx.controlplane.context.api.dto.RegisterSourceRequestDTO;
import com.jefelabs.agentx.controlplane.context.domain.ContextSource;
import com.jefelabs.agentx.controlplane.context.domain.IngestionJob;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface ContextSourceMapper {

    @Mapping(target = "orgId", source = "orgId")
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "createdBy", ignore = true)
    ContextSource toDomain(RegisterSourceRequestDTO dto, String orgId);

    ContextSourceDTO toDTO(ContextSource domain);

    IngestionJobDTO toDTO(IngestionJob domain);
}
