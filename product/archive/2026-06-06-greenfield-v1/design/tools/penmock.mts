#!/usr/bin/env node
/**
 * penmock — scaffold & compose per-section mockup .pen files.
 *
 * Why this exists: a consumer .pen references the design system purely by a
 * top-level JSON field `"imports": { "o": "<relative path to library .pen>" }`.
 * Writing that field is all the "library linking" there is — no Pencil app,
 * no MCP tool, no manual step. This command automates that, plus (when the
 * Pencil CLI is authenticated) drives headless composition + save.
 *
 * Run (Node >=22 runs .mts natively; this repo is on v26):
 *   node penmock.mts scaffold <section|all>     # pure fs, no auth needed
 *   node penmock.mts compose  <section|all>     # needs `pencil login`
 *   node penmock.mts list
 *
 * scaffold  → writes product/design/mockups/<slug>.pen with the imports link.
 * compose   → opens it headless (`pencil interactive --in --out`), applies the
 *             screen via batch_design, calls save(), exits.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // product/design/tools
const DESIGN_DIR = dirname(HERE); // product/design
const LIB_PEN = join(DESIGN_DIR, "design-system.lib.pen");
const MOCK_DIR = join(DESIGN_DIR, "mockups");
const PEN_VERSION = "2.11";
const IMPORT_PREFIX = "o"; // refs become `o:<componentId>`

/** Imported design tokens. Per the .pen spec, an import exposes the library's
 *  variables AND components: components as `o:<id>`, variables as `$o:<name>`.
 *  So mock-owned frames use the library's themed tokens directly (stays in
 *  sync with the library's light/dark themes — no hardcoded hex). */
const tok = (name: string) => `$${IMPORT_PREFIX}:${name}`;

/** A section = one nav destination = one mockup file.
 *  `nav` is the library component id of that section's highlighted NavDrawer. */
interface Section {
  slug: string;
  title: string;
  nav: string;
}

const SECTIONS: readonly Section[] = [
  { slug: "home", title: "Home", nav: "eg6oR" },
  { slug: "products", title: "Products", nav: "Sm27n" },
  { slug: "jobs", title: "Jobs", nav: "b4snWM" },
  { slug: "benchmarks", title: "Benchmarks", nav: "zWTGo" },
  { slug: "agents", title: "Agents", nav: "rdubl" },
  { slug: "skills", title: "Skills", nav: "wc9P8" },
  { slug: "flows", title: "Flows", nav: "UQk0R" },
];

// Library component ids reused across every screen.
const LIB = { topBar: "igu8C", searchBar: "o1pX22", card: "yKOhd" } as const;
const oref = (id: string) => `${IMPORT_PREFIX}:${id}`;

const penPath = (s: Section) => join(MOCK_DIR, `${s.slug}.pen`);

/** The library link, expressed as a path relative to the mock file itself. */
function importsField(mockFile: string): Record<string, string> {
  return { [IMPORT_PREFIX]: relative(dirname(mockFile), LIB_PEN) };
}

/** Write the .pen JSON shell with the imports link. Pure fs — always works. */
function scaffold(s: Section): string {
  mkdirSync(MOCK_DIR, { recursive: true });
  const file = penPath(s);
  const doc = {
    version: PEN_VERSION,
    children: [] as unknown[],
    imports: importsField(file),
  };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
  return file;
}

/** batch_design op string: screen = TopBar + [ NavDrawer | main(title+search+card) ].
 *  Direct composition (no deep AppShell slot nesting) so it is guaranteed-valid
 *  and proves the `o:`-import pipeline + per-section nav highlight. */
function composeInput(s: Section): string {
  return [
    `scr=I(document,{type:"frame",name:"Screen/${s.title}",layout:"vertical",width:1440,height:900,fill:"${tok("bg-primary")}",gap:0})`,
    `tb=I(scr,{type:"ref",ref:"${oref(LIB.topBar)}",width:"fill_container"})`,
    `body=I(scr,{type:"frame",name:"body",layout:"horizontal",width:"fill_container",height:"fill_container",gap:0})`,
    `nav=I(body,{type:"ref",ref:"${oref(s.nav)}",height:"fill_container"})`,
    `main=I(body,{type:"frame",name:"main",layout:"vertical",width:"fill_container",height:"fill_container",padding:28,gap:18})`,
    `ttl=I(main,{type:"text",content:"${s.title}",fill:"${tok("text-primary")}",fontFamily:"${tok("font-sans")}",fontSize:24,fontWeight:"700"})`,
    `sb=I(main,{type:"ref",ref:"${oref(LIB.searchBar)}",width:"fill_container"})`,
    `cd=I(main,{type:"ref",ref:"${oref(LIB.card)}",width:"fill_container"})`,
  ].join("\n");
}

function isAuthed(): Promise<boolean> {
  return new Promise((res) => {
    const p = spawn("pencil", ["status"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", () => res(!/not authenticated/i.test(out)));
    p.on("error", () => res(false));
  });
}

/** Drive the headless interactive shell: batch_design → save() → exit(). */
function compose(s: Section): Promise<void> {
  const file = penPath(s);
  if (!existsSync(file)) scaffold(s);
  return new Promise((resolve, reject) => {
    const p = spawn("pencil", ["interactive", "--in", file, "--out", file], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    p.stdin.write(`batch_design(${JSON.stringify({ input: composeInput(s) })})\n`);
    p.stdin.write("save()\n");
    p.stdin.write("exit()\n");
    p.stdin.end();
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pencil exited ${code}`))));
    p.on("error", reject);
  });
}

function resolveTargets(arg: string | undefined): Section[] {
  if (!arg || arg === "all") return [...SECTIONS];
  const s = SECTIONS.find((x) => x.slug === arg);
  if (!s) throw new Error(`unknown section "${arg}" — known: ${SECTIONS.map((x) => x.slug).join(", ")}`);
  return [s];
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "list") {
    for (const s of SECTIONS) console.log(`${s.slug.padEnd(12)} → ${oref(s.nav)}  (${s.title})`);
    return;
  }
  const targets = resolveTargets(arg);
  if (cmd === "scaffold") {
    for (const s of targets) {
      const f = scaffold(s);
      console.log(`scaffolded ${relative(process.cwd(), f)}  imports.o=${importsField(f).o}`);
    }
    return;
  }
  if (cmd === "compose") {
    if (!(await isAuthed())) {
      console.error('Pencil CLI not authenticated. Run `pencil login` (or set PENCIL_CLI_KEY), then retry.');
      process.exitCode = 2;
      return;
    }
    for (const s of targets) {
      console.log(`composing ${s.slug}…`);
      await compose(s);
      console.log(`  done → ${relative(process.cwd(), penPath(s))}`);
    }
    return;
  }
  console.error("usage: node penmock.mts <scaffold|compose|list> [section|all]");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
