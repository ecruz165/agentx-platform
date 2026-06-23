/**
 * @schema 2.13
 * @input active: enum("Manage", "Plan", "Build", "Validate", "Run") = "Manage"
 *
 * Dashboard role/phase tab row, rendered from a single source so every screen
 * stays in sync. Set which tab is focused per screen via the `active` input.
 * Change the tab SET or ORDER once here (edit TABS) and every instance updates.
 *
 * Pencil scripts can't flex their own children, so the row is returned as a
 * single frame sized to the script node (pencil.width/height) that does the
 * layout. Tabs carry NO explicit width — the row left-aligns them.
 */
const TABS = ["Manage", "Plan", "Build", "Validate", "Run"];
const active = pencil.input.active;

const tabs = TABS.map((label) => {
  const on = label === active;
  return {
    type: "frame",
    name: "tab-" + label,
    stroke: on ? "$accent" : "#00000000",
    strokeWidth: { bottom: 2 },
    strokeAlignment: "inner",
    gap: 7,
    padding: [12, 18],
    alignItems: "center",
    children: [
      {
        type: "text",
        name: "t",
        content: label,
        fontFamily: "Inter",
        fontSize: 14,
        fontWeight: on ? "600" : "normal",
        fill: on ? "$text-primary" : "$text-secondary",
      },
    ],
  };
});

return [
  {
    type: "frame",
    name: "tabBar",
    x: 0,
    y: 0,
    width: pencil.width,
    height: pencil.height,
    stroke: "$border",
    strokeWidth: { bottom: 1 },
    strokeAlignment: "inner",
    layout: "horizontal",
    padding: [0, 28],
    alignItems: "end",
    children: tabs,
  },
];
