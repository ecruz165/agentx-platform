/**
 * @schema 2.13
 * @input activeSection: enum("Flow", "Steering", "Output", "Quality", "Budget & Gates", "Activity", "Performance", "Context") = "Flow"
 *
 * JobsActivityBar — the right-side icon rail for a Job. `activeSection` TOGGLES
 * which of the 8 Job activity panes is active; the matching pane renders to its
 * left (in the activity-pane area). The active icon gets the accent + left-border
 * treatment; the rest are neutral. Settings pins to the bottom.
 *
 * This is the right-rail counterpart to paneLeft-toggle (gWKTT): a self-contained
 * script so the active state is a single enum input (the toggle), not a per-instance
 * descendant override. Icons only — no component refs — so the script-ref limit
 * doesn't apply, and it renders fine nested in a Job screen body.
 *
 * Section order matches the v2 ActivityPanes board (rail order).
 */

const W = pencil.width;
const H = pencil.height;
const active = pencil.input.activeSection;

const SECTIONS = [
  ["Flow", "account_tree"],
  ["Steering", "front_hand"],
  ["Output", "difference"],
  ["Quality", "fact_check"],
  ["Budget & Gates", "savings"],
  ["Activity", "hub"],
  ["Performance", "speed"],
  ["Context", "folder_open"],
];

const itemH = 40;
const gap = 4;
const padTop = 12;

const nodes = [];

nodes.push({
  type: "rectangle",
  name: "bg",
  x: 0,
  y: 0,
  width: W,
  height: H,
  fill: "$bg-sidebar",
  stroke: "$border",
  strokeWidth: { left: 1 },
  strokeAlignment: "inner",
});

for (let i = 0; i < SECTIONS.length; i++) {
  const nm = SECTIONS[i][0];
  const icon = SECTIONS[i][1];
  const on = nm === active;
  const iy = padTop + i * (itemH + gap);

  const item = {
    type: "frame",
    name: "item-" + nm,
    x: 0,
    y: iy,
    width: W,
    height: itemH,
    justifyContent: "center",
    alignItems: "center",
    children: [
      {
        type: "icon",
        name: "i",
        width: 20,
        height: 20,
        icon: icon,
        library: "Material Symbols Rounded",
        fill: on ? "$accent" : "$text-secondary",
      },
    ],
  };

  if (on) {
    item.fill = "$accent-subtle";
    item.stroke = "$accent";
    item.strokeWidth = { left: 2 };
    item.strokeAlignment = "inner";
  }

  nodes.push(item);
}

nodes.push({
  type: "frame",
  name: "item-settings",
  x: 0,
  y: H - itemH - padTop,
  width: W,
  height: itemH,
  justifyContent: "center",
  alignItems: "center",
  children: [
    {
      type: "icon",
      name: "i",
      width: 20,
      height: 20,
      icon: "settings",
      library: "Material Symbols Rounded",
      fill: "$text-secondary",
    },
  ],
});

return nodes;
