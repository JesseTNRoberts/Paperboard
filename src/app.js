/* ================= Paperboard: a storyboard for papers and grants =================
   One project folder holds everything as plain files. This page shows it as a board; Claude (in the desktop app) edits
   the same files and writes claude-reload.txt when it's done, and the board refreshes in place. */
const BOARD = "board.json", FLAG = "claude-reload.txt", OPENF = "storyboard-open.json", DIGEST = "digest.md", ADJUSTS = "Claude adjusts.md";
const BEATS_DIR = "Beats", NOTES_DIR = "Notes", BACKUP_DIR = "Backups";
const PROJECT_DIRS = ["Beats", "Notes", "References", "Claude", "Claude/skills", "code", "data/raw", "data/processed", "results", "figures", "export", "Backups"];
const CW = 230, CH = 150, STEP = 262, LANE_TOP = 110, LANE_H = 240, ACT_W = 4 * STEP + 40;
const SECTION_MARK = "BEATS IN ORDER";
const LANE_COLORS = ["#2b6e8f", "#b5651d", "#7d4d92", "#4f8a48", "#b02a4a", "#a5832a", "#6b6b6b", "#1f8a84"];

/* ---------- templates: a starting point; every section, stream and tag stays editable ---------- */
const STATUS_TAGS = [
  { id: "drafted", name: "Drafted", color: "#2b6e8f" }, { id: "needs-citation", name: "Needs citation", color: "#b5651d" },
  { id: "needs-data", name: "Needs data", color: "#a5832a" }, { id: "figure-stale", name: "Figure stale", color: "#7d4d92" },
  { id: "reviewer-flagged", name: "Reviewer flagged", color: "#b02a4a" }, { id: "done", name: "Done", color: "#4f8a48" }];
const STREAMS = ["Argument", "Experiments", "Figures & tables", "Literature", "Risks & limitations"];
const TEMPLATES = {
  paper: { name: "Paper", desc: "Abstract, Introduction, Related Work, Methods, Results, Discussion, Conclusion.",
    acts: ["Abstract", "Introduction", "Related Work", "Methods", "Results", "Discussion", "Conclusion"] },
  nih: { name: "Grant, NIH-style", desc: "Specific Aims, Significance, Innovation, Approach (a section per Aim), Preliminary Data, Timeline, Risks & Alternatives.",
    acts: ["Specific Aims", "Significance", "Innovation", "Approach: Aim 1", "Approach: Aim 2", "Approach: Aim 3", "Preliminary Data", "Timeline", "Risks & Alternatives"] },
  nsf: { name: "Grant, NSF-style", desc: "Project Summary, Intellectual Merit, Broader Impacts, Project Description sections, Data Management.",
    acts: ["Project Summary", "Intellectual Merit", "Broader Impacts", "Introduction & Objectives", "Background & Prior Work", "Research Plan", "Evaluation & Timeline", "Data Management"] },
  blank: { name: "Blank", desc: "One section and one stream. Add your own.", acts: ["Section 1"], streams: ["Main"] }
};
function boardFromTemplate(key) {
  const t = TEMPLATES[key] || TEMPLATES.blank;
  return { version: 1, template: key, acts: t.acts.map((name, i) => ({ id: "s" + (i + 1), name, x: i * ACT_W })),
    lanes: (t.streams || STREAMS).map((name, i) => ({ id: "l" + (i + 1), name, color: LANE_COLORS[i % LANE_COLORS.length] })),
    tags: STATUS_TAGS.map(x => ({ ...x })), beats: {}, notes: [], links: [], trash: {}, sectionNotes: {}, textScale: 1 };
}

/* ---------- small helpers ---------- */
const $ = id => document.getElementById(id);
const world = $("world"), vp = $("viewport"), linkg = $("linkg"), panel = $("panel"), hint = $("hint"), ctx = $("ctx");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
const today = () => stamp().slice(0, 10);
const nowLabel = () => { const s = stamp(); return s.slice(0, 13) + ":" + s.slice(13, 15); };
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmtN = n => n.toLocaleString("en-US");
function setStatus(t, err) { const s = $("status"); s.textContent = t; s.title = t; s.classList.toggle("err", !!err); }

/* where this copy of the app keeps its browser-side memory (the remembered folder, highlights, view):
   every file:// page shares one origin, so key it by the page's own path */
const PAGE = location.pathname;
const LS = {
  get(k, d) { try { const v = localStorage.getItem("rsb:" + PAGE + ":" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("rsb:" + PAGE + ":" + k, JSON.stringify(v)); } catch (e) {} }
};

/* ================= files ================= */
let root = null, beatsDir = null, notesDir = null;
let meta = null, metaBase = null, metaMtime = 0;   // board layout, and the file as last read or written here
let beats = [];      // live beats: {key (= ID), file, title, text, base, mtime}
let toDelete = [];   // beats marked TO DELETE: {key, file, title, text}
const queues = {};
function enqueue(k, fn) { const p = (queues[k] || Promise.resolve()).then(fn, fn); queues[k] = p.catch(() => {}); return p; }
let lock = Promise.resolve();   // reads and writes that must not interleave with a refresh from disk
function exclusive(fn) { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; }
let pending = 0;
function track(p) {
  pending++; setStatus("Saving…");
  return p.then(v => { if (--pending === 0) setStatus("All changes saved"); return v; },
    e => { pending--; setStatus("Couldn't write a file: " + (e && e.message || e), true); throw e; });
}
async function readText(dir, name) { return (await (await dir.getFileHandle(name)).getFile()).text(); }
async function readInfo(dir, name) { const f = await (await dir.getFileHandle(name)).getFile(); return { text: await f.text(), mtime: f.lastModified }; }
async function writeText(dir, name, text) {
  const h = await dir.getFileHandle(name, { create: true }), w = await h.createWritable();
  await w.write(text); await w.close();
  try { return (await h.getFile()).lastModified; } catch (e) { return 0; }
}
async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch (e) { return false; } }
async function subdir(path, create) { let d = root; for (const p of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p, { create: !!create }); return d; }
/* rename a file; never leaves the old name behind with different text, and never overwrites another file */
async function renameFile(dir, from, to, text) {
  if (from === to) return writeText(dir, to, text);
  const sameName = from.toLowerCase() === to.toLowerCase();
  if (!sameName && await exists(dir, to)) throw new Error(`“${to}” already exists`);
  const h = await dir.getFileHandle(from);
  if (h.move) {
    try {
      if (sameName) { const tmp = ".rename-" + Date.now() + ".md"; await h.move(tmp); await h.move(to); } else await h.move(to);
      const f = await (await dir.getFileHandle(to)).getFile();
      if (text != null && await f.text() !== text) return writeText(dir, to, text);
      return f.lastModified;
    } catch (e) { if (sameName) throw new Error("This browser can't change only the capitals of a file name. Change another letter too."); }
  } else if (sameName) throw new Error("This browser can't change only the capitals of a file name. Change another letter too.");
  const mt = await writeText(dir, to, text ?? await (await h.getFile()).text());
  await dir.removeEntry(from);
  return mt;
}

/* remembering projects (IndexedDB, keyed by this page's address): the most recent reconnects by itself */
function idb() { return new Promise((res, rej) => { const r = indexedDB.open("paperboard", 1); r.onupgradeneeded = () => r.result.createObjectStore("h"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function idbGet(k) { try { const d = await idb(); return await new Promise(r => { const q = d.transaction("h").objectStore("h").get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch (e) { return null; } }
async function idbPut(k, v) { try { const d = await idb(); await new Promise(res => { const t = d.transaction("h", "readwrite"); t.objectStore("h").put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) {} }
const RECENT = "recent:" + PAGE;
async function recentProjects() { return (await idbGet(RECENT)) || []; }
async function rememberProject(h) {
  if (window.__rsbNoRemember) return;   // the switch is for headless tests only
  const out = [{ name: h.name, handle: h, at: Date.now() }];
  for (const r of await recentProjects()) { try { if (!(await r.handle.isSameEntry(h))) out.push(r); } catch (e) {} }
  await idbPut(RECENT, out.slice(0, 8));
}

/* ================= opening or creating a project ================= */
function gateErr(m) { const g = $("gateerr"); if (!g) return; g.textContent = m; g.hidden = !m; }
const fsOK = () => !!window.showDirectoryPicker;
async function openFolder(h) {
  gateErr("");
  root = h; await rememberProject(h);
  if (!(await exists(root, BOARD))) return showTemplatePicker(null);
  await startProject();
}
async function startProject() {
  beatsDir = await subdir(BEATS_DIR, true); notesDir = await subdir(NOTES_DIR, true);
  $("projname").textContent = root.name; $("projname").title = root.name; document.title = root.name + " · Paperboard";
  await loadAll();
  $("gate").hidden = true;
}
async function renderGate() {
  const g = $("gatebody"), list = await recentProjects();
  g.innerHTML = `<p>A storyboard for papers and grants. Your project lives in a folder of plain files that Claude can read and change too, and the board refreshes when it does.</p>
    <button class="go" id="newproj">New project</button><button class="go secondary" id="pick">Open a project folder</button>
    <p id="gateerr" class="err" hidden></p>
    ${list.length ? `<label class="small">Recent</label><ul class="recent">${list.map((r, i) => `<li><button data-i="${i}"><span>${esc(r.name)}</span><small>${esc(fmtDay(r.at))}</small></button></li>`).join("")}</ul>` : ""}
    ${fsOK() ? "" : `<p class="err">This browser can't open folders. Use Chrome or Edge on a computer.</p>`}
    <p class="srcnote">Paperboard is free software (AGPL-3.0). <a href="https://github.com/JesseTNRoberts/Paperboard" target="_blank" rel="noopener">Source code</a>.</p>`;
  $("newproj").onclick = newProject;
  $("pick").onclick = async () => {
    if (!fsOK()) return gateErr("This browser can't open folders. Use Chrome or Edge.");
    try { await openFolder(await showDirectoryPicker({ id: "paperboard", mode: "readwrite" })); } catch (e) { if (e.name !== "AbortError") gateErr(e.message); }
  };
  g.querySelectorAll(".recent [data-i]").forEach(b => b.onclick = async () => {
    const r = list[+b.dataset.i];
    try { if ((await r.handle.requestPermission({ mode: "readwrite" })) === "granted") await openFolder(r.handle); else gateErr("Paperboard needs permission to edit that folder."); }
    catch (e) { gateErr(`Couldn't open “${r.name}”. It may have been moved or renamed; use Open a project folder. (${e.message})`); }
  });
}
const fmtDay = ms => { const d = new Date(ms); return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }); };
function templateCards(pick) {
  return `<div class="tpls" role="radiogroup" aria-label="Template">${Object.entries(TEMPLATES).map(([k, t]) => `<button class="tpl${k === pick ? " on" : ""}" role="radio" aria-checked="${k === pick}" data-t="${k}"><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></button>`).join("")}</div>`;
}
function wireTemplateCards(c, onPick) {
  c.querySelectorAll(".tpl").forEach(b => b.onclick = () => { onPick(b.dataset.t); c.querySelectorAll(".tpl").forEach(x => { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", x === b); }); });
}
async function createProjectFiles(tpl, offline) {   // the folders, board.json and (if asked) a copy of this app
  for (const d of PROJECT_DIRS) await subdir(d, true);
  if (await exists(root, BOARD)) throw new Error("This folder already has a board. Open it instead.");
  await writeText(root, BOARD, JSON.stringify(boardFromTemplate(tpl), null, 1));
  if (offline && /^https?:/.test(location.protocol)) { try { const r = await fetch(location.href, { cache: "no-store" }); if (r.ok) await writeText(root, "Paperboard.html", await r.text()); } catch (e) {} }
}
const offlineBox = () => /^https?:/.test(location.protocol) ? `<label class="check"><input type="checkbox" id="offline"> Also save a copy of the app in the folder (Paperboard.html), so the project opens without the internet.</label>` : "";
/* New project: pick where it goes, name it, pick a template; the app makes the folder */
async function newProject() {
  if (!fsOK()) return gateErr("This browser can't open folders. Use Chrome or Edge.");
  let parent;
  try { parent = await showDirectoryPicker({ id: "paperboard-parent", mode: "readwrite", startIn: "documents" }); } catch (e) { if (e.name !== "AbortError") gateErr(e.message); return; }
  let pick = "paper";
  const g = $("gatebody");
  g.innerHTML = `<p>The new project's folder goes inside <b>${esc(parent.name)}</b>.</p>
    <label class="small" for="pname">Project name</label><input id="pname" class="pname" placeholder="e.g. Low-cost sensor calibration" autocomplete="off">
    <label class="small">Template</label>${templateCards(pick)}
    <p class="help" style="font-size:12.5px;color:var(--ink-soft)">Sections, streams and tags stay editable, and you enter any page or word limits yourself. The folder gets Beats, Notes, References, Claude, code, data, results, figures, export and Backups.</p>
    ${offlineBox()}
    <button class="go" id="create">Create project</button><button class="go secondary" id="back">Back</button><p id="gateerr" class="err" hidden></p>`;
  wireTemplateCards(g, t => pick = t);
  const nameEl = $("pname"); nameEl.focus();
  nameEl.onkeydown = e => { if (e.key === "Enter") $("create").click(); };
  $("back").onclick = renderGate;
  $("create").onclick = async () => {
    const name = cleanTitle(nameEl.value);
    if (!name) { gateErr("Give the project a name."); return nameEl.focus(); }
    try {
      let dir = null; try { dir = await parent.getDirectoryHandle(name); } catch (e) {}
      if (dir && await exists(dir, BOARD)) throw new Error(`“${name}” in ${parent.name} is already a Paperboard project. Use Open a project folder instead.`);
      if (dir) { let n = 0; for await (const _ of dir.entries()) n++; if (n) throw new Error(`There's already a folder called “${name}” in ${parent.name}, with files in it. Choose another name.`); }
      dir ||= await parent.getDirectoryHandle(name, { create: true });
      root = dir; await createProjectFiles(pick, $("offline")?.checked); await rememberProject(dir);
      await startProject(); setStatus(`Created “${name}” in ${parent.name}.`);
    } catch (e) { gateErr(e.message || String(e)); }
  };
}
/* a folder with no board yet: offer the templates */
function showTemplatePicker() {
  let pick = "paper";
  const g = $("gatebody");
  g.innerHTML = `<p>“${esc(root.name)}” has no board yet. Pick a template to make it a project.</p>${templateCards(pick)}
    <p class="help" style="font-size:12.5px;color:var(--ink-soft)">This creates <code>board.json</code> and the project folders. Nothing already in the folder is changed.</p>
    ${offlineBox()}
    <button class="go" id="create">Create project</button><button class="go secondary" id="back">Back</button><p id="gateerr" class="err" hidden></p>`;
  wireTemplateCards(g, t => pick = t);
  $("back").onclick = () => { root = null; renderGate(); };
  $("create").onclick = async () => { try { await createProjectFiles(pick, $("offline")?.checked); await startProject(); } catch (e) { gateErr(e.message || String(e)); } };
}
(async () => {
  await renderGate();
  const last = (await recentProjects())[0]; if (!last) return;
  try { if ((await last.handle.queryPermission({ mode: "readwrite" })) === "granted") await openFolder(last.handle); } catch (e) {}
})();

/* ================= loading ================= */
async function loadAll() {
  setStatus("Loading…");
  const d = await readInfo(root, BOARD);
  try { meta = JSON.parse(d.text); } catch (e) { throw new Error("board.json isn't valid JSON. Fix it (or restore it from Backups) and reload."); }
  metaBase = d.text; metaMtime = d.mtime;
  normalizeMeta();
  hl = new Set(LS.get("highlights", []));
  editorTab = LS.get("editorTab", "beat"); editorSize = LS.get("editorSize", "popup"); editorView = LS.get("editorView", "write");
  beats = []; toDelete = [];
  await scanFolder(true);
  world.style.setProperty("--ts", meta.textScale);
  flagSeen = await stampOf(FLAG);
  renderAll();
  const v = LS.get("view", null);
  if (v && isFinite(v.s)) { view = v; applyView(); } else fitAll();
  scanLinked(true);
  updateRestore(); updateHlBtn(); updateConflictBtn();
  writeGeneratedSoon(300);
  if (J(meta) !== J(JSON.parse(metaBase))) saveMetaSoon();
  writeOpen(null);
  dailyBackup();
  setStatus(`Opened ${plural(beats.length, "beat")}`);
}
function normalizeMeta() {
  meta.acts ||= []; meta.lanes ||= []; meta.tags ||= meta.topics || []; delete meta.topics;
  if (!meta.acts.length) meta.acts.push({ id: "s1", name: "Section 1", x: 0 });
  if (!meta.lanes.length) meta.lanes.push({ id: "l1", name: "Main", color: LANE_COLORS[0] });
  meta.lanes.forEach((l, i) => { l.id ||= "l" + (i + 1); l.color ||= LANE_COLORS[i % LANE_COLORS.length]; });
  meta.acts.forEach((a, i) => { a.id ||= "s" + (i + 1); if (typeof a.x !== "number") a.x = i * ACT_W; });
  meta.tags.forEach((t, i) => { t.id ||= "t" + (i + 1); t.color ||= "#6b6b6b"; });
  meta.textScale ||= 1; meta.beats ||= {}; meta.trash ||= {}; meta.notes ||= []; meta.links ||= []; meta.sectionNotes ||= {};
}
/* read Beats/: new files, changed files, renames (same ID, new name), files marked TO DELETE */
let missingOnce = new Set();   // beats missing from one scan; removed only if still missing on the next (a file being rewritten can vanish briefly)
async function scanFolder(initial) {
  const entries = [];
  for await (const [name, h] of beatsDir.entries()) {
    if (h.kind !== "file") continue;
    const t = titleOfFile(name); if (!t) continue;
    entries.push({ name, h, ...t });
  }
  const byFile = new Map(beats.map(b => [b.file, b])), known = new Map(beats.map(b => [b.key, b]));
  const changed = new Set(), live = [], nowMarked = [], ids = new Map();
  let conflictsNow = 0;
  for (const e of entries) {
    const f = await e.h.getFile();
    const prev = byFile.get(e.name);
    if (!e.deleted && prev && f.lastModified === prev.mtime) { e.id = prev.key; e.text = null; e.f = f; }
    else { e.text = await f.text(); e.id = beatParts(e.text).id; e.f = f; }
    if (e.deleted) { nowMarked.push(e); continue; }
    live.push(e);
  }
  // every beat needs a unique ID: add one where it's missing, and give a copied file its own
  const needId = [];
  [...live, ...nowMarked].forEach(e => { if (!e.id) { needId.push(e); return; } (ids.get(e.id) || ids.set(e.id, []).get(e.id)).push(e); });
  ids.forEach(list => { if (list.length < 2) return; const kb = known.get(list[0].id); const keep = list.find(e => kb && e.name === kb.file && !e.deleted) || list.find(e => !e.deleted) || list[0]; list.forEach(e => { if (e !== keep) needId.push(e); }); });
  const used = new Set([...ids.keys(), ...Object.keys(meta.beats), ...Object.keys(meta.trash)]);
  for (const e of needId) {
    if (e.text == null) e.text = await e.f.text();
    let id; do id = newId(); while (used.has(id)); used.add(id);
    const text = setField(e.text, "ID", id);
    if (beatParts(text).id !== id) continue;   // couldn't add one (shouldn't happen); leave the file alone
    e.mtimeW = await writeText(beatsDir, e.name, text); e.text = text; e.id = id;
  }
  const seen = new Set();
  for (const e of live) {
    const key = e.id; if (seen.has(key)) continue; seen.add(key);
    let b = known.get(key);
    if (!b) {
      const text = e.text ?? await e.f.text();
      beats.push({ key, file: e.name, title: e.title, text, base: text, mtime: e.mtimeW || e.f.lastModified });
      if (!initial) changed.add(key);
      continue;
    }
    missingOnce.delete(key);
    if (b.file !== e.name) { b.file = e.name; b.title = e.title; changed.add(key); if (activeKey === key) writeOpen(b.file); }   // renamed, same ID
    if (e.text == null) continue;   // unchanged since we last looked
    const mt = e.mtimeW || e.f.lastModified;
    if (e.text === b.base) { b.mtime = mt; continue; }
    clearTimeout(textTimers[key]);
    const r = reconcileBeat(b, { text: e.text, mtime: mt }); changed.add(key);
    if (r === "conflict") conflictsNow++;
    else if (b.text !== b.base) saveTextSoon(b);   // merged with your typing: write the merged text back
  }
  // beats that are gone: marked TO DELETE, renamed away, or (briefly) missing
  const markedIds = new Set(nowMarked.map(e => e.id));
  beats = beats.filter(b => {
    if (seen.has(b.key)) return true;
    if (!markedIds.has(b.key) && !missingOnce.has(b.key) && !initial) { missingOnce.add(b.key); setTimeout(poll, 1500); return true; }   // check again before removing it
    missingOnce.delete(b.key);
    if (meta.beats[b.key]) { meta.trash[b.key] = { ...meta.beats[b.key] }; delete meta.beats[b.key]; }
    if (activeKey === b.key) closePanel();
    sel.delete(b.key); hl.delete(b.key); delete conflicts[b.key];
    return false;
  });
  toDelete = [];
  for (const e of nowMarked) toDelete.push({ key: e.id, file: e.name, title: e.title, text: e.text ?? await e.f.text() });
  layoutBeats();
  return { changed, conflictsNow };
}
function layoutBeats() {
  let maxX = Math.max(meta.acts[0]?.x ?? 0, ...beats.filter(b => meta.beats[b.key]).map(b => meta.beats[b.key].x));
  beats.forEach(b => {
    if (meta.beats[b.key]) return;
    if (meta.trash[b.key]) { meta.beats[b.key] = meta.trash[b.key]; delete meta.trash[b.key]; return; }   // came back: where it was
    maxX += STEP; meta.beats[b.key] = { x: Math.round(maxX), y: LANE_TOP + 45, tags: [] };   // new to the board: after the last card, in the first stream
  });
}

/* ================= saving ================= */
let metaTimer = null;
function saveMetaSoon() { clearTimeout(metaTimer); metaTimer = setTimeout(() => track(saveMeta()), 500); writeGeneratedSoon(); }
function saveMeta() {
  return enqueue("meta", () => exclusive(async () => {
    try {   // if Claude changed the layout since we last looked, merge rather than overwrite
      const d = await readInfo(root, BOARD);
      if (d.text !== metaBase) { mergeMetaFrom(d.text); refreshBoard(); }
    } catch (e) {}
    const s = JSON.stringify(meta, null, 1);
    if (s === metaBase) return;
    metaMtime = await writeText(root, BOARD, s); metaBase = s;
  }));
}
const textTimers = {};
function saveTextSoon(b) { writeGeneratedSoon(); clearTimeout(textTimers[b.key]); textTimers[b.key] = setTimeout(() => track(saveBeat(b)), 600); }
function saveBeat(b) {
  return enqueue("f:" + b.key, () => exclusive(async () => {
    if (conflicts[b.key] || !beats.includes(b)) return;   // waiting for your choice, or gone meanwhile
    if (await pullIfChanged(b)) { if (conflicts[b.key] || b.text === b.base) return; }
    if (b.text === b.base) return;
    const t = b.text;   // what's written is what counts as saved: typing during the write gets its own save
    b.mtime = await writeText(beatsDir, b.file, t); b.base = t;
    if (b.text !== t) saveTextSoon(b);
  }));
}
async function pullIfChanged(b) {   // before writing a beat: if its file changed on disk since we last looked, merge first
  let d; try { d = await readInfo(beatsDir, b.file); } catch (e) { return false; }
  if (d.text === b.base) { b.mtime = d.mtime; return false; }
  reconcileBeat(b, d); return true;
}
async function flushBeat(b) { clearTimeout(textTimers[b.key]); await track(saveBeat(b)); }

/* ================= beats: create, rename, mark for deletion, restore ================= */
const titleTaken = (t, except) => beats.some(x => x !== except && x.title.toLowerCase() === t.toLowerCase());
async function createBeat(x, y, type) {
  let title = "New beat", n = 2; while (titleTaken(title) || await exists(beatsDir, beatFile(title))) title = "New beat " + n++;
  let id; do id = newId(); while (meta.beats[id] || meta.trash[id] || beats.some(b => b.key === id));
  const text = newBeatText(id, type || typeForLane(laneIndexAt(y)));
  const b = { key: id, file: beatFile(title), title, text, base: text, mtime: 0 };
  meta.beats[id] = { x: Math.round(x), y: Math.round(y), tags: [] };
  await track(enqueue("f:" + id, async () => { b.mtime = await writeText(beatsDir, b.file, text); }));
  beats.push(b); buildCard(b); drawChrome(); saveMetaSoon();
  openBeat(id, true);
}
async function renameBeat(b, newTitle) {
  newTitle = cleanTitle(newTitle);
  if (!newTitle || newTitle === b.title) return false;
  if (titleTaken(newTitle, b)) { setStatus(`Another beat is already called “${newTitle}”.`, true); return false; }
  await flushBeat(b);
  if (conflicts[b.key]) { setStatus("Claude changed this beat at the same time. Choose a version first, then rename it.", true); return false; }
  const to = beatFile(newTitle);
  try {
    await track(enqueue("f:" + b.key, () => exclusive(async () => { const t = b.text; b.mtime = await renameFile(beatsDir, b.file, to, t); b.base = t; b.file = to; b.title = newTitle; if (b.text !== t) saveTextSoon(b); })));
  } catch (e) { setStatus(e.message || String(e), true); return false; }
  if (activeKey === b.key) writeOpen(b.file);
  paintCard(b); writeGeneratedSoon();
  return true;
}
async function deleteBeat(b) {   // never deletes: renames the file "TO DELETE - …" and hides the card
  await flushBeat(b);
  if (conflicts[b.key]) return setStatus(`Claude changed “${b.title}” at the same time. Choose a version first.`, true);
  let to = beatFile(DEL_PREFIX + b.title), n = 2; while (await exists(beatsDir, to)) to = beatFile(DEL_PREFIX + b.title + ` (${n++})`);
  try { await track(enqueue("f:" + b.key, () => exclusive(() => renameFile(beatsDir, b.file, to, b.text)))); }
  catch (e) { return setStatus(e.message || String(e), true); }
  hl.delete(b.key); saveHl();
  meta.trash[b.key] = { ...meta.beats[b.key] }; delete meta.beats[b.key];
  toDelete.push({ key: b.key, file: to, title: titleOfFile(to).title, text: b.text });
  beats = beats.filter(x => x !== b); sel.delete(b.key);
  cardEls[b.key]?.remove(); delete cardEls[b.key];
  updateRestore(); if (activeKey === b.key) closePanel(); drawLinks(); drawChrome(); saveMetaSoon();
}
async function deleteMany(list) {
  for (const b of list) await deleteBeat(b);
  clearSel();
  const label = list.length > 1 ? plural(list.length, "beat") : `“${list[0].title}”`;
  setStatus(`Marked ${label} for deletion. Restore brings ${list.length > 1 ? "them" : "it"} back.`);
}
function updateRestore() { const r = $("restore"); r.hidden = !toDelete.length; r.textContent = `Restore (${toDelete.length})`; }
async function restoreBeat(m) {
  let title = m.title.replace(/ \(\d+\)$/, ""); if (titleTaken(title) || await exists(beatsDir, beatFile(title))) title = m.title;
  if (titleTaken(title) || await exists(beatsDir, beatFile(title))) return setStatus(`A beat called “${title}” already exists. Rename it first.`, true);
  const to = beatFile(title);
  let mt = 0;
  try { await track(enqueue("f:" + m.key, () => exclusive(async () => { mt = await renameFile(beatsDir, m.file, to, null); }))); }
  catch (e) { return setStatus(e.message || String(e), true); }
  toDelete = toDelete.filter(x => x !== m);
  const text = await readText(beatsDir, to);
  const b = { key: m.key, file: to, title, text, base: text, mtime: mt };
  beats.push(b);
  if (!meta.beats[m.key]) meta.beats[m.key] = meta.trash[m.key] || (() => { const w = toWorld(innerWidth / 2, innerHeight / 2); return { x: Math.round(w.x - CW / 2), y: LANE_TOP + 45, tags: [] }; })();
  delete meta.trash[m.key];
  buildCard(b); drawLinks(); drawChrome(); updateRestore(); saveMetaSoon();
  setStatus(`Restored “${title}”.`);
}
function showRestore() {
  activeKey = null; setPanelMode(null);
  panel.innerHTML = `<header><div><div class="eyebrow">Marked for deletion</div><h2>Restore beats</h2></div><button class="x" aria-label="Close">✕</button></header>` +
    (toDelete.length ? `<p class="help">These files are still in Beats/, renamed “TO DELETE - …”. Restoring renames the file back and puts the card where it was. To delete one for good, delete its file yourself.</p>
      <ol id="r-list">${toDelete.map((m, i) => `<li><button data-i="${i}">${esc(m.title)}</button> <small>${esc(m.file)}</small></li>`).join("")}</ol>
      <div class="btnrow"><button id="r-all">Restore all ${toDelete.length}</button></div>`
      : `<p class="help">Nothing is marked for deletion.</p>`);
  panel.hidden = false; panel.querySelector(".x").onclick = closePanel;
  panel.querySelectorAll("#r-list [data-i]").forEach(btn => btn.onclick = async () => { await restoreBeat(toDelete[+btn.dataset.i]); showRestore(); });
  const all = $("r-all"); if (all) all.onclick = async () => { for (const m of [...toDelete]) await restoreBeat(m); showRestore(); };
}
$("restore").onclick = showRestore;
addEventListener("keydown", e => {   // ⌘⌫ marks the selected or open beats for deletion in one press (Restore undoes it)
  if (!(e.key === "Backspace" || e.key === "Delete") || !(e.metaKey || e.ctrlKey) || !meta) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;   // in a text box ⌘⌫ keeps its usual meaning
  const keys = sel.size ? [...sel].filter(k => cardEls[k]) : (activeKey ? [activeKey] : []);
  const list = keys.map(k => beats.find(b => b.key === k)).filter(Boolean);
  if (!list.length) return;
  e.preventDefault();
  deleteMany(list);
});

/* ================= generated files: digest, Claude adjusts, section notes ================= */
let genTimer = null;
function writeGeneratedSoon(ms = 1500) { clearTimeout(genTimer); genTimer = setTimeout(() => { if (root && meta) track(writeGenerated()).catch(() => {}); }, ms); }
const genLast = {};
const STAMP_RE = /^_(Generated|Rebuilt) by the storyboard [^\n]*_\n\n/m;
const stripStamp = t => t.replace(STAMP_RE, "");
async function writeIfChanged(dir, name, full) {   // rewritten only when the content changes: the time stamp alone never counts
  const key = stripStamp(full); if (genLast[name] === key) return;
  try { if (stripStamp(await readText(dir, name)) === key) { genLast[name] = key; return; } } catch (e) {}
  await writeText(dir, name, full); genLast[name] = key;
}
async function writeGenerated() {
  await enqueue("gen", async () => {
    const order = docOrder();
    await writeIfChanged(root, DIGEST, buildDigest(order));
    await writeAdjusts(order);
    await writeSectionNotes(order);
  });
}
function docOrder() {   // section, then left to right, then top to bottom
  const acts = sortedActs();
  return acts.map((a, i) => ({ act: a, beats: beats.filter(b => meta.beats[b.key] && actIndexAt(cx(b)) === i).sort((p, q) => meta.beats[p.key].x - meta.beats[q.key].x || meta.beats[p.key].y - meta.beats[q.key].y) }));
}
const bodyWords = b => { const p = beatParts(b.text); return p.type === "Paragraph" ? countWords(p.body) : 0; };
function buildDigest(order) {
  const flags = { adjust: [], empty: [], open: [], conflict: [], stale: [], missing: [] };
  let n = 0;
  const secs = order.map(({ act, beats: list }, si) => {
    const w = list.reduce((s, b) => s + bodyWords(b), 0);
    return `## ${si + 1}. ${act.name}\n\n_${plural(list.length, "beat")} · ${fmtN(w)} words in paragraphs_\n\n` + (list.length ? list.map((b, bi) => {
      n++;
      const m = meta.beats[b.key], p = beatParts(b.text), tg = tagsOf(m).map(id => tagOf(id)?.name).filter(Boolean);
      if (p.adj) flags.adjust.push(b.title);
      if (isBlankBeat(p)) flags.empty.push(b.title);
      if (/\[Open\]/i.test(b.text)) flags.open.push(b.title);
      if (conflicts[b.key]) flags.conflict.push(b.title);
      const li = linked[b.key]; if (li?.stale) flags.stale.push(`${b.title} (changed: ${li.why.join(", ")})`); if (li?.missing) flags.missing.push(b.title);
      const deps = [inputsOf(b.key).length ? "depends on: " + inputsOf(b.key).map(l => beatByKey(l.from).title).join(", ") : null, feedsOf(b.key).length ? "used by: " + feedsOf(b.key).map(l => beatByKey(l.to).title).join(", ") : null];
      const line = [p.type, meta.lanes[laneIndexAt(m.y)]?.name, tg.length ? "tags: " + tg.join(", ") : null, p.status ? "status: " + p.status : null, ...deps, BEATS_DIR + "/" + b.file].filter(Boolean).join(" · ");
      return `### ${si + 1}.${bi + 1} ${b.title}\n\n_${line}_\n\n${b.text.trim() || "(empty)"}\n`;
    }).join("\n") : "_No beats._\n");
  }).join("\n");
  const list = (h, a) => `- **${h} (${a.length}):** ${a.length ? a.join("; ") : "none"}`;
  return `# Digest\n\n_Generated by the storyboard ${nowLabel()}. Do not edit: it is rewritten automatically._\n\n` +
    `Every live beat in document order (section, then left to right, then top to bottom), with type, stream, tags, status and full text.\n\n` +
    `**Sections:** ${order.map(o => o.act.name).join(", ")}\n\n**Streams:** ${meta.lanes.map(l => l.name).join(", ")}\n\n**Tags:** ${meta.tags.map(t => t.name).join(", ") || "none"}\n\n` +
    `## Checks\n\n${[list("Beats with a Claude adjust", flags.adjust), list("Empty beats", flags.empty), list("Beats with [Open] items", flags.open),
      list("Stale figures and experiments (inputs or code changed after the output or last run)", flags.stale), list("Figures and tables whose output file doesn't exist", flags.missing),
      list("Beats waiting for the author's choice between two versions", flags.conflict), list("Marked for deletion", toDelete.map(m => m.title))].join("\n")}\n\n` + secs;
}
async function writeAdjusts(order) {
  const list = [];
  order.forEach(({ act, beats: l }) => l.forEach(b => { const a = beatParts(b.text).adj; if (a) list.push({ act, b, a }); }));
  const body = `# Claude adjusts\n\n_Rebuilt by the storyboard ${nowLabel()}. Do not edit: edit the adjust in the beat._\n\n` +
    `Every beat whose Claude adjust isn't empty, in document order (${list.length}).\n\n` +
    (list.length ? list.map(({ act, b, a }) => `## ${b.title}\n\n_${act.name} · ${BEATS_DIR}/${b.file}_\n\n${a}\n`).join("\n") : "No Claude adjusts right now.\n");
  await writeIfChanged(root, ADJUSTS, body);
}
/* each section's note in Notes/: your text above the BEATS IN ORDER line, the list below it */
const sectionNoteName = a => beatFile("Section - " + cleanTitle(a.name));
async function writeSectionNotes(order) {
  const before = J(meta.sectionNotes);
  for (const { act, beats: list } of order) {
    const want = sectionNoteName(act);
    let cur = meta.sectionNotes[act.id];
    if (cur && cur !== want && await exists(notesDir, cur) && !(await exists(notesDir, want))) {   // section renamed: rename its note
      try { await renameFile(notesDir, cur, want, null); } catch (e) { continue; }
    }
    meta.sectionNotes[act.id] = want;
    let desc = "", old = null;
    try { old = await readText(notesDir, want); const i = old.indexOf(SECTION_MARK); desc = (i < 0 ? old : old.slice(0, i)).replace(/\s+$/, ""); } catch (e) {}
    const body = (desc ? desc + "\n\n" : `# ${act.name}\n\nYour notes on this section go here, above the line below.\n\n`) +
      `${SECTION_MARK} (written by the storyboard; edit above this line, not below)\n\n` + (list.length ? list.map((b, i) => `${i + 1}. ${b.title}`).join("\n") : "(no beats yet)") + "\n";
    if (old !== body) await writeText(notesDir, want, body);
  }
  if (J(meta.sectionNotes) !== before) { clearTimeout(metaTimer); metaTimer = setTimeout(() => track(saveMeta()), 500); }
}

/* ================= backups (always into Backups/) ================= */
async function copyFolderInto(src, dst) {
  for await (const [name, h] of src.entries()) if (h.kind === "file" && !name.startsWith(".")) await writeText(dst, name, await (await h.getFile()).text());
}
async function snapshot(label) {   // board.json, every beat (including TO DELETE) and the notes
  const dir = await (await subdir(BACKUP_DIR, true)).getDirectoryHandle(label, { create: true });
  await writeText(dir, BOARD, JSON.stringify(meta, null, 1));
  await copyFolderInto(beatsDir, await dir.getDirectoryHandle(BEATS_DIR, { create: true }));
  await copyFolderInto(notesDir, await dir.getDirectoryHandle(NOTES_DIR, { create: true }));
  return dir;
}
async function dailyBackup() {
  try {
    const b = await subdir(BACKUP_DIR, true), label = today() + " daily";
    try { await b.getDirectoryHandle(label); return; } catch (e) {}
    await snapshot(label);
  } catch (e) { console.warn("daily backup failed", e); }
}
async function backupBoard(reason) {   // before a structural change to the layout
  try { const b = await subdir(BACKUP_DIR, true); await writeText(b, `board ${stamp()} before ${cleanTitle(reason)}.json`, JSON.stringify(meta, null, 1)); }
  catch (e) { console.warn("backup failed", e); }
}
async function backupConflict(b, label, text) {
  const d = await (await subdir(BACKUP_DIR, true)).getDirectoryHandle("Conflicts", { create: true });
  await writeText(d, `${stamp()} ${b.title} (${label}).md`, text);
}

/* ================= geometry ================= */
const sortedActs = () => [...meta.acts].sort((a, b) => a.x - b.x);
const cx = b => meta.beats[b.key].x + CW / 2;
function actIndexAt(x) { const a = sortedActs(); let i = 0; a.forEach((v, k) => { if (x >= v.x) i = k; }); return i; }
function laneIndexAt(y) { return Math.max(0, Math.min(meta.lanes.length - 1, Math.floor((y + CH / 2 - LANE_TOP) / LANE_H))); }
function worldW() { return Math.max(...beats.filter(b => meta.beats[b.key]).map(b => meta.beats[b.key].x + CW), ...meta.acts.map(a => a.x + ACT_W), ...meta.notes.map(n => n.x + 200), 1200) + 200; }
function worldH() { return LANE_TOP + meta.lanes.length * LANE_H + 60; }
const tagOf = id => meta.tags.find(t => t.id === id);
const tagsOf = m => { if (!m) return []; m.tags = (m.tags || []).filter(id => tagOf(id)); return m.tags; };
function inkOn(hex) { const h = (hex || "#888888").replace("#", ""); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.substr(i, 2), 16) / 255).map(c => c <= .03928 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4)); return .2126 * r + .7152 * g + .0722 * b > .4 ? "#1d2a2e" : "#ffffff"; }
const tagStyle = t => `--tc:${esc(t.color)};--tcf:${inkOn(t.color)}`;
const safeColor = c => /^#[0-9a-f]{3,8}$/i.test(c || "") ? c : "#6b6b6b";

/* ================= rendering ================= */
const ICONS = {   // 16×16, drawn with the text colour
  Paragraph: '<path d="M3 4h10M3 7h10M3 10h10M3 13h6"/>',
  Figure: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M4 11l3-3 2 2 2-3 2 4"/><circle cx="6" cy="6" r="1"/>',
  Table: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="M2.5 6.5h11M2.5 9.75h11M6.5 3v10"/>',
  Experiment: '<path d="M6 2.5h4M6.5 2.5v4l-3.5 6.5h10L9.5 6.5v-4"/><path d="M4.8 10h6.4"/>',
  References: '<path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3zM13 3.5H9.5A1 1 0 0 0 8.5 5M13 3.5v8H9.5a1 1 0 0 0-1 1"/>',
  Hypothesis: '<path d="M6 12.5h4M6.5 14h3M8 2.5a4 4 0 0 0-2.3 7.3c.4.3.6.8.6 1.2v.5h3.4V11c0-.4.2-.9.6-1.2A4 4 0 0 0 8 2.5z"/>',
  Aim: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.75"/><circle cx="8" cy="8" r=".6"/>',
  Note: '<path d="M3 3h10v6.5L9.5 13H3z"/><path d="M13 9.5H9.5V13"/>'
};
const icon = t => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[t] || ICONS.Paragraph}</svg>`;
const cardEls = {}, noteEls = {};
let hl = new Set();             // cards that changed on disk, highlighted until you clear them (remembered in this browser)
const flashKeys = new Set();    // cards to pulse once as they arrive
const conflicts = {};           // beat key -> {mine, theirs, merged, base} when you and Claude changed the same lines
function renderAll() {
  world.querySelectorAll(".band,.lane,.divider,.card,.note").forEach(e => e.remove());
  Object.keys(cardEls).forEach(k => delete cardEls[k]); Object.keys(noteEls).forEach(k => delete noteEls[k]);
  drawGrid(); beats.forEach(buildCard); meta.notes.forEach(buildNote);
  drawLinks(); drawChrome(); applyView(); updateHlBtn();
}
/* after a refresh from disk: update what's there in place, so nothing you're looking at or typing in is rebuilt */
function refreshBoard() {
  drawGrid();
  const live = new Set(beats.map(b => b.key));
  Object.keys(cardEls).forEach(k => { if (!live.has(k)) { cardEls[k].remove(); delete cardEls[k]; } });
  beats.forEach(b => { if (!meta.beats[b.key]) return; cardEls[b.key] ? paintCard(b) : buildCard(b); });
  const ids = new Set(meta.notes.map(n => n.id));
  Object.keys(noteEls).forEach(id => { if (!ids.has(id)) { noteEls[id].remove(); delete noteEls[id]; } });
  meta.notes.forEach(n => {
    const el = noteEls[n.id]; if (!el) return buildNote(n);
    el.style.left = n.x + "px"; el.style.top = n.y + "px"; el.className = "note " + (n.color || "") + (sel.has(n.id) ? " selected" : "");
    const ta = el.querySelector("textarea"); if (document.activeElement !== ta && ta.value !== (n.text || "")) ta.value = n.text || "";
  });
  world.style.setProperty("--ts", meta.textScale);
  drawLinks(); drawChrome(); updateHlBtn();
}
function drawGrid() {
  world.querySelectorAll(".band,.lane,.divider").forEach(e => e.remove());
  const acts = sortedActs(), W = worldW(), H = worldH();
  acts.forEach((a, i) => {
    const r = acts[i + 1] ? acts[i + 1].x : W;
    const d = document.createElement("div"); d.className = "band" + (i % 2 ? "" : " odd"); d.style.cssText = `left:${a.x}px;width:${r - a.x}px;height:${H}px`;
    world.insertBefore(d, world.firstChild);
    const dv = document.createElement("div"); dv.className = "divider"; dv.dataset.act = a.id; dv.style.cssText = `left:${a.x}px;height:${H}px`;
    dv.title = `Drag to move the start of ${a.name}`; world.appendChild(dv);
  });
  meta.lanes.forEach((l, i) => { const d = document.createElement("div"); d.className = "lane"; d.style.cssText = `top:${LANE_TOP + i * LANE_H}px;width:${W}px;border-top-color:${safeColor(l.color)}55`; world.appendChild(d); });
}
function drawChrome() {
  const order = docOrder();
  $("colhdr").innerHTML = order.map(({ act, beats: l }) => { const w = l.reduce((s, b) => s + bodyWords(b), 0);
    return `<div class="cl" data-act="${esc(act.id)}" title="Zoom to ${esc(act.name)}"><b>${esc(act.name)}</b><small>${plural(l.length, "beat")} · ${fmtN(w)} words</small></div>`; }).join("");
  $("rowhdr").innerHTML = meta.lanes.map((l, i) => `<div class="rl" data-i="${i}"><i style="background:${safeColor(l.color)}"></i>${esc(l.name)}</div>`).join("");
  $("legend").innerHTML = meta.tags.map(t => `<div class="row"><i style="background:${safeColor(t.color)}"></i>${esc(t.name)}</div>`).join("") || `<div class="row">No tags. Add them in Settings.</div>`;
  layoutHeaders(); placeHeaders();
}
$("colhdr").addEventListener("click", e => { const c = e.target.closest(".cl"); if (c) fitAct(c.dataset.act); });
function paintCard(b) {
  const el = cardEls[b.key], m = meta.beats[b.key]; if (!el || !m) return;
  const tg = tagsOf(m).map(tagOf), p = beatParts(b.text);
  el.className = "card" + (activeKey === b.key ? " active" : "") + (sel.has(b.key) ? " selected" : "")
    + (hl.has(b.key) ? " changed" : "") + (conflicts[b.key] ? " conflict" : "") + (flashKeys.has(b.key) ? " flash" : "");
  if (flashKeys.has(b.key)) { flashKeys.delete(b.key); setTimeout(() => el.classList.remove("flash"), 1900); }
  el.style.left = m.x + "px"; el.style.top = m.y + "px";
  el.style.borderColor = safeColor(meta.lanes[laneIndexAt(m.y)]?.color);
  const preview = p.ok ? (p.syn || p.body) : p.body;   // the synopsis, or the beat itself if there's none
  const li = linked[b.key], st = p.status || (p.type === "Experiment" ? p.fields.outcome || "" : "");
  if (li?.url) el.classList.add("hasimg");
  el.innerHTML = `<div class="ci"><div class="ty">${icon(p.type)}<span>${esc(p.type)}</span>${st ? `<span class="st">${esc(st)}</span>` : ""}</div><h3>${esc(b.title)}</h3>` +
    (li?.url ? `<img class="thumb" src="${esc(li.url)}" alt="" draggable="false">` : `<p>${esc(preview)}</p>`) + `</div>` +
    (tg.length || p.adj || li?.stale || li?.missing ? `<div class="tabs">${li?.stale ? `<span class="tab staletab" title="Changed since it was last made: ${esc(li.why.join(", "))}">Stale</span>` : ""}${li?.missing ? `<span class="tab staletab" title="The output file doesn't exist yet">No output</span>` : ""}${p.adj ? `<span class="tab adjtab" title="This beat has a Claude adjust">Claude adjust</span>` : ""}${tg.map(t => `<span class="tab" style="background:${safeColor(t.color)};color:${inkOn(t.color)}">${esc(t.name)}</span>`).join("")}</div>` : "");
  el.setAttribute("aria-label", `${p.type}: ${b.title}`);
}
function buildCard(b) {
  const el = document.createElement("div"); el.dataset.key = b.key; el.tabIndex = 0; el.setAttribute("role", "button");
  el.addEventListener("keydown", e => { if (e.key === "Enter") openBeat(b.key); });
  world.appendChild(el); cardEls[b.key] = el; paintCard(b);
}
const NOTE_COLORS = ["", "b", "p"];
function buildNote(n) {
  const el = document.createElement("div"); el.className = "note " + (n.color || ""); el.dataset.id = n.id;
  el.innerHTML = `<div class="grip"><button class="col" aria-label="Change note color">◐</button><button class="del" aria-label="Delete note">✕</button></div><textarea aria-label="Note text" placeholder="Idea…"></textarea>`;
  const ta = el.querySelector("textarea"); ta.value = n.text || "";
  ta.addEventListener("input", () => { const nn = meta.notes.find(x => x.id === n.id); if (nn) { nn.text = ta.value; saveMetaSoon(); } });
  ta.addEventListener("pointerdown", e => e.stopPropagation());
  el.querySelector(".col").onclick = e => { e.stopPropagation(); const nn = meta.notes.find(x => x.id === n.id); if (!nn) return; nn.color = NOTE_COLORS[(NOTE_COLORS.indexOf(nn.color || "") + 1) % 3]; el.className = "note " + nn.color; saveMetaSoon(); };
  const del = el.querySelector(".del");
  del.onclick = e => {
    e.stopPropagation();
    if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = "Delete?"; setTimeout(() => { del.classList.remove("armed"); del.textContent = "✕"; }, 2500); return; }
    meta.notes = meta.notes.filter(x => x.id !== n.id); meta.links = meta.links.filter(l => l.from !== n.id && l.to !== n.id);
    el.remove(); delete noteEls[n.id]; drawLinks(); saveMetaSoon();
  };
  el.style.left = n.x + "px"; el.style.top = n.y + "px";
  world.appendChild(el); noteEls[n.id] = el;
}
function centerOf(k) {
  if (meta.beats[k] && cardEls[k]) { const m = meta.beats[k]; return { x: m.x + CW / 2, y: m.y + CH / 2, w: CW, h: CH }; }
  const n = meta.notes.find(x => x.id === k); if (!n) return null; const h = noteEls[k] ? noteEls[k].offsetHeight : 140;
  return { x: n.x + 100, y: n.y + h / 2, w: 200, h };
}
let selLink = null;
function edgePoint(c, tx, ty) { const dx = tx - c.x, dy = ty - c.y; if (!dx && !dy) return c; const s = Math.min((c.w / 2 + 6) / Math.abs(dx || 1e-9), (c.h / 2 + 6) / Math.abs(dy || 1e-9)); return { x: c.x + dx * s, y: c.y + dy * s }; }
function drawLinks() {   // arrows to a beat marked for deletion stay in board.json and come back with it
  linkg.innerHTML = "";
  meta.links.forEach(l => {
    const a = centerOf(l.from), b = centerOf(l.to); if (!a || !b) return;
    const p1 = edgePoint(a, b.x, b.y), p2 = edgePoint(b, a.x, a.y);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 - Math.min(80, Math.hypot(p2.x - p1.x, p2.y - p1.y) * .12);
    const d = `M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}`;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g"); if (selLink === l.id) g.classList.add("sel");
    g.innerHTML = `<path class="hit" d="${d}"/><path d="${d}" marker-end="url(#arrow)"/>` + (l.label ? `<text x="${mx}" y="${(p1.y + p2.y) / 2 - 10}" text-anchor="middle">${esc(l.label)}</text>` : "");
    g.querySelector(".hit").addEventListener("pointerdown", e => { e.stopPropagation(); selLink = selLink === l.id ? null : l.id; $("delsel").hidden = !selLink; drawLinks(); });
    linkg.appendChild(g);
  });
}

/* ================= view (never touched by a refresh) ================= */
let view = { s: 0.4, x: 0, y: 0 }, HDR_TOP = 64; const ROWW = 150, HH = 64;
function layoutHeaders() {
  HDR_TOP = $("bar").getBoundingClientRect().bottom + 6;
  $("colhdr").style.top = HDR_TOP + "px"; $("rowhdr").style.top = HDR_TOP + HH + "px";
  if (!panel.classList.contains("editor")) panel.style.top = HDR_TOP + HH + 12 + "px";
  else setPanelMode(panel.classList.contains("full") ? "full" : panel.classList.contains("half") ? "half" : "popup");
}
function placeHeaders() {
  if (!meta) return;
  const acts = sortedActs(), W = worldW();
  $("colhdr").querySelectorAll(".cl").forEach(el => {
    const i = acts.findIndex(a => a.id === el.dataset.act); if (i < 0) return;
    const L = view.x + acts[i].x * view.s, R = view.x + (acts[i + 1] ? acts[i + 1].x : W) * view.s, w = el.offsetWidth;
    el.style.left = Math.min(Math.max(L, ROWW) + 12, R - w - 12) + "px";
    el.style.visibility = R < ROWW + 20 || L > innerWidth || R - Math.max(L, ROWW) < 60 ? "hidden" : "visible";
  });
  const top = HDR_TOP + HH;
  $("rowhdr").querySelectorAll(".rl").forEach(el => {
    const i = +el.dataset.i, y = view.y + (LANE_TOP + i * LANE_H) * view.s + 10 - top, h = LANE_H * view.s;
    el.style.top = Math.max(y, Math.min(10, y + h - el.offsetHeight - 10)) + "px";
  });
}
let viewSaveT = null;
function applyView() {
  world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
  world.dataset.zoom = view.s < 0.42 ? "far" : view.s < 0.85 ? "mid" : "near";
  world.style.setProperty("--zf", view.s < 0.42 ? Math.min(2.6, 0.42 / view.s).toFixed(2) : 1);
  vp.style.backgroundSize = `${24 * view.s}px ${24 * view.s}px`; vp.style.backgroundPosition = `${view.x}px ${view.y}px`;
  $("zoomlbl").textContent = Math.round(view.s * 100) + "%"; placeHeaders();
  clearTimeout(viewSaveT); viewSaveT = setTimeout(() => LS.set("view", view), 400);
}
function zoomAt(f, cx_, cy_) { const ns = Math.min(2.2, Math.max(0.05, view.s * f)); view.x = cx_ - (cx_ - view.x) * ns / view.s; view.y = cy_ - (cy_ - view.y) * ns / view.s; view.s = ns; applyView(); }
function fitBox(x1, y1, x2, y2) {
  const top = HDR_TOP + HH + 12, left = ROWW + 16, W = innerWidth - left - 20, H = innerHeight - top - 50;
  const s = Math.min(1.2, Math.max(0.05, Math.min(W / (x2 - x1), H / (y2 - y1))));
  view = { s, x: left + (W - (x2 - x1) * s) / 2 - x1 * s, y: top + (H - (y2 - y1) * s) / 2 - y1 * s }; applyView();
}
function fitAll() { const a = sortedActs(); fitBox((a[0] ? a[0].x : 0) - 20, LANE_TOP - 20, worldW(), worldH()); }
function fitAct(id) {
  const acts = sortedActs(), i = acts.findIndex(a => a.id === id); if (i < 0) return;
  const r = acts[i + 1] ? acts[i + 1].x : Math.max(acts[i].x + ACT_W, worldW() - 200);
  fitBox(acts[i].x - 20, LANE_TOP - 20, r + 20, worldH());
}
const toWorld = (x, y) => ({ x: (x - view.x) / view.s, y: (y - view.y) / view.s });

/* ================= pointer ================= */
const pts = new Map(); let gesture = null, connectMode = false, connectFrom = null;
const sel = new Set();
const elOf = k => cardEls[k] || noteEls[k];
const objOf = k => meta.beats[k] || meta.notes.find(n => n.id === k);
function paintSel() {
  document.querySelectorAll(".selected").forEach(e => e.classList.remove("selected"));
  sel.forEach(k => elOf(k)?.classList.add("selected"));
  if (!insertMode && !connectMode) {
    hint.hidden = sel.size < 2;
    if (sel.size > 1) hint.textContent = `${sel.size} selected. Drag one to move them together, right-click for actions, ⌘⌫ to mark them for deletion, Esc to clear.`;
  }
}
function toggleSel(k) { sel.has(k) ? sel.delete(k) : sel.add(k); paintSel(); }
function clearSel() { if (!sel.size) return; sel.clear(); paintSel(); }
vp.addEventListener("pointerdown", e => {
  if (e.target.closest(".chrome") || e.target.closest("#ctx") || !meta) return;
  hideCtx();
  if (e.pointerType === "mouse" && (e.button !== 0 || e.ctrlKey)) return;   // right-click and Control-click open the menu instead
  if (insertMode) { e.preventDefault(); const wx = toWorld(e.clientX, e.clientY).x; spaceKind === "remove" ? removeSpace(wx) : insertSpace(wx); return; }
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pts.size === 2) { const [a, b] = [...pts.values()]; gesture = { type: "pinch", d: Math.hypot(a.x - b.x, a.y - b.y) }; return; }
  const card = e.target.closest(".card"), note = e.target.closest(".note"), div = e.target.closest(".divider");
  if (div && !connectMode) {
    const a = meta.acts.find(x => x.id === div.dataset.act);
    gesture = { type: "divider", act: a, el: div, sx: e.clientX, start: a.x, moved: false };
  } else if (card || (note && e.target.closest(".grip") && !e.target.closest("button"))) {
    const isCard = !!card, el = card || note, k = isCard ? card.dataset.key : note.dataset.id;
    if ((e.shiftKey || e.metaKey) && !connectMode) { toggleSel(k); return; }
    if (!sel.has(k)) clearSel();
    const obj = objOf(k); if (!obj) return;
    const group = sel.size > 1 && sel.has(k) && !connectMode ? [...sel].map(x => ({ k: x, obj: objOf(x), el: elOf(x) })).filter(i => i.obj && i.el).map(i => ({ ...i, start: { x: i.obj.x, y: i.obj.y } })) : null;
    gesture = { type: "drag", isCard, k, el, obj, group, sx: e.clientX, sy: e.clientY, start: { x: obj.x, y: obj.y }, moved: false };
  } else if (!note && e.shiftKey) {
    const w0 = toWorld(e.clientX, e.clientY), box = document.createElement("div"); box.id = "marquee"; world.appendChild(box);
    gesture = { type: "marquee", w0, box, sx: e.clientX, sy: e.clientY, moved: false };
  } else if (!note) {
    gesture = { type: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    if (selLink) { selLink = null; $("delsel").hidden = true; drawLinks(); }
  }
  if (gesture) vp.setPointerCapture(e.pointerId);
});
vp.addEventListener("pointermove", e => {
  if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = gesture; if (!g) return;
  if (g.type === "pinch" && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); zoomAt(d / g.d, (a.x + b.x) / 2, (a.y + b.y) / 2); g.d = d; return; }
  const dx = e.clientX - g.sx, dy = e.clientY - (g.sy ?? e.clientY);
  if (Math.abs(dx) + Math.abs(dy) > 4) g.moved = true;
  if (g.type === "pan") { view.x = g.vx + dx; view.y = g.vy + dy; vp.classList.add("panning"); applyView(); }
  if (g.type === "divider" && g.moved) {
    const acts = sortedActs(), i = acts.indexOf(g.act);
    const lo = i > 0 ? acts[i - 1].x + 150 : -1e6, hi = acts[i + 1] ? acts[i + 1].x - 150 : 1e7;
    g.act.x = Math.round(Math.min(hi, Math.max(lo, g.start + dx / view.s)));
    g.el.classList.add("dragging"); g.el.style.left = g.act.x + "px";
    world.querySelectorAll(".band").forEach(b => b.remove()); redrawBands(); placeHeaders();
  }
  if (g.type === "marquee") {
    const w1 = toWorld(e.clientX, e.clientY), x = Math.min(g.w0.x, w1.x), y = Math.min(g.w0.y, w1.y);
    Object.assign(g.box.style, { left: x + "px", top: y + "px", width: Math.abs(w1.x - g.w0.x) + "px", height: Math.abs(w1.y - g.w0.y) + "px" });
    g.rect = { x, y, x2: Math.max(g.w0.x, w1.x), y2: Math.max(g.w0.y, w1.y) }; return;
  }
  if (g.type === "drag" && g.moved && g.group) {
    g.group.forEach(i => { i.obj.x = Math.round(i.start.x + dx / view.s); i.obj.y = Math.round(i.start.y + dy / view.s); i.el.classList.add("dragging"); i.el.style.left = i.obj.x + "px"; i.el.style.top = i.obj.y + "px"; });
    drawLinks(); return;
  }
  if (g.type === "drag" && g.moved && !connectMode) {
    g.obj.x = Math.round(g.start.x + dx / view.s); g.obj.y = Math.round(g.start.y + dy / view.s);
    g.el.classList.add("dragging"); g.el.style.left = g.obj.x + "px"; g.el.style.top = g.obj.y + "px"; drawLinks();
  }
});
function redrawBands() {
  const acts = sortedActs(), W = worldW(), H = worldH();
  acts.forEach((a, i) => { const r = acts[i + 1] ? acts[i + 1].x : W; const d = document.createElement("div"); d.className = "band" + (i % 2 ? "" : " odd"); d.style.cssText = `left:${a.x}px;width:${r - a.x}px;height:${H}px`; world.insertBefore(d, world.firstChild); });
}
function endPointer(e) {
  pts.delete(e.pointerId); vp.classList.remove("panning");
  const g = gesture; if (!g) return;
  if (g.type === "pinch") { if (pts.size === 0) gesture = null; return; }
  gesture = null;
  if (g.type === "divider") { g.el.classList.remove("dragging"); if (g.moved) { drawGrid(); beats.forEach(paintCard); drawChrome(); saveMetaSoon(); } return; }
  if (g.type === "marquee") {
    g.box.remove();
    if (g.rect) {
      const r = g.rect, hit = (x, y, w, h) => x < r.x2 && x + w > r.x && y < r.y2 && y + h > r.y;
      beats.forEach(b => { const m = meta.beats[b.key]; if (m && hit(m.x, m.y, CW, CH)) sel.add(b.key); });
      meta.notes.forEach(n => { if (hit(n.x, n.y, 200, 140)) sel.add(n.id); });
      paintSel();
    }
    return;
  }
  if (g.type === "pan" && !g.moved) clearSel();
  if (g.type === "drag" && g.group && g.moved) {
    g.group.forEach(i => { i.el.classList.remove("dragging"); const b = beats.find(x => x.key === i.k); if (b) paintCard(b); });
    drawChrome(); saveMetaSoon(); return;
  }
  if (g.type === "drag") {
    g.el.classList.remove("dragging");
    if (g.moved && !connectMode) { saveMetaSoon(); if (g.isCard) { const b = beats.find(x => x.key === g.k); if (b) paintCard(b); drawChrome(); if (activeKey === g.k) updateEditorEyebrow(b); } return; }
    if (connectMode) return pickForLink(g.k, g.el);
    if (g.isCard) openBeat(g.k);
  }
}
vp.addEventListener("pointerup", endPointer); vp.addEventListener("pointercancel", endPointer);
vp.addEventListener("wheel", e => {
  if (e.target.closest(".chrome") || e.target.tagName === "TEXTAREA") return; e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY); else { view.x -= e.deltaX; view.y -= e.deltaY; applyView(); }
}, { passive: false });
vp.addEventListener("dblclick", e => {
  if (e.target.closest(".card,.note,.chrome,.divider") || !meta) return;
  const w = toWorld(e.clientX, e.clientY); addNote(w.x - 100, w.y - 20);
});

/* ================= right-click menus ================= */
function hideCtx() { ctx.hidden = true; }
vp.addEventListener("contextmenu", e => {
  if (e.target.closest(".chrome")) return;
  e.preventDefault(); if (!meta) return;
  if (insertMode) setInsert(false); if (connectMode) setConnect(false);
  const w = toWorld(e.clientX, e.clientY);
  const card = e.target.closest(".card"), note = e.target.closest(".note"), div = e.target.closest(".divider");
  const it = (id, label, cls = "") => `<button class="it ${cls}" role="menuitem" data-a="${id}">${esc(label)}</button>`;
  const tagRow = list => meta.tags.length ? `<div class="row"><span>Tags</span>${meta.tags.map(t => { const n = list.filter(b => tagsOf(meta.beats[b.key]).includes(t.id)).length; return `<button class="tg${n === list.length ? " on" : n ? " some" : ""}" data-tag="${esc(t.id)}" style="${tagStyle(t)}">${esc(t.name)}</button>`; }).join("")}</div>` : "";
  const sizeRow = `<div class="row"><span>Card text</span><button data-ts="-1" aria-label="Smaller card text">A−</button><button data-ts="1" aria-label="Larger card text">A+</button><span>${Math.round(meta.textScale * 100)}%</span></div>`;
  let html = "", acts = {};
  if (card) {
    const k = card.dataset.key; if (!sel.has(k)) clearSel();
    const targets = sel.size > 1 && sel.has(k) ? [...sel].filter(x => cardEls[x]) : [k];
    const list = targets.map(x => beats.find(b => b.key === x)).filter(Boolean);
    if (!list.length) return;
    if (list.length > 1) html = `<div class="h">${list.length} beats selected</div>` + tagRow(list) + sizeRow + "<hr>" + it("del", `Mark ${list.length} beats for deletion`, "danger") + it("clear", "Clear selection");
    else html = `<div class="h">${esc(list[0].title)}</div>` + it("open", "Open") + it("full", "Open full screen") + it("arrow", "Draw arrow from here") + tagRow(list) + sizeRow + "<hr>" + it("del", "Mark for deletion", "danger");
    acts = {
      open: () => openBeat(k), full: () => { editorSize = "full"; LS.set("editorSize", "full"); openBeat(k); },
      arrow: () => { setConnect(true); pickForLink(k, card); }, clear: clearSel,
      del: () => deleteMany(list),
      tag: id => {   // all selected have it: remove it from all; otherwise add it to all
        const all = list.every(b => tagsOf(meta.beats[b.key]).includes(id));
        list.forEach(b => { const tg = tagsOf(meta.beats[b.key]); meta.beats[b.key].tags = all ? tg.filter(x => x !== id) : [...new Set([...tg, id])]; paintCard(b); });
        if (activeKey && list.some(b => b.key === activeKey)) syncEditorTags();
        saveMetaSoon();
      }
    };
  } else if (note) {
    const id = note.dataset.id;
    html = `<div class="h">Sticky note</div>` + it("arrow", "Draw arrow from here") + it("ncolor", "Change color") + "<hr>" + it("ndel", "Delete note", "danger");
    acts = { arrow: () => { setConnect(true); pickForLink(id, note); }, ncolor: () => note.querySelector(".col").click(),
      ndel: () => { const d = note.querySelector(".del"); d.click(); d.click(); } };
  } else if (div) {
    const a = meta.acts.find(x => x.id === div.dataset.act);
    html = `<div class="h">Start of ${esc(a?.name || "section")}</div>` + it("zoom", "Zoom to this section") + it("acts", "Sections, streams & tags…");
    acts = { acts: showSettings, zoom: () => fitAct(a.id) };
  } else {
    const lane = laneIndexAt(w.y - CH / 2), y = LANE_TOP + lane * LANE_H + 45;
    html = it("beat", "New beat here") + it("note", "Add note here") +
      `<div class="row"><span>Insert space here</span>${[1, 2, 4].map(n => `<button data-gap="${n}">${n} card${n > 1 ? "s" : ""}</button>`).join("")}</div>` +
      `<div class="row"><span>Remove space here</span>${[1, 2, 4].map(n => `<button data-ungap="${n}">${n} card${n > 1 ? "s" : ""}</button>`).join("")}</div>` +
      "<hr>" + it("fit", "Whole document") + (sel.size ? it("clear", "Clear selection") : "");
    acts = {
      beat: () => createBeat(w.x - CW / 2, y), note: () => addNote(w.x - 100, w.y - 20),
      fit: fitAll, clear: clearSel,
      gap: n => { insertCards = n; insertSpace(w.x); }, ungap: n => { insertCards = n; removeSpace(w.x); }
    };
  }
  ctx.innerHTML = html; ctx.hidden = false;
  ctx.style.left = Math.max(4, Math.min(e.clientX, innerWidth - ctx.offsetWidth - 8)) + "px";
  ctx.style.top = Math.max(4, Math.min(e.clientY, innerHeight - ctx.offsetHeight - 8)) + "px";
  ctx.querySelectorAll("[data-a]").forEach(btn => btn.onclick = () => {
    const a = btn.dataset.a;
    if (a === "del" && !btn.classList.contains("armed")) { btn.classList.add("armed"); btn.textContent = "Click again to confirm"; return; }
    hideCtx(); acts[a] && acts[a]();
  });
  ctx.querySelectorAll("[data-ts]").forEach(btn => btn.onclick = () => {
    meta.textScale = Math.round(Math.max(0.6, Math.min(2.5, meta.textScale + +btn.dataset.ts * 0.1)) * 10) / 10;
    world.style.setProperty("--ts", meta.textScale); btn.parentElement.lastElementChild.textContent = Math.round(meta.textScale * 100) + "%"; saveMetaSoon();
  });
  ctx.querySelectorAll("[data-tag]").forEach(btn => btn.onclick = () => { acts.tag(btn.dataset.tag); hideCtx(); });
  ctx.querySelectorAll("[data-gap]").forEach(btn => btn.onclick = () => { hideCtx(); acts.gap(+btn.dataset.gap); });
  ctx.querySelectorAll("[data-ungap]").forEach(btn => btn.onclick = () => { hideCtx(); acts.ungap(+btn.dataset.ungap); });
  ctx.querySelector("button")?.focus();
});
addEventListener("pointerdown", e => { if (!ctx.hidden && !e.target.closest("#ctx")) hideCtx(); }, true);
vp.addEventListener("wheel", hideCtx, { passive: true });

/* ================= insert and remove space ================= */
let insertMode = false, insertCards = 2, spaceKind = "insert";
function setInsert(on, kind = "insert") {
  insertMode = on; spaceKind = kind; if (on && connectMode) setConnect(false);
  ["insert", "remove"].forEach(k => { const b = $(k), a = on && kind === k; b.classList.toggle("on", a); b.setAttribute("aria-pressed", a); });
  vp.classList.toggle("inserting", on); $("guide").hidden = true;
  hint.hidden = !on;
  if (on) {
    hint.innerHTML = `${kind === "remove" ? "Click where empty space starts to remove up to" : "Click where you want a gap of"} <select id="gapsize" style="padding:2px 4px;border:1px solid var(--edge);border-radius:3px;background:var(--card)">${[1, 2, 3, 4, 6].map(n => `<option value="${n}"${n === insertCards ? " selected" : ""}>${n} card${n > 1 ? "s" : ""}</option>`).join("")}</select> <button id="gapcancel" class="btn" style="border-color:var(--edge)">Cancel</button>`;
    $("gapsize").onchange = e => insertCards = +e.target.value;
    $("gapcancel").onclick = () => setInsert(false);
  }
}
function shiftAfter(x, dx, inclusive) {
  beats.forEach(b => { const m = meta.beats[b.key]; if (m && (inclusive ? m.x >= x : m.x + CW / 2 >= x)) m.x += dx; });
  meta.notes.forEach(n => { if (inclusive ? n.x >= x : n.x + 100 >= x) n.x += dx; });
  meta.acts.forEach(a => { if (a.x > x) a.x += dx; });
}
function insertSpace(x) {
  shiftAfter(x, insertCards * STEP, false); setInsert(false);
  refreshBoard(); saveMetaSoon();
  setStatus(`Opened a gap of ${plural(insertCards, "card")}`);
}
function removeSpace(x) {   // closes up empty space to the right of x; never moves anything onto a card or note
  const want = insertCards * STEP;
  const items = [...beats.filter(b => meta.beats[b.key]).map(b => [meta.beats[b.key].x, meta.beats[b.key].x + CW]), ...meta.notes.map(n => [n.x, n.x + 200])];
  let start = x; items.forEach(([l, r]) => { if (l < start && r > start) start = r; });
  let limit = Infinity;
  items.forEach(([l]) => { if (l >= start) limit = Math.min(limit, l - start); });
  meta.acts.forEach(v => { if (v.x > start) limit = Math.min(limit, v.x - start); });
  setInsert(false);
  const gap = Math.round(Math.min(want, limit === Infinity ? want : limit));
  if (gap < 10) return setStatus("No empty space to remove there.", true);
  shiftAfter(start, -gap, true);
  refreshBoard(); saveMetaSoon();
  const cards = Math.round(gap / STEP * 10) / 10;
  setStatus(gap < want ? `Removed ${cards} card${cards === 1 ? "" : "s"} of space (stopped at the next card or section line)` : `Removed ${cards} card${cards === 1 ? "" : "s"} of space`);
}
$("insert").onclick = () => setInsert(!(insertMode && spaceKind === "insert"), "insert");
$("remove").onclick = () => setInsert(!(insertMode && spaceKind === "remove"), "remove");
vp.addEventListener("pointermove", e => {
  if (!insertMode) return;
  const g = $("guide"); g.hidden = false; g.style.left = toWorld(e.clientX, e.clientY).x + "px"; g.style.height = worldH() + "px";
});

/* ================= arrows and sticky notes ================= */
function setConnect(on) {
  if (on && insertMode) setInsert(false);
  connectMode = on; connectFrom = null; document.querySelectorAll(".picked").forEach(x => x.classList.remove("picked"));
  $("connect").classList.toggle("on", on); $("connect").setAttribute("aria-pressed", on);
  hint.hidden = !on; hint.textContent = "An arrow is a dependency. Click what comes first (e.g. the experiment), then what depends on it (the figure).";
}
function pickForLink(k, el) {
  if (!connectFrom) { connectFrom = k; el.classList.add("picked"); hint.textContent = "Now click what depends on it."; return; }
  if (connectFrom === k) return setConnect(false);
  const from = connectFrom;
  hint.innerHTML = `<label for="lbl">Label (optional) </label><input id="lbl" style="padding:3px 6px;border:1px solid var(--edge);border-radius:3px;background:var(--card)"> <button id="lblok" class="btn" style="border-color:var(--edge)">Add arrow</button>`;
  const inp = $("lbl"); inp.focus();
  const done = () => { meta.links.push({ id: uid("a"), from, to: k, label: inp.value.trim() }); drawLinks(); saveMetaSoon(); setConnect(false); if (activeKey && (activeKey === from || activeKey === k)) wireDeps(activeKey); };
  $("lblok").onclick = done; inp.onkeydown = ev => { if (ev.key === "Enter") done(); if (ev.key === "Escape") setConnect(false); };
}
$("connect").onclick = () => setConnect(!connectMode);
$("delsel").onclick = () => { meta.links = meta.links.filter(l => l.id !== selLink); selLink = null; $("delsel").hidden = true; drawLinks(); saveMetaSoon(); };
function addNote(x, y) {
  if (x === undefined) { const w = toWorld(innerWidth / 2, innerHeight / 2); x = w.x - 100; y = w.y - 70; }
  const n = { id: uid("n"), x: Math.round(x), y: Math.round(y), text: "", color: "" };
  meta.notes.push(n); buildNote(n); saveMetaSoon(); setTimeout(() => noteEls[n.id]?.querySelector("textarea").focus(), 30);
}
$("addnote").onclick = () => addNote();
$("newbeat").onclick = () => { const w = toWorld(innerWidth / 2, innerHeight / 2); createBeat(w.x - CW / 2, LANE_TOP + laneIndexAt(w.y - CH / 2) * LANE_H + 45); };
addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === "Escape") { if (!ctx.hidden) hideCtx(); else if (sel.size && !typing) clearSel(); else if (insertMode) setInsert(false); else if (connectMode) setConnect(false); else if (!panel.hidden) closePanel(); }
  if ((e.key === "Delete" || e.key === "Backspace") && selLink && !typing && !e.metaKey && !e.ctrlKey) $("delsel").click();
});

/* ================= Markdown preview: file text is never treated as HTML ================= */
const safeUrl = u => { u = String(u || "").trim(); return /^(https?:|mailto:|#|\.{0,2}\/|[^:]*$)/i.test(u) ? u : "#"; };
if (window.marked) {
  try {
    window.marked.use({ renderer: {
      html(x) { return esc(typeof x === "object" ? (x.raw ?? x.text) : x); },   // raw HTML in a beat shows as text
      link(href, title, text) { if (typeof href === "object") ({ href, title, text } = href); return `<a href="${esc(safeUrl(href))}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`; },
      image(href, title, text) { if (typeof href === "object") ({ href, title, text } = href); const rp = relPath(href); return rp ? `<img data-path="${esc(rp)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""}>` : `<img src="${esc(safeUrl(href))}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""}>`; }
    } });
  } catch (e) { console.warn("marked setup failed", e); }
}
function fallbackMd(src) {   // used when the Markdown library didn't load
  const inline = s => esc(s).replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, src) => { const rp = relPath(src.replace(/&amp;/g, "&")); return rp ? `<img data-path="${esc(rp)}" alt="${alt}">` : m; }).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  return String(src || "").split(/\n{2,}/).map(p => {
    const h = p.match(/^(#{1,6})\s+(.*)$/); if (h) return `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    if (/^\s*[-*] /.test(p)) return "<ul>" + p.split("\n").map(l => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("") + "</ul>";
    if (/^\s*> /.test(p)) return `<blockquote>${inline(p.replace(/^\s*> ?/gm, "")).replace(/\n/g, "<br>")}</blockquote>`;
    return `<p>${inline(p).replace(/\n/g, "<br>")}</p>`;
  }).join("");
}
function renderMd(src) {
  if (window.marked) { try { return window.marked.parse(src || "", { breaks: true, gfm: true }); } catch (e) {} }
  return fallbackMd(src);
}

/* ================= panels ================= */
let activeKey = null, editorTab = "beat", editorSize = "popup", editorView = "write";
function closePanel() {
  if (code) { flushCode(); code = null; }
  if (panel.contains(document.activeElement)) document.activeElement.blur();
  panel.hidden = true; panel.classList.remove("conflictp"); setPanelMode(null);
  const k = activeKey; activeKey = null; const b = beats.find(x => x.key === k); if (b) paintCard(b);
  if (k) writeOpen(null);
}
function setPanelMode(mode) {   // null for ordinary panels, or an editor size
  panel.classList.remove("editor", "half", "full", "pdfp");
  if (mode) { panel.classList.add("editor"); if (mode !== "popup") panel.classList.add(mode); }
  panel.style.top = mode === "full" ? "0px" : (HDR_TOP + HH + (mode === "half" ? 0 : 12)) + "px";
}
const PARTS = [["beat", "body", "f-text"], ["syn", "syn", "f-syn"], ["adj", "adj", "f-adj"], ["notes", "notes", "f-notes"]];
function eyebrowOf(b) { const m = meta.beats[b.key]; if (!m) return ""; return `${sortedActs()[actIndexAt(cx(b))]?.name || ""} · ${meta.lanes[laneIndexAt(m.y)]?.name || ""}`; }
function updateEditorEyebrow(b) { const e = $("f-eyebrow"); if (e) e.textContent = eyebrowOf(b); }
function syncEditorTags() {
  const b = beats.find(x => x.key === activeKey), box = $("f-tags"); if (!b || !box) return;
  const tg = tagsOf(meta.beats[b.key]);
  box.querySelectorAll("[data-tag]").forEach(btn => { const on = tg.includes(btn.dataset.tag); btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on); });
}
function openBeat(k, focusTitle) {
  if (code && code.key !== k) { flushCode(); code = null; }
  const prev = activeKey; activeKey = k;
  const pb = beats.find(x => x.key === prev); if (pb) paintCard(pb);
  const b = beats.find(x => x.key === k); if (!b) return; paintCard(b);
  panel.classList.remove("conflictp");
  if (conflicts[k]) return showConflict(b);
  writeOpen(b.file);
  const m = meta.beats[k], p = beatParts(b.text), ttab = typeTabName(p.type), ctab = hasCodeTab(p);
  const sizeBtn = (v, l) => `<button data-size="${v}" class="${editorSize === v ? "on" : ""}">${l}</button>`;
  panel.innerHTML = `<header><div class="eyebrow" id="f-eyebrow">${esc(eyebrowOf(b))}</div>
      <div class="hdrright"><div class="sizes" role="group" aria-label="Editor size">${sizeBtn("popup", "Popup")}${sizeBtn("half", "Half")}${sizeBtn("full", "Full")}</div><button class="x" aria-label="Close">✕</button></div></header>
    <label for="f-title">Title</label><input type="text" id="f-title" class="title" value="${esc(b.title)}" spellcheck="true">
    <div class="meta3"><div class="ty"><label for="f-type">Type</label><select id="f-type">${BEAT_TYPES.map(t => `<option${t === p.type ? " selected" : ""}>${t}</option>`).join("")}</select></div>
      <div><label for="f-status">Status</label><input type="text" id="f-status" value="${esc(p.status)}" placeholder="e.g. drafted, running"></div></div>
    <div class="deps" id="f-deps"></div>
    <span class="lbl">Tags</span><div class="tagpick" id="f-tags">${meta.tags.map(t => `<button data-tag="${esc(t.id)}" class="${tagsOf(m).includes(t.id) ? "on" : ""}" style="${tagStyle(t)}" aria-pressed="${tagsOf(m).includes(t.id)}">${esc(t.name)}</button>`).join("") || `<span class="help" style="margin:0">Add tags in Settings.</span>`}</div>
    <div class="etabs" role="tablist" aria-label="Beat sections">
      <button role="tab" data-tab="beat">Beat</button><button role="tab" data-tab="syn">Synopsis</button><button role="tab" data-tab="adj">Claude adjust<span class="dot" id="f-adjdot"${p.adj ? "" : " hidden"}></span></button><button role="tab" data-tab="notes">Notes</button>${ttab ? `<button role="tab" data-tab="type" class="ttab">${esc(ttab)}</button>` : ""}${ctab ? `<button role="tab" data-tab="code" class="ttab">Code</button>` : ""}
    </div>
    <div class="pane" data-pane="beat">
      <div class="mdwrap" id="f-wrap" style="flex-direction:column;border-top:1px solid var(--edge)">
      <div class="mdbar" role="toolbar" aria-label="Formatting" style="border:0;border-bottom:1px solid var(--edge)">
        <button data-md="bold" title="Bold (⌘B)"><b>B</b></button><button data-md="italic" title="Italic (⌘I)"><i>I</i></button>
        <button data-md="h2" title="Heading">H</button><button data-md="ul" title="Bulleted list">•</button><button data-md="ol" title="Numbered list">1.</button>
        <button data-md="quote" title="Quote">❝</button><button data-md="cite" title="Citation [@key]">[@]</button>
        <span class="grow"></span>
        <button data-view="write">Write</button><button data-view="split">Side by side</button><button data-view="preview">Preview</button>
        <span class="wc" id="f-wc"></span></div>
      <div style="display:flex;flex:1;min-height:0" id="f-split"><textarea id="f-text" class="md" aria-label="Beat text" placeholder="Write this beat…">${esc(p.body)}</textarea><div class="mdprev" id="f-prev"></div></div>
      </div>
    </div>
    <div class="pane" data-pane="syn" hidden><div class="mdwrap" style="border-top:1px solid var(--edge)"><textarea id="f-syn" class="md" aria-label="Synopsis" placeholder="One or two sentences. The first sentence must work alone as a one-liner.">${esc(p.syn)}</textarea></div></div>
    <div class="pane" data-pane="adj" hidden><div class="mdwrap adjwrap" style="border-top:1px solid var(--edge)"><textarea id="f-adj" class="md" aria-label="Claude adjust" placeholder="What you want Claude to do with this beat. Every adjust is collected in Claude adjusts.md.">${esc(p.adj)}</textarea></div></div>
    <div class="pane" data-pane="notes" hidden><div class="mdwrap" style="border-top:1px solid var(--edge)"><textarea id="f-notes" class="md" aria-label="Notes" placeholder="Decisions, finished Claude adjusts, earlier versions, reviewer comments.">${esc(p.notes)}</textarea></div></div>
    ${ttab ? `<div class="pane" data-pane="type" hidden>${typePaneHtml(p)}</div>` : ""}
    ${ctab ? `<div class="pane" data-pane="code" hidden>${codePaneHtml()}</div>` : ""}
    <div class="foot"><button id="f-del" class="danger">Mark for deletion</button><span class="help">Every tab saves as you type. ${esc(BEATS_DIR + "/" + b.file)}</span></div>`;
  panel.hidden = false; setPanelMode(editorSize); panel.dataset.type = p.type;
  panel.querySelector(".x").onclick = closePanel;
  wireDeps(k);
  const ta = $("f-text"), prevEl = $("f-prev"), split = $("f-split");
  const refresh = () => { $("f-wc").textContent = fmtN(countWords(ta.value)) + " words"; if (split.dataset.view !== "write") { prevEl.innerHTML = renderMd(ta.value); resolveImages(prevEl); } };
  const setView = v => {
    if (v === "split" && editorSize === "popup") v = "write";
    editorView = v; split.dataset.view = v; LS.set("editorView", v);
    prevEl.hidden = v === "write"; ta.hidden = v === "preview"; prevEl.style.borderLeft = v === "split" ? "1px solid var(--edge)" : "0";
    panel.querySelectorAll("[data-view]").forEach(x => x.classList.toggle("on", x.dataset.view === v));
    panel.querySelector('[data-view="split"]').hidden = editorSize === "popup";
    refresh();
  };
  panel.querySelectorAll("[data-size]").forEach(btn => btn.onclick = () => {
    editorSize = btn.dataset.size; LS.set("editorSize", editorSize);
    panel.querySelectorAll("[data-size]").forEach(x => x.classList.toggle("on", x === btn));
    setPanelMode(editorSize); setView(editorView === "split" && editorSize === "popup" ? "write" : editorView);
  });
  panel.querySelectorAll("[data-view]").forEach(btn => btn.onclick = () => setView(btn.dataset.view));
  setView(editorView);
  const edit = fn => {   // apply a formatting change to the selection, then save like any other edit
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const r = fn(v.slice(s, e), v, s, e); ta.focus();
    ta.setRangeText(r.text, r.from ?? s, r.to ?? e, "end");
    if (r.selStart != null) ta.setSelectionRange(r.selStart, r.selEnd);
    ta.dispatchEvent(new Event("input"));
  };
  const wrapSel = m2 => edit((sl, v, s) => sl ? { text: m2 + sl + m2 } : { text: m2 + m2, selStart: s + m2.length, selEnd: s + m2.length });
  const prefixLines = pf => edit((sl, v, s, e) => {
    const ls = v.lastIndexOf("\n", s - 1) + 1, le = v.indexOf("\n", e), end = le < 0 ? v.length : le;
    return { text: v.slice(ls, end).split("\n").map((l, i) => (typeof pf === "function" ? pf(i) : pf) + l).join("\n"), from: ls, to: end };
  });
  const actions = { bold: () => wrapSel("**"), italic: () => wrapSel("*"), h2: () => prefixLines("## "), ul: () => prefixLines("- "), ol: () => prefixLines(i => (i + 1) + ". "), quote: () => prefixLines("> "),
    cite: () => edit((sl, v, s) => ({ text: `[@${sl}]`, selStart: s + 2, selEnd: s + 2 + sl.length })) };
  panel.querySelectorAll("[data-md]").forEach(btn => btn.onclick = () => actions[btn.dataset.md]());
  ta.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") { e.preventDefault(); actions.bold(); }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i") { e.preventDefault(); actions.italic(); }
  });
  const focusOf = t => t === "type" ? panel.querySelector('[data-pane="type"] [data-field]') : t === "code" ? $("c-text") : $(PARTS.find(x => x[0] === t)[2]);
  const setTab = (t, focus) => {
    if (!panel.querySelector(`[data-tab="${t}"]`)) t = "beat";
    editorTab = t; LS.set("editorTab", t);
    panel.querySelectorAll("[data-tab]").forEach(x => { const on = x.dataset.tab === t; x.classList.toggle("on", on); x.setAttribute("aria-selected", on); });
    panel.querySelectorAll("[data-pane]").forEach(x => x.hidden = x.dataset.pane !== t);
    if (t === "type") refreshTypePane();
    if (t === "code") pollCode();
    if (focus) focusOf(t)?.focus();
  };
  panel.querySelectorAll("[data-tab]").forEach(x => x.onclick = () => setTab(x.dataset.tab, true));
  setTab(editorTab);
  // every tab's box saves, and each changes only its own part of the file
  PARTS.forEach(([, part, id]) => $(id).addEventListener("input", e => {
    const cur = beats.find(x => x.key === k); if (!cur || conflicts[k]) return;
    cur.text = setPart(cur.text, part, e.target.value);
    if (part === "adj") $("f-adjdot").hidden = !e.target.value.trim();
    paintCard(cur); saveTextSoon(cur); if (part === "body") refresh();
  }));
  $("f-type").onchange = e => { if (conflicts[k]) return; b.text = setField(b.text, "Type", e.target.value); paintCard(b); saveTextSoon(b); scanLinked(true); openBeat(k); };   // the type decides which tabs there are
  if (ttab) wireTypePane(b);
  if (ctab) wireCodePane(b);
  $("f-status").addEventListener("input", e => { if (conflicts[k]) return; b.text = setField(b.text, "Status", e.target.value); paintCard(b); saveTextSoon(b); });
  const ti = $("f-title");
  const commit = async () => { if (!(await renameBeat(b, ti.value))) { if (document.activeElement !== ti) ti.value = b.title; } else { $("panel").querySelector(".foot .help").textContent = `Every tab saves as you type. ${BEATS_DIR}/${b.file}`; } };
  ti.addEventListener("blur", commit); ti.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); ti.blur(); } });
  $("f-tags").querySelectorAll("[data-tag]").forEach(btn => btn.onclick = () => {
    const mm = meta.beats[b.key]; if (!mm) return;   // look it up fresh: a refresh may have replaced the layout
    const id = btn.dataset.tag, tg = tagsOf(mm), on = !tg.includes(id);
    mm.tags = on ? [...tg, id] : tg.filter(x => x !== id);
    btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on); paintCard(b); saveMetaSoon();
  });
  const del = $("f-del");
  del.onclick = () => { if (!del.classList.contains("armed")) { del.classList.add("armed"); del.textContent = `Click again to mark “${b.title}” for deletion`; return; } deleteMany([b]); };
  if (focusTitle) { ti.focus(); ti.select(); } else if (editorSize !== "popup" && editorTab !== "code") focusOf(editorTab)?.focus();
}
function showOrder() {
  activeKey = null; setPanelMode(null);
  const order = docOrder(), total = order.reduce((s, o) => s + o.beats.reduce((t, b) => t + bodyWords(b), 0), 0);
  panel.innerHTML = `<header><div><div class="eyebrow">Section, then left to right, then top to bottom</div><h2>Document order</h2></div><button class="x" aria-label="Close">✕</button></header>
    <p class="help">${fmtN(total)} words in paragraphs. Each section's note in Notes/ keeps this list up to date.</p>` +
    order.map(({ act, beats: l }) => `<h3>${esc(act.name)}<small>${fmtN(l.reduce((s, b) => s + bodyWords(b), 0))} words</small></h3><ol>${l.map(b => { const p = beatParts(b.text), w = bodyWords(b); return `<li><button data-k="${esc(b.key)}">${esc(b.title)}</button><small>${esc(p.type)}${w ? " · " + fmtN(w) + " words" : ""}</small></li>`; }).join("") || "<li><em>No beats</em></li>"}</ol>`).join("");
  panel.querySelector(".x").onclick = closePanel; panel.hidden = false;
  panel.querySelectorAll("[data-k]").forEach(btn => btn.onclick = () => openBeat(btn.dataset.k));
}
function showSettings() {
  activeKey = null; setPanelMode(null);
  const acts = sortedActs(), isNew = !beats.length && !toDelete.length;
  panel.innerHTML = `<header><div><div class="eyebrow">${esc(root.name)}</div><h2>Settings</h2></div><button class="x" aria-label="Close">✕</button></header>
  ${isNew ? `<h3>Template</h3><p class="help">The project has no beats yet, so you can still switch template. This replaces the sections, streams and tags.</p>
    <div class="rowedit"><select id="tplpick">${Object.entries(TEMPLATES).map(([k, t]) => `<option value="${k}"${k === meta.template ? " selected" : ""}>${esc(t.name)}</option>`).join("")}</select><button class="mini" id="tplgo">Apply</button></div>` : ""}
  <h3>Sections</h3><p class="help">Sections run left to right in document order. Drag the dashed lines on the board to move where one starts.</p>
  ${acts.map(a => `<div class="rowedit" data-act="${esc(a.id)}"><input type="text" class="an" value="${esc(a.name)}" aria-label="Section name"><button class="mini del" aria-label="Remove section"${meta.acts.length > 1 ? "" : " disabled"}>✕</button></div>`).join("")}
  <div class="btnrow"><button id="addact">Add section at the end</button></div>
  <h3>Streams</h3><p class="help">Threads of work that run across sections. A card's outline takes its stream's colour.</p>
  ${meta.lanes.map((l, i) => `<div class="rowedit" data-lane="${i}"><input type="color" class="lc" value="${esc(safeColor(l.color))}" aria-label="Stream colour"><input type="text" class="ln" value="${esc(l.name)}" aria-label="Stream name"><button class="mini up" aria-label="Move up"${i ? "" : " disabled"}>↑</button><button class="mini dn" aria-label="Move down"${i < meta.lanes.length - 1 ? "" : " disabled"}>↓</button><button class="mini del" aria-label="Remove stream"${meta.lanes.length > 1 ? "" : " disabled"}>✕</button></div>`).join("")}
  <div class="btnrow"><button id="addlane">Add stream</button></div>
  <h3>Tags</h3><p class="help">Status tags hang off the bottom of a card. A beat can have any number.</p>
  ${meta.tags.map(t => `<div class="rowedit" data-tag="${esc(t.id)}"><input type="color" class="tc" value="${esc(safeColor(t.color))}" aria-label="Tag colour"><input type="text" class="tn" value="${esc(t.name)}" aria-label="Tag name"><button class="mini del" aria-label="Remove tag">✕</button></div>`).join("")}
  <div class="btnrow"><button id="addtag">Add tag</button></div>
  <h3>Backups</h3><p class="help">A copy of the board, beats and notes goes into Backups/ once a day. The board is also saved there before you remove a section, stream or tag, and the version you don't keep in a conflict is saved in Backups/Conflicts.</p>
  <div class="btnrow"><button id="backnow">Back up now</button></div>
  <p class="srcnote">Paperboard is free software under the GNU AGPL-3.0, including the in-browser TeX Live (texlyre-busytex). <a href="https://github.com/JesseTNRoberts/Paperboard" target="_blank" rel="noopener">Source code</a>.</p>`;
  panel.hidden = false; panel.querySelector(".x").onclick = closePanel;
  const refresh = () => { refreshBoard(); saveMetaSoon(); };
  const arm = (d, fn) => d.onclick = async () => {
    if (!d.classList.contains("armed")) { d.classList.add("armed"); d.textContent = "Remove?"; d.style.background = "var(--danger)"; d.style.color = "#fff"; return; }
    await fn(); refresh(); showSettings();
  };
  if (isNew) $("tplgo").onclick = async () => {
    const k = $("tplpick").value; await backupBoard("template change");
    const t = boardFromTemplate(k); Object.assign(meta, { template: k, acts: t.acts, lanes: t.lanes, tags: t.tags });
    refresh(); fitAll(); showSettings(); setStatus(`Switched to the ${TEMPLATES[k].name} template.`);
  };
  panel.querySelectorAll("[data-act]").forEach(row => {
    const a = meta.acts.find(x => x.id === row.dataset.act);
    row.querySelector(".an").onchange = e => { a.name = e.target.value.trim() || a.name; refresh(); };
    arm(row.querySelector(".del"), async () => { if (meta.acts.length < 2) return; await backupBoard("removing section " + a.name); meta.acts = meta.acts.filter(x => x !== a); delete meta.sectionNotes[a.id]; });
  });
  $("addact").onclick = () => { meta.acts.push({ id: uid("s"), name: "New section", x: Math.max(...meta.acts.map(a => a.x + ACT_W), worldW() - 200) }); refresh(); showSettings(); };
  panel.querySelectorAll("[data-lane]").forEach(row => {
    const i = +row.dataset.lane, l = meta.lanes[i];
    row.querySelector(".ln").onchange = e => { l.name = e.target.value.trim() || l.name; refresh(); };
    row.querySelector(".lc").oninput = e => { l.color = e.target.value; refresh(); };
    const move = (a, b) => {   // swap two streams, moving their cards with them
      Object.values(meta.beats).forEach(m => { const li = laneIndexAt(m.y); if (li === a) m.y += (b - a) * LANE_H; else if (li === b) m.y += (a - b) * LANE_H; });
      [meta.lanes[a], meta.lanes[b]] = [meta.lanes[b], meta.lanes[a]]; refresh(); showSettings();
    };
    row.querySelector(".up").onclick = () => move(i, i - 1);
    row.querySelector(".dn").onclick = () => move(i, i + 1);
    arm(row.querySelector(".del"), async () => {
      if (meta.lanes.length < 2) return; await backupBoard("removing stream " + l.name);
      Object.values(meta.beats).forEach(m => { const li = laneIndexAt(m.y); if (li === i) m.y = LANE_TOP + Math.max(0, i - 1) * LANE_H + 45; else if (li > i) m.y -= LANE_H; });
      meta.lanes.splice(i, 1);
    });
  });
  $("addlane").onclick = () => { meta.lanes.push({ id: uid("l"), name: "New stream", color: LANE_COLORS[meta.lanes.length % LANE_COLORS.length] }); refresh(); showSettings(); };
  panel.querySelectorAll("[data-tag]").forEach(row => {
    const t = meta.tags.find(x => x.id === row.dataset.tag);
    row.querySelector(".tc").oninput = e => { t.color = e.target.value; refresh(); };
    row.querySelector(".tn").onchange = e => { t.name = e.target.value.trim() || t.name; refresh(); };
    arm(row.querySelector(".del"), async () => { await backupBoard("removing tag " + t.name); meta.tags = meta.tags.filter(x => x !== t); Object.values(meta.beats).forEach(m => { m.tags = (m.tags || []).filter(x => x !== t.id); }); });
  });
  $("addtag").onclick = () => { meta.tags.push({ id: uid("t"), name: "New tag", color: "#4f8a48" }); refresh(); showSettings(); };
  $("backnow").onclick = async () => { const label = stamp() + " manual"; try { await track(snapshot(label)); setStatus(`Backed up to Backups/${label}`); } catch (e) { setStatus("Backup failed: " + e.message, true); } };
}
$("order").onclick = showOrder;
$("settings").onclick = showSettings;
$("fit").onclick = fitAll;
$("sectionsbtn").onclick = e => {   // a button per section, to zoom to it
  e.stopPropagation(); if (!meta) return;
  if (!ctx.hidden) return hideCtx();
  ctx.innerHTML = `<div class="h">Zoom to</div><button class="it" role="menuitem" data-fit="">Whole document</button><hr>` +
    docOrder().map(({ act, beats: l }) => `<button class="it" role="menuitem" data-fit="${esc(act.id)}">${esc(act.name)} <span style="color:var(--ink-soft);font-size:12px">· ${plural(l.length, "beat")}</span></button>`).join("");
  ctx.hidden = false;
  const r = $("sectionsbtn").getBoundingClientRect();
  ctx.style.left = Math.max(4, Math.min(r.left, innerWidth - ctx.offsetWidth - 8)) + "px"; ctx.style.top = r.bottom + 4 + "px";
  ctx.querySelectorAll("[data-fit]").forEach(b => b.onclick = () => { hideCtx(); b.dataset.fit ? fitAct(b.dataset.fit) : fitAll(); });
  ctx.querySelector("button").focus();
};
$("zin").onclick = () => zoomAt(1.25, innerWidth / 2, innerHeight / 2);
$("zout").onclick = () => zoomAt(0.8, innerWidth / 2, innerHeight / 2);
addEventListener("resize", () => { if (meta) { layoutHeaders(); applyView(); } });
if (window.ResizeObserver) new ResizeObserver(() => { if (meta) { layoutHeaders(); placeHeaders(); } }).observe($("bar"));   // the toolbar can wrap to two lines
addEventListener("beforeunload", e => { if (pending > 0) { e.preventDefault(); e.returnValue = ""; } });

/* ================= live refresh: Claude's changes, merged in place ================= */
function saveHl() { LS.set("highlights", [...hl]); updateHlBtn(); }
function markChanged(k) { hl.add(k); flashKeys.add(k); }
function updateHlBtn() {
  const n = [...hl].filter(k => cardEls[k]).length, btn = $("clearhl");
  btn.hidden = !n; btn.textContent = `Clear highlights (${n})`;
}
$("clearhl").onclick = () => { hl.clear(); saveHl(); beats.forEach(paintCard); };
function updateConflictBtn() {
  const keys = Object.keys(conflicts).filter(k => beats.some(b => b.key === k)), btn = $("conflictsbtn");
  btn.hidden = !keys.length; btn.textContent = keys.length === 1 ? "1 needs your choice" : `${keys.length} need your choice`;
  btn.onclick = () => { const b = beats.find(x => x.key === keys[0]); if (b) openBeat(b.key); };
}
function mergeMetaFrom(diskText) {
  let disk; try { disk = JSON.parse(diskText); } catch (e) { return false; }   // half-written: try again next time
  const base = metaBase ? JSON.parse(metaBase) : disk, changed = new Set(), clashes = new Set();
  meta = mergeMeta(base, meta, disk, changed, clashes); normalizeMeta();
  metaBase = diskText;
  changed.forEach(k => { if (beats.some(b => b.key === k)) markChanged(k); });
  saveHl();
  return true;
}
/* a beat changed on disk: take it, merge it with what you're typing, or ask */
function reconcileBeat(b, d) {
  const local = b.text, base = b.base, r = merge3(base, local, d.text);
  b.base = d.text; b.mtime = d.mtime; markChanged(b.key);
  if (r.conflict) { conflicts[b.key] = { mine: local, theirs: d.text, merged: r.text, base }; b.text = d.text; paintCard(b); if (activeKey === b.key) showConflict(b); updateConflictBtn(); return "conflict"; }
  applyBeatText(b, r.text);
  return r.text === d.text ? "updated" : "merged";
}
function applyBeatText(b, text) {
  b.text = text; paintCard(b);
  if (activeKey !== b.key || !$("f-text")) return;
  const p = beatParts(text);   // update each tab of the open editor in place, keeping the cursor on the same words
  PARTS.forEach(([, part, id]) => {
    const el = $(id), v = p[part]; if (!el || el.value === v || el.value.trim() === v.trim()) return;
    const focused = document.activeElement === el, s = mapCaret(el.value, v, el.selectionStart), e = mapCaret(el.value, v, el.selectionEnd), top = el.scrollTop;
    el.value = v; if (focused || el.selectionStart !== undefined) el.setSelectionRange(s, e); el.scrollTop = top;
  });
  const ty = $("f-type"); if (ty && document.activeElement !== ty) ty.value = p.type;
  const st = $("f-status"); if (st && document.activeElement !== st && st.value.trim() !== p.status) st.value = p.status;
  const dot = $("f-adjdot"); if (dot) dot.hidden = !p.adj;
  const ta = $("f-text"), wc = $("f-wc"); if (wc) wc.textContent = fmtN(countWords(ta.value)) + " words";
  const pv = $("f-prev"), sp = $("f-split"); if (pv && sp && sp.dataset.view !== "write") { pv.innerHTML = renderMd(ta.value); resolveImages(pv); }
  if (panel.dataset.type !== p.type && document.activeElement?.closest?.("#panel") == null) return openBeat(b.key);   // Claude changed the type: rebuild the tabs
  syncTypeFields(p);
  if (hasCodeTab(p)) codeFilesChanged(b);
}
function diffMarks(text, other) {   // show the lines that differ between the two versions
  const A = text.split("\n"), m = lcsPairs(A, other.split("\n"));
  return A.map((l, i) => m.has(i) ? esc(l) : `<mark>${esc(l) || " "}</mark>`).join("\n");
}
function showConflict(b) {
  const c = conflicts[b.key]; if (!c) return;
  activeKey = b.key; setPanelMode(null); panel.classList.add("conflictp"); writeOpen(b.file);
  panel.innerHTML = `<header><div><div class="eyebrow">You and Claude changed the same lines</div><h2>${esc(b.title)}</h2></div><button class="x" aria-label="Close">✕</button></header>
    <p class="help">Everything else merged on its own. Keep one version, or edit the combined text: the clashing lines sit between the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers. Nothing is written to the beat until you choose. Until then the file holds Claude's version, and the one you don't keep is saved in Backups/Conflicts.</p>
    <div class="cols"><div><span class="lbl">Your version</span><pre>${diffMarks(c.mine, c.theirs)}</pre></div><div><span class="lbl">Claude's version</span><pre>${diffMarks(c.theirs, c.mine)}</pre></div></div>
    <label for="cf-text">Combined</label><textarea id="cf-text" spellcheck="false">${esc(c.merged)}</textarea>
    <div class="btnrow"><button id="cf-mine">Keep mine</button><button id="cf-theirs">Keep Claude's</button><button id="cf-save" class="primary">Save combined text</button></div>`;
  panel.hidden = false; panel.querySelector(".x").onclick = closePanel;
  const done = async (text, label) => {
    try {
      if (label !== "theirs") await backupConflict(b, "Claude's version", c.theirs);
      if (label !== "mine") await backupConflict(b, "your version", c.mine);
    } catch (e) { return setStatus("Couldn't save the backup copy, so nothing was changed: " + e.message, true); }
    delete conflicts[b.key]; updateConflictBtn();
    b.text = text; paintCard(b);
    await track(saveBeat(b)); writeGeneratedSoon(); openBeat(b.key);
    setStatus(`Saved “${b.title}”.`);
  };
  $("cf-mine").onclick = () => done(c.mine, "mine");
  $("cf-theirs").onclick = () => done(c.theirs, "theirs");
  $("cf-save").onclick = () => {
    const t = $("cf-text").value;
    if (hasMarkers(t)) return setStatus("The combined text still has conflict markers. Remove them, or keep one version.", true);
    done(t, "combined");
  };
  paintCard(b);
  requestAnimationFrame(() => {   // scroll each box to the first line that differs
    panel.querySelectorAll(".conflictp pre").forEach(pre => { const m = pre.querySelector("mark"); if (m) pre.scrollTop = Math.max(0, m.offsetTop - pre.offsetTop - 30); });
    const ta = $("cf-text"), i = ta.value.indexOf(MARK_MINE); if (i >= 0) { const line = ta.value.slice(0, i).split("\n").length; ta.scrollTop = Math.max(0, (line - 3) * parseFloat(getComputedStyle(ta).lineHeight)); }
  });
  setStatus(`“${b.title}”: you and Claude changed the same lines. Choose a version.`, true);
}

/* which beat is open, so Claude can leave it alone */
let openFile = null;
function writeOpen(f) {
  openFile = f; if (!root) return;
  const body = JSON.stringify({ open: f ? BEATS_DIR + "/" + f : null, updated: new Date().toISOString() }, null, 1) + "\n";
  enqueue("open", () => writeText(root, OPENF, body).catch(() => {}));
}
setInterval(() => { if (root && meta && openFile) writeOpen(openFile); }, 60000);   // heartbeat: a stale "updated" means the tab was closed

/* polling: claude-reload.txt and board.json every 3 seconds and when the tab comes back; a full look at Beats/ every 15 seconds in case the flag was missed */
let flagSeen = null, polling = false, lastFull = 0;
async function stampOf(name) { try { const f = await (await root.getFileHandle(name)).getFile(); return f.lastModified + ":" + f.size; } catch (e) { return null; } }
async function poll(force) {
  if (!root || !meta || polling || gesture) return;
  polling = true;
  try {
    const f = await stampOf(FLAG);
    let go = force === true || f !== flagSeen || missingOnce.size > 0 || Date.now() - lastFull > 15000;
    if (!go) { try { const m = (await (await root.getFileHandle(BOARD)).getFile()).lastModified; if (m !== metaMtime) go = true; } catch (e) {} }
    if (go) { flagSeen = f; lastFull = Date.now(); await syncFromDisk(); await scanLinked(false); await pollCode(); }
  } catch (e) { console.warn("refresh failed", e); }
  finally { polling = false; }
}
setInterval(poll, 3000);
addEventListener("focus", () => poll(true));
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(true); });

function syncFromDisk() {
  return exclusive(async () => {
    let layoutChanged = false;
    try {
      const d = await readInfo(root, BOARD);
      if (d.text !== metaBase) { if (mergeMetaFrom(d.text)) { metaMtime = d.mtime; layoutChanged = true; } }
      else metaMtime = d.mtime;
    } catch (e) {}
    const before = new Set(beats.map(b => b.key + "|" + b.file + "|" + b.text.length + "|" + b.text.slice(0, 40)));
    const { changed, conflictsNow } = await scanFolder(false);
    const live = new Set(beats.map(b => b.key));
    changed.forEach(k => { if (live.has(k)) markChanged(k); });
    [...hl].forEach(k => { if (!live.has(k) && !meta.trash[k]) hl.delete(k); });
    saveHl();
    const after = new Set(beats.map(b => b.key + "|" + b.file + "|" + b.text.length + "|" + b.text.slice(0, 40)));
    const any = layoutChanged || changed.size || before.size !== after.size || [...after].some(x => !before.has(x));
    if (any) {
      refreshBoard(); updateRestore(); updateConflictBtn(); writeGeneratedSoon();
      const ab = beats.find(b => b.key === activeKey), ti = $("f-title");
      if (ab && ti && document.activeElement !== ti) ti.value = ab.title;
      if (ab && $("f-deps")) wireDeps(ab.key);
      if (ab) { updateEditorEyebrow(ab); syncEditorTags(); const h = panel.querySelector(".foot .help"); if (h) h.textContent = `Every tab saves as you type. ${BEATS_DIR}/${ab.file}`; }
    }
    if (JSON.stringify(meta, null, 1) !== metaBase && J(meta) !== J(JSON.parse(metaBase || "null"))) saveMetaSoon();   // the merge differs from disk: write it back
    const n = [...changed].filter(k => live.has(k)).length;
    if (conflictsNow) setStatus(`${plural(n, "beat")} changed on disk; ${conflictsNow} need${conflictsNow === 1 ? "s" : ""} your choice.`, true);
    else if (n) setStatus(`${plural(n, "beat")} changed on disk. Highlighted on the board.`);
  });
}

/* for tests and for anyone driving the page from the console */
window.storyboard = { openFolder, poll: () => poll(true), state: () => ({ beats: beats.map(b => ({ key: b.key, file: b.file, title: b.title, text: b.text })), marked: toDelete.map(m => m.file), view: { ...view }, hl: [...hl], conflicts: Object.keys(conflicts), activeKey, pending }),
  flush: async () => { clearTimeout(metaTimer); clearTimeout(genTimer); for (const b of beats) { clearTimeout(textTimers[b.key]); await saveBeat(b); } await saveMeta(); await writeGenerated(); await lock; } };
