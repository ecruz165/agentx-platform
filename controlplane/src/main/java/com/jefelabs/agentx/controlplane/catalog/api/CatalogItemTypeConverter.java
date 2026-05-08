package com.jefelabs.agentx.controlplane.catalog.api;

import com.jefelabs.agentx.controlplane.catalog.domain.CatalogItemType;
import org.springframework.core.convert.converter.Converter;
import org.springframework.stereotype.Component;

/**
 * Lowercase-friendly @PathVariable / @RequestParam binding for
 * {@link CatalogItemType}. Spring's default Enum converter calls
 * {@code Enum.valueOf(SKILL)} which expects the uppercase Java name;
 * our wire format is lowercase ({@code skill}, {@code workflow}, …).
 * Register a {@link Converter} so {@code ?type=skill} and
 * {@code /skill/...} bind correctly.
 */
@Component
public class CatalogItemTypeConverter implements Converter<String, CatalogItemType> {
    @Override
    public CatalogItemType convert(String source) {
        return CatalogItemType.fromDbValue(source);
    }
}
