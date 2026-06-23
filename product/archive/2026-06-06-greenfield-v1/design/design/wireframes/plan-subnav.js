/**
 * @schema 2.13
 * @input active: enum("Discovery", "PRDs", "Roadmap", "Decompose", "Readiness", "Dependencies") = "Readiness"
 *
 * Plan-hat WORKSPACE secondary nav. The Plan hat is a workspace, not a single
 * screen: authoring areas (Discovery, PRDs, Roadmap, Decompose) sit alongside
 * the Readiness view and Dependencies. Rendered from one source so every
 * workspace screen stays in sync; set the focused area per screen via `active`.
 *
 * This is the SECOND nav level under the five-hat tab bar (tabbar.js). It reads
 * as a lighter, nested band: a tinted bar with a pill on the active area, vs the
 * hat bar's underline. Pencil scripts can't flex their own children, so the row
 * is one frame sized to the script node doing the layout.
 */
const ITEMS = [
  { label: "Discovery", icon: "travel_explore" },
  { label: "PRDs", icon: "description" },
  { label: "Roadmap", icon: "timeline" },
  { label: "Decompose", icon: "account_tree" },
  { label: "Readiness", icon: "fact_check" },
  { label: "Dependencies", icon: "lan" },
];
const active = pencil.input.active;

const tabs = ITEMS.map((it) => {
  const on = it.label === active;
  return {
    type: "frame",
    name: "wtab-" + it.label + (on ? " (active)" : ""),
    fill: on ? "$accent-subtle" : "#00000000",
    cornerRadius: 7,
    stroke: on ? "$accent" : "#00000000",
    strokeWidth: 1,
    strokeAlignment: "inner",
    gap: 7,
    padding: [7, 12],
    alignItems: "center",
    children: [
      {
        type: "icon",
        name: "ic",
        width: 15,
        height: 15,
        icon: it.icon,
        library: "Material Symbols Rounded",
        weight: on ? 600 : 500,
        fill: on ? "$accent" : "$text-tertiary",
      },
      {
        type: "text",
        name: "t",
        content: it.label,
        fontFamily: "Inter",
        fontSize: 13,
        fontWeight: on ? "600" : "normal",
        fill: on ? "$accent" : "$text-secondary",
      },
    ],
  };
});

return [
  {
    type: "frame",
    name: "workspaceNav",
    x: 0,
    y: 0,
    width: pencil.width,
    height: pencil.height,
    fill: "$bg-sidebar",
    stroke: "$border",
    strokeWidth: { bottom: 1 },
    strokeAlignment: "inner",
    layout: "horizontal",
    gap: 4,
    padding: [0, 28],
    alignItems: "center",
    children: tabs,
  },
];
