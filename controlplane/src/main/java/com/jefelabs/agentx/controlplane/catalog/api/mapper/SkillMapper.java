package com.jefelabs.agentx.controlplane.catalog.api.mapper;

import com.jefelabs.agentx.controlplane.catalog.api.dto.SkillCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.SkillDTO;
import com.jefelabs.agentx.controlplane.catalog.domain.Skill;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface SkillMapper {

    @Mapping(target = "orgId", source = "orgId")
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "createdBy", ignore = true)
    @Mapping(target = "updatedBy", ignore = true)
    Skill toDomain(SkillCreateRequestDTO dto, String orgId);

    SkillDTO toDTO(Skill domain);
}
