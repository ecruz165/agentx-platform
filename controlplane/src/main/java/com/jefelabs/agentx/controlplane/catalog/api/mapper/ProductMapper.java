package com.jefelabs.agentx.controlplane.catalog.api.mapper;

import com.jefelabs.agentx.controlplane.catalog.api.dto.ProductCreateRequestDTO;
import com.jefelabs.agentx.controlplane.catalog.api.dto.ProductDTO;
import com.jefelabs.agentx.controlplane.catalog.domain.Product;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.ReportingPolicy;

@Mapper(componentModel = "spring", unmappedTargetPolicy = ReportingPolicy.IGNORE)
public interface ProductMapper {

    @Mapping(target = "orgId", source = "orgId")
    @Mapping(target = "createdAt", ignore = true)
    @Mapping(target = "updatedAt", ignore = true)
    @Mapping(target = "createdBy", ignore = true)
    @Mapping(target = "updatedBy", ignore = true)
    Product toDomain(ProductCreateRequestDTO dto, String orgId);

    ProductDTO toDTO(Product domain);
}
