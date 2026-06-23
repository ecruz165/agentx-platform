/**
 * @schema 2.13
 * @input active: enum("Overview", "Calibration", "Governance", "Compare") = "Overview"
 *
 * Manage-hat WORKSPACE secondary nav. Fifth sibling of plan/build/validate/run-
 * subnav.js. Manage is the ODD ONE OUT: not a job-kind hat but the Portfolio-
 * altitude LENS on the flow. So these are lenses, not capabilities: Overview
 * (flow + cost + scale + attention, the realigned original) · Calibration
 * (predicted-vs-actual — the substrate payoff) · Governance (autonomy policy
 * envelope, enforcement, audit — the trust half) · Compare (cross-initiative
 * health). Operational Health is deferred pending the Run/Manage boundary.
 * One source of truth; set the focused lens per screen via `active`.
 */
const ITEMS = [
  { label: "Overview", icon: "dashboard" },
  { label: "Calibration", icon: "balance" },
  { label: "Governance", icon: "policy" },
  { label: "Compare", icon: "compare" },
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
