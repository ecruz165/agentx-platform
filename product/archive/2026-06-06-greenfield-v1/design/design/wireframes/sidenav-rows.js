/**
 * @schema 2.13
 * @input selected: number = 0
 */

const items = [
  { section: "main",    label: "Home",        icon: "home" },
  { section: "main",    label: "Products",    icon: "inventory_2" },
  { section: "main",    label: "Jobs",        icon: "work" },
  { section: "main",    label: "Benchmarks",  icon: "leaderboard" },
  { section: "catalog", label: "Agents",      icon: "smart_toy" },
  { section: "catalog", label: "Allow Lists", icon: "rule" },
  { section: "catalog", label: "Flows",       icon: "account_tree" },
  { section: "catalog", label: "Skills",      icon: "extension" },
];

const sel = pencil.input.selected;
const W = pencil.width;
const rowH = 38;
const gap = 6;
const labelBlockH = 28;

const nodes = [];
let y = 0;
let lastSection = null;

for (let i = 0; i < items.length; i++) {
  const it = items[i];
  if (it.section === "catalog" && lastSection !== "catalog") {
    nodes.push({
      type: "text",
      name: "dSub",
      x: 4,
      y: y + 8,
      content: "CATALOG",
      fontFamily: "JetBrains Mono",
      fontSize: 9,
      fontWeight: "600",
      letterSpacing: 2,
      fill: "$text-muted",
    });
    y += labelBlockH;
  }
  lastSection = it.section;

  const isSel = i === sel;
  const slug = it.label.replace(/\s+/g, "-").toLowerCase();

  nodes.push({
    type: "frame",
    name: "nav-" + slug + (isSel ? " (selected)" : ""),
    x: 0,
    y,
    width: W,
    height: rowH,
    fill: isSel ? "$accent-subtle" : undefined,
    cornerRadius: 6,
    stroke: isSel ? "$accent" : undefined,
    strokeWidth: isSel ? 1 : undefined,
    strokeAlignment: "inner",
    gap: 12,
    padding: [10, 12],
    alignItems: "center",
    children: [
      {
        type: "icon",
        name: "ic",
        width: 18,
        height: 18,
        icon: it.icon,
        library: "Material Symbols Rounded",
        weight: isSel ? 600 : 500,
        fill: isSel ? "$text-primary" : "$text-secondary",
      },
      {
        type: "text",
        name: "t",
        content: it.label,
        fontFamily: "Inter",
        fontSize: 14,
        fontWeight: isSel ? "600" : "normal",
        fill: isSel ? "$text-primary" : "$text-secondary",
      },
    ],
  });
  y += rowH + gap;
}

return nodes;
