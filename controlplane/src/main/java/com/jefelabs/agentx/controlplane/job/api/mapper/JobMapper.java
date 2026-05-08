package com.jefelabs.agentx.controlplane.job.api.mapper;

import com.jefelabs.agentx.controlplane.core.types.JobIntent;
import com.jefelabs.agentx.controlplane.job.api.dto.JobDTO;
import com.jefelabs.agentx.controlplane.job.api.dto.SubmitJobRequestDTO;
import com.jefelabs.agentx.controlplane.job.domain.Job;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface JobMapper {

    /** SubmitJobRequestDTO → JobIntent (the shared-kernel command shape). */
    @Mapping(target = "flowId",    source = "flowId")
    @Mapping(target = "productId", source = "productId")
    @Mapping(target = "input",     source = "input")
    @Mapping(target = "set",       source = "set")
    @Mapping(target = "config",    source = "config")
    JobIntent toIntent(SubmitJobRequestDTO dto);

    /** Job → JobDTO. {@code setName} domain field renames to {@code set} on the wire. */
    @Mapping(target = "set", source = "setName")
    JobDTO toDTO(Job domain);
}
