/**
 * @schema 2.13
 * @input paneActivityPanels: boolean = true
 * @input paneActivityBar: boolean = true
 * @input activeSection: enum("Flow", "Steering", "Output", "Quality", "Budget & Gates", "Activity", "Performance", "Context") = "Flow"
 *
 * Self-contained RIGHT-SIDE pane — the runnable MIRROR of the 8 master views
 * on the "ActivityPanes — v2 (list + detail model)" board. Renders the panels
 * area (wider master content) and the activity bar (narrow icon rail) inline,
 * each gated by its own boolean input. `activeSection` drives BOTH which bar
 * icon is highlighted AND which pane's window stack renders in the panels area.
 *
 * Layout (left -> right inside the script's box):
 *   [ panels area, takes leftover width ] [ activity bar, 48px ]
 *
 * The 8 sections mirror the v2 board columns, in rail order:
 *   Flow            account_tree  -> the run spine (nodes + status)
 *   Steering        front_hand    -> approval requests + the team
 *   Output          difference    -> changes by task + artifacts
 *   Quality         fact_check    -> the gates (blocking vs advisory)
 *   Budget & Gates  savings       -> spend vs ceiling + halting gates
 *   Activity        hub           -> the coordinator decision trace
 *   Performance     speed         -> model usage + connection + failures
 *   Context         folder_open   -> inputs + retrieval queries
 *
 * REFRESH CONTRACT: the board is source-of-truth; re-sync the SECTION data
 * below FROM the matching board column when its master design changes.
 *
 * Script constraints (see paneleft-toggle.js + project notes):
 *  - Scripts can't emit component refs (so panes are mirrored inline, not ref'd).
 *  - Script frames DON'T support fit_content/fill_container reliably, so EVERY
 *    frame carries an explicit width + height derived from `pencil.width`.
 *    Top-level windows are placed via a y-cursor; rows use pixel widths.
 */

const W = pencil.width;
const H = pencil.height;
const barW = 48;

const showPanels = pencil.input.paneActivityPanels;
const showBar = pencil.input.paneActivityBar;
const active = pencil.input.activeSection;

const OK = "$status-active";
const WARN = "$status-warning";
const BAD = "$status-danger";
const AC = "$accent";
const MUT = "$text-muted";
const T1 = "$text-primary";
const T2 = "$text-tertiary";

const SECTIONS = [
  { key: "Flow", icon: "account_tree" },
  { key: "Steering", icon: "front_hand" },
  { key: "Output", icon: "difference" },
  { key: "Quality", icon: "fact_check" },
  { key: "Budget & Gates", icon: "savings" },
  { key: "Activity", icon: "hub" },
  { key: "Performance", icon: "speed" },
  { key: "Context", icon: "folder_open" },
];

const nodes = [];

// ---------- leaf builders ----------
function txt(name, content, opts) {
  const base = { type: "text", name, content, fontFamily: "Inter", fontSize: 12, fill: "$text-secondary" };
  if (opts) for (const k in opts) base[k] = opts[k];
  return base;
}

function ico(name, ic, fill, size) {
  return {
    type: "icon",
    name,
    width: size || 16,
    height: size || 16,
    icon: ic,
    library: "Material Symbols Rounded",
    fill: fill || "$text-secondary",
  };
}

// ---------- window shell ----------
const HEADER_H = 34;
const BODY_PAD = 6;
const ROW_GAP = 2;

// rows: [{ height, node }]; node widths are already set to the inner row width.
function windowCard(name, x, y, w, title, count, rows) {
  let bodyInner = 0;
  for (let i = 0; i < rows.length; i++) bodyInner += rows[i].height + (i ? ROW_GAP : 0);
  const bodyH = bodyInner + BODY_PAD * 2;
  const winH = HEADER_H + bodyH;

  const headerKids = [
    txt("winTitle", title, {
      fill: "$text-primary",
      fontSize: 11,
      fontWeight: "600",
      fontFamily: "JetBrains Mono",
      letterSpacing: 1,
    }),
  ];
  if (count) headerKids.push(txt("winCount", count, { fill: "$text-tertiary", fontSize: 10, fontFamily: "JetBrains Mono" }));

  return {
    type: "frame",
    name,
    x,
    y,
    width: w,
    height: winH,
    layout: "vertical",
    fill: "$bg-surface",
    cornerRadius: 8,
    stroke: "$border",
    strokeWidth: 1,
    strokeAlignment: "inner",
    clip: true,
    children: [
      {
        type: "frame",
        name: "winHeader",
        width: w,
        height: HEADER_H,
        layout: "horizontal",
        justifyContent: "space_between",
        alignItems: "center",
        padding: [0, 12],
        stroke: "$border",
        strokeWidth: { bottom: 1 },
        strokeAlignment: "inner",
        children: headerKids,
      },
      {
        type: "frame",
        name: "winBody",
        width: w,
        height: bodyH,
        layout: "vertical",
        gap: ROW_GAP,
        padding: BODY_PAD,
        children: rows.map(function (r) { return r.node; }),
      },
    ],
  };
}

// ---------- row builders (rw = inner row width) ----------
// Generic master-list row: leading icon + label (left), right-aligned value.
function gRow(rw, icon, iconColor, label, value, valueColor) {
  const leftW = Math.round(rw * 0.62);
  const rightW = rw - leftW;
  return {
    height: 30,
    node: {
      type: "frame",
      name: "gRow",
      width: rw,
      height: 30,
      layout: "horizontal",
      alignItems: "center",
      cornerRadius: 4,
      children: [
        {
          type: "frame",
          name: "gLeft",
          width: leftW,
          height: 30,
          layout: "horizontal",
          alignItems: "center",
          gap: 8,
          padding: [0, 0, 0, 10],
          clip: true,
          children: [
            ico("ic", icon, iconColor || "$text-secondary"),
            txt("lbl", label, { fill: T1, fontSize: 12, fontFamily: "JetBrains Mono" }),
          ],
        },
        {
          type: "frame",
          name: "gRight",
          width: rightW,
          height: 30,
          layout: "horizontal",
          justifyContent: "end",
          alignItems: "center",
          padding: [0, 10, 0, 0],
          children: [
            txt("val", value, { fill: valueColor || "$text-tertiary", fontSize: 11, fontWeight: "600", fontFamily: "JetBrains Mono" }),
          ],
        },
      ],
    },
  };
}

function personRow(rw, initials, name, role, accent) {
  const metaW = rw - 28 - 10 - 20;
  return {
    height: 40,
    node: {
      type: "frame",
      name: "personRow",
      width: rw,
      height: 40,
      layout: "horizontal",
      alignItems: "center",
      gap: 10,
      cornerRadius: 4,
      padding: [0, 10],
      children: [
        {
          type: "frame",
          name: "avatar",
          width: 28,
          height: 28,
          fill: accent ? "$accent-subtle" : "$bg-inset",
          cornerRadius: 999,
          justifyContent: "center",
          alignItems: "center",
          children: [txt("ini", initials, { fill: accent ? "$accent" : "$text-secondary", fontSize: 11, fontWeight: "600" })],
        },
        {
          type: "frame",
          name: "meta",
          width: metaW,
          height: 32,
          layout: "vertical",
          gap: 1,
          justifyContent: "center",
          children: [
            txt("name", name, { fill: "$text-primary", fontSize: 12, fontWeight: "600" }),
            txt("role", role, { fill: "$text-tertiary", fontSize: 10 }),
          ],
        },
      ],
    },
  };
}

// ---------- panel assembly ----------
function buildPanel(panelW) {
  const x = 12;
  const w = panelW - 24;
  const rw = w - BODY_PAD * 2;
  let y = 14;
  const out = [];

  out.push({
    type: "text",
    name: "panelEyebrow",
    x: 16,
    y: y,
    content: active.toUpperCase(),
    fontFamily: "JetBrains Mono",
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 2,
    fill: "$text-tertiary",
  });
  out.push({
    type: "text",
    name: "panelSub",
    x: 16,
    y: y + 18,
    content: "WEBMOD-12345 · implement-feature v3",
    fontFamily: "JetBrains Mono",
    fontSize: 10,
    fill: "$text-tertiary",
  });
  y += 48;

  function add(win) {
    out.push(win);
    y += win.height + 12;
  }

  if (active === "Flow") {
    add(windowCard("wFlow", x, y, w, "FLOW", "6 nodes", [
      gRow(rw, "check_circle", OK, "Plan", "done", OK),
      gRow(rw, "check_circle", OK, "Scaffold", "done", OK),
      gRow(rw, "radio_button_checked", AC, "Generate patch", "running", AC),
      gRow(rw, "radio_button_checked", AC, "Run tests", "running", AC),
      gRow(rw, "block", BAD, "Quality gate", "blocked", BAD),
      gRow(rw, "lock", MUT, "Merge to main", "pending", MUT),
    ]));
  } else if (active === "Steering") {
    add(windowCard("wReq", x, y, w, "REQUESTS", "6 · 1 blocking", [
      gRow(rw, "front_hand", BAD, "Approve merge to main", "BLOCKING", BAD),
      gRow(rw, "rule", WARN, "Security review", "CHANGES", WARN),
      gRow(rw, "rule", OK, "Auth review", "APPROVED", OK),
      gRow(rw, "front_hand", WARN, "Apply migration", "AWAITING", WARN),
    ]));
    add(windowCard("wTeam", x, y, w, "TEAM", "5 · 4 connected", [
      personRow(rw, "DR", "Dana Ruiz", "Manager", true),
      personRow(rw, "AK", "Alex Kim", "SME · Auth", false),
      personRow(rw, "PP", "Priya Patel", "SME · Security", false),
      personRow(rw, "SC", "Sam Cole", "Member", false),
    ]));
  } else if (active === "Output") {
    add(windowCard("wChanges", x, y, w, "CHANGES BY TASK", "9 files · 5 tasks", [
      gRow(rw, "commit", T2, "Rotate session tokens", "2 files", T2),
      gRow(rw, "commit", T2, "Gate /auth behind flag", "2 files", T2),
      gRow(rw, "commit", T2, "Add refresh tests", "2 files", T2),
      gRow(rw, "commit", T2, "Cap rotation at 1h", "1 file", T2),
      gRow(rw, "commit", T2, "Drop audit archive", "1 file", T2),
    ]));
    add(windowCard("wArtifacts", x, y, w, "ARTIFACTS", "4", [
      gRow(rw, "summarize", T2, "rotation-summary.md", "4.2 KB", T2),
      gRow(rw, "data_object", T2, "api-contract.json", "1.8 KB", T2),
      gRow(rw, "html", T2, "coverage-report.html", "88 KB", T2),
      gRow(rw, "account_tree", T2, "auth-sequence.svg", "12 KB", T2),
    ]));
  } else if (active === "Quality") {
    add(windowCard("wGates", x, y, w, "QUALITY GATES", "4/6 · 1 blocking", [
      gRow(rw, "cancel", BAD, "Coverage ≥ 80%", "72%", BAD),
      gRow(rw, "check_circle", OK, "Security scan", "pass", OK),
      gRow(rw, "check_circle", OK, "Unit tests", "pass", OK),
      gRow(rw, "check_circle", OK, "Type check", "pass", OK),
      gRow(rw, "check_circle", OK, "Lint", "pass", OK),
      gRow(rw, "check_circle", OK, "Eval relevance", "0.91", OK),
    ]));
  } else if (active === "Budget & Gates") {
    add(windowCard("wBudget", x, y, w, "BUDGET", "8% used", [
      gRow(rw, "payments", T2, "Spent", "$0.41", T1),
      gRow(rw, "trending_up", T2, "Projected", "$0.68", T1),
      gRow(rw, "savings", OK, "Remaining", "$4.59", OK),
      gRow(rw, "data_usage", T2, "Tokens", "35.8k", T1),
    ]));
    add(windowCard("wHalt", x, y, w, "HALTING GATES", "5 · all clear", [
      gRow(rw, "check_circle", OK, "Cost ceiling", "8%", T2),
      gRow(rw, "check_circle", OK, "Max HITL pauses", "33%", T2),
      gRow(rw, "check_circle", OK, "Wall-clock", "40%", T2),
      gRow(rw, "check_circle", OK, "Max retries", "20%", T2),
      gRow(rw, "check_circle", OK, "Token budget", "18%", T2),
    ]));
  } else if (active === "Activity") {
    add(windowCard("wDecisions", x, y, w, "COORDINATOR DECISIONS", "6", [
      gRow(rw, "check_circle", T2, "Plan accepted → Scaffold", "14:01", T2),
      gRow(rw, "hub", AC, "Dispatch coder · Patch", "14:02", AC),
      gRow(rw, "call_split", T2, "Fork: patch ‖ tests", "14:03", T2),
      gRow(rw, "hub", T2, "Dispatch test-runner", "14:05", T2),
      gRow(rw, "rule", WARN, "Hold at Quality gate", "14:08", WARN),
      gRow(rw, "front_hand", T2, "Escalate merge approval", "14:09", T2),
    ]));
  } else if (active === "Performance") {
    add(windowCard("wModels", x, y, w, "MODEL USAGE", "3 engines", [
      gRow(rw, "memory", T2, "claude-opus-4.8", "$0.30", T1),
      gRow(rw, "memory", T2, "claude-sonnet-4.6", "$0.09", T1),
      gRow(rw, "memory", T2, "gpt-4o · eval", "$0.02", T1),
    ]));
    add(windowCard("wConn", x, y, w, "CONNECTION STATE", "healthy", [
      gRow(rw, "lan", OK, "Stream", "live", OK),
      gRow(rw, "tag", T2, "Last seq", "#1284", T2),
      gRow(rw, "restart_alt", T2, "Reconnects", "0", T2),
    ]));
    add(windowCard("wFail", x, y, w, "FAILURES", "1 retry", [
      gRow(rw, "error", WARN, "vitest exit 1", "recovered", WARN),
    ]));
  } else if (active === "Context") {
    add(windowCard("wInputs", x, y, w, "INPUTS", "demoted", [
      gRow(rw, "description", T2, "Uploaded docs", "4", T2),
      gRow(rw, "link", T2, "Links", "5", T2),
      gRow(rw, "database", T2, "Repositories", "2", T2),
    ]));
    add(windowCard("wQueries", x, y, w, "QUERIES", "6 · what was used", [
      gRow(rw, "manage_search", AC, "auth token refresh", "12 hits", AC),
      gRow(rw, "manage_search", AC, "session-token rotation", "8 hits", AC),
      gRow(rw, "manage_search", AC, "/auth contract & tests", "15 hits", AC),
    ]));
  }

  return out;
}

// ---------- emit ----------
if (showPanels) {
  const panelW = showBar ? W - barW : W;

  nodes.push({
    type: "rectangle",
    name: "panelsBg",
    x: 0,
    y: 0,
    width: panelW,
    height: H,
    fill: "$bg-surface",
    stroke: "$border",
    strokeWidth: { left: 1 },
    strokeAlignment: "inner",
  });

  try {
    const panel = buildPanel(panelW);
    for (let i = 0; i < panel.length; i++) nodes.push(panel[i]);
  } catch (e) {
    nodes.push({
      type: "text",
      name: "panelErr",
      x: 10,
      y: 10,
      width: panelW - 20,
      textGrowth: "fixed-width",
      content: "ERR: " + String(e && e.message ? e.message : e),
      fontFamily: "JetBrains Mono",
      fontSize: 11,
      fill: "#FF5555",
    });
  }
}

if (showBar) {
  const barX = showPanels ? W - barW : 0;

  nodes.push({
    type: "rectangle",
    name: "barBg",
    x: barX,
    y: 0,
    width: barW,
    height: H,
    fill: "$bg-sidebar",
    stroke: "$border",
    strokeWidth: { left: 1 },
    strokeAlignment: "inner",
  });

  const itemH = 40;
  const itemGap = 4;
  const itemPadTop = 12;

  for (let i = 0; i < SECTIONS.length; i++) {
    const sec = SECTIONS[i];
    const iy = itemPadTop + i * (itemH + itemGap);
    const isActive = sec.key === active;

    const row = {
      type: "frame",
      name: "abItem-" + sec.key,
      x: barX,
      y: iy,
      width: barW,
      height: itemH,
      justifyContent: "center",
      alignItems: "center",
      children: [ico("ic", sec.icon, isActive ? "$accent" : "$text-secondary", 20)],
    };

    if (isActive) {
      row.fill = "$accent-subtle";
      row.stroke = "$accent";
      row.strokeWidth = { left: 2 };
      row.strokeAlignment = "inner";
    }

    nodes.push(row);
  }

  nodes.push({
    type: "frame",
    name: "abFooter",
    x: barX,
    y: H - itemH - itemPadTop,
    width: barW,
    height: itemH,
    justifyContent: "center",
    alignItems: "center",
    children: [ico("ic", "settings", "$text-secondary", 20)],
  });
}

return nodes;
