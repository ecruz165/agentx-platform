package com.jefelabs.agentx.controlplane.catalog.api.mapper;

import com.jefelabs.agentx.controlplane.catalog.api.dto.FlowCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.FlowDTO;
import com.jefelabs.agentx.controlplane.catalog.domain.Flow;
import com.jefelabs.agentx.controlplane.catalog.domain.FlowKind;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.Named;
import org.mapstruct.ReportingPolicy;

/**
 * MapStruct DTO ↔ domain mapper for the catalog module's flows. The
 * {@code componentModel = "spring"} setting registers the generated
 * implementation as a Spring bean ({@code @Component}) so controllers
 * inject it via constructor injection.
 *
 * <p>Per the layering convention ({@code feedback_controller_service_layering.md}):
 * controllers convert DTO → domain via this mapper *before* calling services;
 * never the other way around.
 */
@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface FlowMapper {

    /**
     * Convert a creation request to a domain {@link Flow}, injecting
     * {@code orgId} from the request context. Audit fields ({@code createdAt},
     * {@code createdBy}, etc.) are populated by the database/service layer.
     *
     * @param dto the wire-format creation request
     * @param orgId the tenant scope (from {@code TenantContext.current().orgId()})
     */
    @Mapping(target = "orgId", source = "orgId")
    @Mapping(target = "kind", source = "dto.kind", qualifiedByName = "kindOrDefault")
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "createdBy", ignore = true)
    @Mapping(target = "updatedBy", ignore = true)
    Flow toDomain(FlowCreateRequestDTO dto, String orgId);

    /** Convert a domain {@link Flow} to its wire-format response. */
    FlowDTO toDTO(Flow domain);

    @Named("kindOrDefault")
    static FlowKind kindOrDefault(FlowKind kind) {
        return kind != null ? kind : FlowKind.WORK;
    }
}
