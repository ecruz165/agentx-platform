/**
 * @schema 2.13
 * @input active: enum("Releases", "Promote", "Canary", "Rollback", "Non-prod", "Artifacts") = "Promote"
 *
 * Run-hat WORKSPACE secondary nav. Fourth sibling of plan/build/validate-subnav.js
 * so all workspaces read identically. The Run hat is a workspace: Releases
 * (intake + manifest) · Promote (approval console + gate pipeline, the strong
 * original) · Canary · Rollback (incidents — the FI-critical gap) · Non-prod
 * (chain-forward deploys) · Artifacts (artifact-terminal generation: images,
 * SDKs, docs, tokens). Health is deferred (gated on the Run/Manage boundary).
 * One source of truth; set the focused area per screen via `active`.
 */
const ITEMS = [
  { label: "Releases", icon: "new_releases" },
  { label: "Promote", icon: "rocket_launch" },
  { label: "Canary", icon: "experiment" },
  { label: "Rollback", icon: "settings_backup_restore" },
  { label: "Non-prod", icon: "dns" },
  { label: "Artifacts", icon: "inventory_2" },
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
