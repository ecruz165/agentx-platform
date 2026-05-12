import { heroui } from "@heroui/react";

// HeroUI v3 Tailwind plugin entry point for the AgentX design system.
// In v3 the visual tokens live in `theme.css` (`@theme` block) — this
// plugin just wires HeroUI's component layer into Tailwind. Consumers
// pull it in from their stylesheet via `@plugin "@ecruz165/design-system/hero";`
// (or re-export and reference locally, as controlplane-ui does today).
export default heroui();
