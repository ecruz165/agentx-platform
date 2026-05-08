package com.jefelabs.agentx.controlplane;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;
import org.springframework.modulith.docs.Documenter;

/**
 * Phase 0 acceptance test: validates the Spring Modulith module structure of the
 * control plane. No Spring context is started; this is pure compile-time analysis
 * of the package graph + {@code @ApplicationModule} annotations.
 *
 * <p>Failing this test means a domain module imported another module's internal
 * package, or a cyclic dependency exists, or {@code package-info.java} annotations
 * are misconfigured. All of these fail the build before Spring even tries to wire.
 */
class ModulithVerificationTest {

    /**
     * The acceptance gate. Verifies that:
     *  - All seven expected modules are detected (core, catalog, context, intent, job, harness, dispatch)
     *  - No closed module imports another closed module's internal package
     *  - No cyclic dependencies between modules
     *  - {@code core} is correctly marked OPEN
     */
    @Test
    void verifiesModuleStructure() {
        ApplicationModules modules = ApplicationModules.of(ControlplaneApplication.class);
        modules.verify();
    }

    /**
     * Generates module documentation (PlantUML diagrams + Asciidoc) under
     * {@code target/spring-modulith-docs/}. Useful as a build artifact for the
     * umbrella PRD's architecture section.
     */
    @Test
    void writesModuleDocumentation() {
        ApplicationModules modules = ApplicationModules.of(ControlplaneApplication.class);
        new Documenter(modules)
            .writeDocumentation()
            .writeIndividualModulesAsPlantUml();
    }
}
