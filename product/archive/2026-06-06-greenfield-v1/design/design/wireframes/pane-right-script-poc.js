/**
 * @schema 2.13
 * @input activeSection: enum("Context", "Changed Files", "Escalations", "Performance", "Quality", "Logs") = "Context"
 *
 * PRIMARY right activity pane — script-first.
 * The `activeSection` property (dropdown in Pencil's panel) toggles the
 * highlighted rail icon AND the panel content, on property change.
 *
 * The panels are INLINE renders that MIRROR the real paneActivity-*
 * components on the "ActivityPane Windows — Reference" board (roAFq). That
 * board is the SOURCE OF TRUTH where design happens; this script is the
 * runnable mirror used for interactive toggling.
 *
 * >> REFRESH WORKFLOW: when a reference pane's design changes, re-sync the
 *    matching entry in SECTIONS below from the reference board. The reference
 *    refreshes this component; never the other way around.
 *
 * Script constraint that forces the mirror: scripts cannot emit component
 * refs, so the real paneActivity-* components can't be shown here directly.
 */

const W = pencil.width;
const H = pencil.height;
const barW = 48;
const panelW = W - barW;
const active = pencil.input.activeSection;

const T1 = "$text-primary", T2 = "$text-tertiary", MUT = "$text-muted";
const AC = "$accent", OK = "$status-active", WARN = "$status-warning", BAD = "$status-danger";

// section -> windows -> rows ([icon, label, rightValue, rightColor])
const SECTIONS = {
  "Context": { windows: [
    { title: "UPLOADED DOCS", count: "4", rows: [
      ["description", "auth-spec.md", "240 KB", T2],
      ["picture_as_pdf", "rotating-tokens-rfc.pdf", "1.2 MB", T2],
      ["image", "sequence-diagram.png", "", T2],
      ["description", "acceptance-criteria.md", "", T2] ] },
    { title: "LINKS", count: "5", rows: [
      ["article", "Auth Platform — Token Service", "Confluence", T2],
      ["confirmation_number", "WEBMOD-12345 · rotation", "JIRA", T2],
      ["api", "Function calling spec", "OpenAI", T2],
      ["description", "RFC 6749 §6 — rotation", "Spec", T2] ] },
    { title: "QUERIES", count: "6 · context-server", rows: [
      ["manage_search", "auth token refresh patterns", "12 hits", AC],
      ["manage_search", "session-token rotation usages", "8 hits", AC],
      ["manage_search", "/auth contract & refresh tests", "15 hits", AC] ] } ] },
  "Changed Files": { windows: [
    { title: "CHANGES BY TASK", count: "8 files · 5 tasks", rows: [
      ["commit", "Rotate session tokens on 1h window", "2 files", T2],
      ["commit", "Gate /auth behind auth_v2 flag", "2 files", T2],
      ["commit", "Add tests for refresh path", "2 files", T2],
      ["commit", "Cap rotation at 1h (security review)", "1 file", T2],
      ["commit", "Drop audit_log_archive in migration", "1 file", T2] ] } ] },
  "Escalations": { windows: [
    { title: "TEAM MEMBERS", count: "5 · 4 connected", rows: [
      ["shield_person", "Dana Ruiz · Manager", "Connected", OK],
      ["verified", "Alex Kim · Auth SME", "Connected", OK],
      ["verified", "Priya Patel · Security SME", "Connected", OK],
      ["person", "Sam Cole · Member", "Connected", OK],
      ["person", "Lee Wu · Member", "Invited", MUT] ] },
    { title: "REQUESTS", count: "6 · 1 blocking", rows: [
      ["front_hand", "Approve merge to main", "BLOCKING", BAD],
      ["rule", "Security review: rotation", "CHANGES", WARN],
      ["rule", "Auth review: refresh path", "APPROVED", OK],
      ["front_hand", "Apply destructive migration", "AWAITING", WARN] ] } ] },
  "Performance": { windows: [
    { title: "MODEL USAGE", count: "3 engines", rows: [
      ["memory", "claude-opus-4.8", "↓14.2k ↑7.2k", T1],
      ["memory", "claude-sonnet-4.6", "↓8.1k ↑3.4k", T1],
      ["memory", "gpt-4o · eval harness", "↓2.1k ↑0.8k", T1] ] },
    { title: "REQUESTS & LATENCY", count: "24 req", rows: [
      ["sync", "Requests", "24", T1],
      ["timer", "Avg latency", "4.7s", T1],
      ["timer", "p95 latency", "9.4s", T1] ] },
    { title: "HITL RESPONSE", count: "avg 3m 21s", rows: [
      ["how_to_reg", "Approve merge to main", "2m 10s", OK],
      ["how_to_reg", "Security review", "4m 32s", WARN] ] } ] },
  "Quality": { windows: [
    { title: "QUALITY · 4/6", count: "1 blocking", rows: [
      ["cancel", "Coverage ≥ 80%", "72%", BAD],
      ["check_circle", "Security scan", "pass", OK],
      ["check_circle", "Unit tests", "pass", OK],
      ["check_circle", "Type check", "pass", OK],
      ["check_circle", "Lint", "pass", OK],
      ["check_circle", "Eval: relevance ≥ 0.8", "0.91", OK] ] } ] },
  "Logs": { windows: [
    { title: "HISTORY · LLM I/O", count: "", rows: [
      ["north_east", "claude-opus · 14:08 · review tests", "2.4k", T2],
      ["north_east", "claude-sonnet · 14:05 · gen diff", "5.1k", T2],
      ["north_east", "claude-opus · 14:02 · plan refactor", "3.2k", T2],
      ["north_east", "claude-sonnet · 13:58 · scaffold", "2.0k", T2] ] } ] }
};

const RAIL = ["Context", "Changed Files", "Escalations", "Performance", "Quality", "Logs"];
const RAIL_ICON = { "Context": "folder_open", "Changed Files": "difference", "Escalations": "front_hand", "Performance": "speed", "Quality": "fact_check", "Logs": "receipt_long" };

const sec = SECTIONS[active] || SECTIONS["Context"];
const nodes = [];

nodes.push({ type: "rectangle", name: "panelBg", x: 0, y: 0, width: panelW, height: H, fill: "$bg-primary" });
nodes.push({ type: "text", name: "eyebrow", x: 16, y: 14, content: active.toUpperCase(), fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: "600", letterSpacing: 2, fill: T2 });
nodes.push({ type: "text", name: "sub", x: 16, y: 32, content: "WEBMOD-12345 · implement-feature v3", fontFamily: "JetBrains Mono", fontSize: 10, fill: T2 });

const cx = 12;
const cw = panelW - 24;
const leftW = cw - 122;
const HEAD = 32, RH = 30, BP = 6;
let y = 54;

for (let w = 0; w < sec.windows.length; w++) {
  const win = sec.windows[w];
  const bodyH = win.rows.length * RH + BP * 2;
  const cardH = HEAD + bodyH;

  const hk = [{ type: "text", name: "t", content: win.title, fontFamily: "JetBrains Mono", fontSize: 11, fontWeight: "600", letterSpacing: 1, fill: T1 }];
  if (win.count) hk.push({ type: "text", name: "c", content: win.count, fontFamily: "JetBrains Mono", fontSize: 10, fill: T2 });
  const header = { type: "frame", name: "h", width: cw, height: HEAD, layout: "horizontal", justifyContent: "space_between", alignItems: "center", padding: [0, 12], stroke: "$border", strokeWidth: { bottom: 1 }, strokeAlignment: "inner", children: hk };

  const rowFrames = [];
  for (let r = 0; r < win.rows.length; r++) {
    const rw = win.rows[r];
    const left = { type: "frame", name: "l", width: leftW, height: RH, layout: "horizontal", gap: 8, alignItems: "center", clip: true, children: [
      { type: "icon", name: "i", width: 15, height: 15, icon: rw[0], library: "Material Symbols Rounded", fill: T2 },
      { type: "text", name: "t", content: rw[1], fontFamily: "Inter", fontSize: 12, fill: T1 } ] };
    const rowKids = [left];
    if (rw[2]) rowKids.push({ type: "text", name: "r", content: rw[2], fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: "600", fill: rw[3] || T2 });
    rowFrames.push({ type: "frame", name: "row", width: cw, height: RH, layout: "horizontal", justifyContent: "space_between", alignItems: "center", padding: [0, 10], children: rowKids });
  }
  const body = { type: "frame", name: "b", width: cw, height: bodyH, layout: "vertical", gap: 0, padding: [BP, 0], children: rowFrames };

  nodes.push({ type: "frame", name: "win-" + win.title, x: cx, y: y, width: cw, height: cardH, layout: "vertical", fill: "$bg-surface", cornerRadius: 8, stroke: "$border", strokeWidth: 1, strokeAlignment: "inner", clip: true, children: [header, body] });
  y += cardH + 10;
}

nodes.push({ type: "rectangle", name: "railBg", x: panelW, y: 0, width: barW, height: H, fill: "$bg-sidebar", stroke: "$border", strokeWidth: { left: 1 }, strokeAlignment: "inner" });
const itemH = 40, gap = 4, pt = 12;
for (let i = 0; i < RAIL.length; i++) {
  const k = RAIL[i];
  const iy = pt + i * (itemH + gap);
  const on = k === active;
  const it = { type: "frame", name: "ab-" + k, x: panelW, y: iy, width: barW, height: itemH, cornerRadius: 6, justifyContent: "center", alignItems: "center", children: [{ type: "icon", name: "i", width: 20, height: 20, icon: RAIL_ICON[k], library: "Material Symbols Rounded", fill: on ? AC : "$text-secondary" }] };
  if (on) { it.fill = "$accent-subtle"; it.stroke = AC; it.strokeWidth = { left: 2 }; it.strokeAlignment = "inner"; }
  nodes.push(it);
}
nodes.push({ type: "frame", name: "ab-settings", x: panelW, y: H - itemH - pt, width: barW, height: itemH, justifyContent: "center", alignItems: "center", children: [{ type: "icon", name: "i", width: 20, height: 20, icon: "settings", library: "Material Symbols Rounded", fill: "$text-secondary" }] });

return nodes;
