package com.jefelabs.agentx.controlplane.harness.api.mapper;

import com.jefelabs.agentx.controlplane.harness.api.dto.HarnessDTO;
import com.jefelabs.agentx.controlplane.harness.domain.Harness;
import org.mapstruct.Mapper;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface HarnessMapper {

    HarnessDTO toDTO(Harness domain);
}
