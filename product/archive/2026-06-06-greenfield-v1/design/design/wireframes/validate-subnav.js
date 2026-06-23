/**
 * @schema 2.13
 * @input active: enum("Intake", "Queue", "Sign-off", "Resolve", "Evidence", "Health") = "Queue"
 *
 * Validate-hat WORKSPACE secondary nav. Mirrors plan-subnav.js / build-subnav.js
 * exactly so all three workspaces read identically. The Validate hat is a
 * workspace: Intake (what's entering + gate policy) · Queue (supervise, the
 * original dashboard) · Sign-off (gated minority + evidence) · Resolve (the
 * gate's two edges: route-back-to-Build / promote-to-Run) · Evidence
 * (attestations, audit trail) · Health (gate trends, flaky detection). One
 * source of truth; set the focused area per screen via `active`. Second nav
 * level under the five-hat tab bar (tabbar.js): a lighter, nested band with a
 * pill on the active area.
 */
const ITEMS = [
  { label: "Intake", icon: "call_received" },
  { label: "Queue", icon: "fact_check" },
  { label: "Sign-off", icon: "approval" },
  { label: "Resolve", icon: "alt_route" },
  { label: "Evidence", icon: "receipt_long" },
  { label: "Health", icon: "monitoring" },
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
