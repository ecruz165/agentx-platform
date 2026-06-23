/**
 * @schema 2.13
 * @input open: boolean = true
 * @input selected: enum("New Job", "Manage", "Plan", "Build", "Validate", "Run", "Jobs", "Benchmarks", "Settings") = "Build"
 * @input workspaceOpen: boolean = true
 * @input product: enum("Digital Investor Platform", "Acme Retail", "Northwind Ops") = "Digital Investor Platform"
 * @input projectOpen: boolean = false
 * @input bg: color = #FFFFFF
 *
 * Global left nav. THE RULE: Manage is NOT part of the flow. The four job kinds
 * (Plan / Build / Validate / Run) are grouped under a "Workspaces" disclosure;
 * Manage is its own overview item ABOVE the group, visually separate — never a
 * fifth flat peer. New Job is the primary action (solid accent). Settings is
 * pinned to the base. The Portfolio/Product altitude toggle is NOT here — it
 * lives in the workspace header.
 *
 * Disclosure: `selected` ALONE is the active item; when it is one of the four hats
 * the "Workspaces" parent shows the SELECTED look in BOTH states. `workspaceOpen`
 * is purely a hover-reveal of the child options — it does NOT change the selection.
 * Collapsed (rest) = "Workspaces · {hat}" selected pill; expanded (hover) = a
 * "Workspaces" selected pill + Plan/Build/Validate/Run revealed on a guide line,
 * the active hat marked with accent text + an accent guide tick (no second pill).
 *
 * Pencil scripts can't emit component refs, so rows are inline frames with
 * EXPLICIT widths; top-level blocks placed via a y-cursor; dropdown pushed last.
 */

const HATS = ["Plan", "Build", "Validate", "Run"];
const HAT_ICONS = { Plan: "assignment", Build: "construction", Validate: "verified_user", Run: "rocket_launch" };

const PRODUCTS = [
  { name: "Digital Investor Platform", initials: "DI", color: "$accent" },
  { name: "Acme Retail", initials: "AR", color: "#A78BFA" },
  { name: "Northwind Ops", initials: "NO", color: "#34D399" },
];

const W = pencil.width;
const padX = 12;
const padTop = 14;
const innerW = W - padX * 2;
const rowH = 38;
const gap = 6;
const SEL_H = 48;

const sel = pencil.input.selected;
const wsOpen = pencil.input.workspaceOpen;
const inWorkspace = HATS.indexOf(sel) >= 0;
let prod = PRODUCTS.find((p) => p.name === pencil.input.product);
if (!prod) prod = PRODUCTS[0];

function mkRow(yy, o) {
  const rx = o.x != null ? o.x : padX;
  const rw = o.w != null ? o.w : innerW;
  const primary = !!o.primary, isSel = !!o.sel, soft = !!o.softSel;
  const accent = isSel || soft;
  const fg = primary ? "$text-on-accent" : (accent ? "$accent" : "$text-secondary");
  const icFg = primary ? "$text-on-accent" : (accent ? "$accent" : "$text-tertiary");
  const row = {
    type: "frame", name: "nav-" + o.label.replace(/\s+/g, "-").toLowerCase() + (isSel ? " (selected)" : (soft ? " (active)" : "")),
    x: rx, y: yy, width: rw, height: rowH, cornerRadius: 6, padding: [10, 12], alignItems: "center", gap: 11,
    justifyContent: (o.tag || o.chevron) ? "space_between" : "start",
    children: [],
  };
  if (primary) row.fill = "$accent";
  else if (isSel) { row.fill = "$accent-subtle"; row.stroke = "$accent"; row.strokeWidth = 1; row.strokeAlignment = "inner"; }
  const left = { type: "frame", name: "l", gap: 11, alignItems: "center", children: [
    { type: "icon", name: "ic", width: 18, height: 18, icon: o.icon, library: "Material Symbols Rounded", weight: (accent || primary) ? 600 : 500, fill: icFg },
  ] };
  if (o.collapsedHat) {
    left.children.push({ type: "frame", name: "lbl", gap: 6, alignItems: "center", children: [
      { type: "text", name: "t", content: o.label, fontFamily: "Inter", fontSize: 13, fontWeight: isSel ? "600" : "normal", fill: fg },
      { type: "text", name: "sep", content: "·", fontFamily: "Inter", fontSize: 13, fill: "$text-muted" },
      { type: "text", name: "hat", content: o.collapsedHat, fontFamily: "Inter", fontSize: 13, fontWeight: "600", fill: o.hatColor },
    ] });
  } else {
    left.children.push({ type: "text", name: "t", content: o.label, fontFamily: "Inter", fontSize: 13, fontWeight: (accent || primary) ? "600" : "normal", fill: fg });
  }
  row.children.push(left);
  if (o.tag) {
    row.children.push({ type: "frame", name: "tag", cornerRadius: "$radius-pill", stroke: primary ? "#FFFFFF55" : "$border", strokeWidth: 1, strokeAlignment: "inner", padding: [2, 8], alignItems: "center", children: [
      { type: "text", name: "t", content: o.tag, fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: "500", fill: primary ? "$text-on-accent" : "$text-tertiary" },
    ] });
  } else if (o.chevron) {
    row.children.push({ type: "icon", name: "chev", width: 18, height: 18, icon: o.chevron, library: "Material Symbols Rounded", fill: (isSel || soft) ? "$accent" : "$text-tertiary" });
  }
  return row;
}

const nodes = [];

if (pencil.input.open) {
  nodes.push({ type: "rectangle", name: "bg", x: 0, y: 0, width: pencil.width, height: pencil.height, fill: pencil.input.bg });

  let y = padTop;

  // ---------- PROJECT SELECTOR ----------
  const midW = innerW - 50;
  nodes.push({
    type: "frame", name: "projectSelector", x: padX, y: y, width: innerW, height: SEL_H,
    fill: "$bg-inset", cornerRadius: 8, stroke: pencil.input.projectOpen ? "$accent" : "$border", strokeWidth: 1, strokeAlignment: "inner",
    layout: "horizontal", gap: 10, alignItems: "center", padding: [9, 11],
    children: [
      { type: "frame", name: "mid", width: midW, height: 30, layout: "vertical", gap: 1, justifyContent: "center", clip: true, children: [
        { type: "text", name: "name", content: prod.name, fontFamily: "Inter", fontSize: 13, fontWeight: "600", fill: "$text-primary", textGrowth: "fixed-width", width: midW, lineHeight: 1.15 },
      ] },
      { type: "icon", name: "chev", width: 18, height: 18, icon: pencil.input.projectOpen ? "expand_less" : "unfold_more", library: "Material Symbols Rounded", fill: "$text-tertiary" },
    ],
  });
  y += SEL_H + 18;

  // ---------- NEW JOB (primary action) ----------
  nodes.push(mkRow(y, { label: "New Job", icon: "add_circle", sel: sel === "New Job", tag: "entry" }));
  y += rowH + gap + 4;

  // ---------- MANAGE (overview · separate, above the group) ----------
  nodes.push(mkRow(y, { label: "Manage", icon: "pie_chart", sel: sel === "Manage", tag: "overview" }));
  y += rowH + gap + 4;

  // ---------- WORKSPACES disclosure ----------
  if (wsOpen) {
    nodes.push(mkRow(y, { label: "Workspaces", icon: "grid_view", chevron: "expand_more", sel: inWorkspace }));
    y += rowH + 4;
    const guideTop = y;
    const indent = 16;
    const activeIdx = HATS.indexOf(sel);
    for (const hat of HATS) {
      nodes.push(mkRow(y, { label: hat, icon: HAT_ICONS[hat], x: padX + indent, w: innerW - indent, softSel: sel === hat }));
      y += rowH + 4;
    }
    nodes.push({ type: "rectangle", name: "guide", x: padX + 7, y: guideTop + 2, width: 1, height: HATS.length * (rowH + 4) - 10, fill: "$border" });
    if (activeIdx >= 0) nodes.push({ type: "rectangle", name: "guide-active", x: padX + 7, y: guideTop + 2 + activeIdx * (rowH + 4), width: 2, height: rowH - 6, fill: "$accent" });
    y += gap;
  } else {
    const cr = { label: "Workspaces", icon: "grid_view", chevron: "chevron_right", sel: inWorkspace };
    if (inWorkspace) { cr.collapsedHat = sel; cr.hatColor = "$accent"; }
    nodes.push(mkRow(y, cr));
    y += rowH + gap + 4;
  }

  // ---------- JOBS · BENCHMARKS ----------
  nodes.push(mkRow(y, { label: "Jobs", icon: "work", sel: sel === "Jobs", tag: "all" }));
  y += rowH + gap;
  nodes.push(mkRow(y, { label: "Benchmarks", icon: "leaderboard", sel: sel === "Benchmarks" }));
  y += rowH + gap;

  // ---------- SETTINGS (pinned to base) ----------
  const setY = pencil.height - padTop - rowH;
  nodes.push({ type: "rectangle", name: "settingsDivider", x: padX, y: setY - 13, width: innerW, height: 1, fill: "$border-subtle" });
  nodes.push(mkRow(setY, { label: "Settings", icon: "settings", sel: sel === "Settings" }));

  // ---------- PROJECT DROPDOWN (overlay, pushed last) ----------
  if (pencil.input.projectOpen) {
    const ddPad = 6, itemH = 36, rowW = innerW - ddPad * 2;
    const ddChildren = [];
    for (const p of PRODUCTS) {
      const cur = p.name === prod.name;
      ddChildren.push({ type: "frame", name: "dd-" + p.name, width: rowW, height: itemH, layout: "horizontal", gap: 10, alignItems: "center", cornerRadius: 6, padding: [0, 8], fill: cur ? "$accent-subtle" : "#00000000", children: [
        { type: "text", name: "n", content: p.name, fontFamily: "Inter", fontSize: 13, fontWeight: cur ? "600" : "normal", fill: cur ? "$accent" : "$text-secondary" },
      ] });
    }
    ddChildren.push({ type: "frame", name: "divider", width: rowW, height: 1, fill: "$border" });
    ddChildren.push({ type: "frame", name: "dd-add", width: rowW, height: itemH, layout: "horizontal", gap: 10, alignItems: "center", cornerRadius: 6, padding: [0, 8], children: [
      { type: "icon", name: "plus", width: 18, height: 18, icon: "add", library: "Material Symbols Rounded", fill: "$accent" },
      { type: "text", name: "n", content: "Add product", fontFamily: "Inter", fontSize: 13, fontWeight: "600", fill: "$accent" },
    ] });
    const ddH = ddPad * 2 + PRODUCTS.length * itemH + 1 + itemH + (PRODUCTS.length + 1) * 2;
    nodes.push({ type: "frame", name: "projectDropdown", x: padX, y: padTop + SEL_H + 4, width: innerW, height: ddH, fill: "$bg-surface", cornerRadius: 8, stroke: "$border", strokeWidth: 1, strokeAlignment: "inner", layout: "vertical", gap: 2, padding: ddPad, effect: { type: "shadow", shadowType: "outer", offset: { x: 0, y: 8 }, blur: 24, spread: 0, color: "#00000066" }, children: ddChildren });
  }
}

return nodes;
