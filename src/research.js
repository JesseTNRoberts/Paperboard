
/* ================= beat types: figures, tables, experiments, references, code =================
   A Figure or Table beat points at files elsewhere in the project: the script that makes it (Script:), its inputs (Data:)
   and what it produces (Output:). An Experiment points at its code folder (Code:) and its last run (Last run:).
   The board reads those files to show thumbnails, previews and the code itself. It never runs anything. */
const IMG_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const CODE_FILE = /\.(py|r|jl|m|sh|bash|zsh|ya?ml|toml|json|txt|md|cfg|ini|csv|tsv|ipynb|js|mjs|ts|sql|do|sas|stan|c|cc|cpp|h|hpp|f90|lua|rmd|qmd|tex|bib|lock|mk)$|^(Makefile|Snakefile|Dockerfile|README|LICENSE|requirements\.txt)$/i;
const OUTCOMES = ["not run", "supports", "refutes", "inconclusive"];
const LINKED_TYPES = ["Figure", "Table", "Experiment"];
const TYPE_FIELDS = {   // the header fields each type's tab edits, in order
  Paragraph: [["Words", "Target length in words (optional)"]],
  Figure: [["Output", "figures/name.pdf, figures/name.png"], ["Script", "code/figures/name.py"], ["Data", "results/… or data/processed/…, comma-separated"], ["Caption", "One line. A longer caption goes in the Beat tab."], ["Wide", "auto: very wide images span both columns; or yes / no"]],
  Table: [["Output", "figures/name.csv or .md or .tex"], ["Script", "code/figures/name.py"], ["Data", "results/… or data/processed/…, comma-separated"], ["Caption", "One line."], ["Wide", "yes to span both columns"]],
  Experiment: [["Hypothesis", "What the run should show"], ["Code", "code/experiments/name"], ["Run", "The exact command, e.g. make name"], ["Last run", "run-id (YYYY-MM-DD)"], ["Outcome", ""]],
  References: [["Question", "What the literature must establish"], ["Keys", "BibTeX keys, comma-separated"]]
};
const extOf = p => ((p || "").match(/\.([^.\/]+)$/) || [, ""])[1].toLowerCase();
const listField = v => String(v || "").split(/[,;]\s*/).map(s => s.trim()).filter(Boolean);
/* a path inside the project folder, or null: no absolute paths, no "..", no URLs */
function relPath(p) {
  p = String(p || "").trim().replace(/^<|>$/g, "").replace(/^\.\//, "").replace(/^(\.\.\/)+/, "").replace(/\/+$/, "");
  if (!p || /^[a-z][\w+.-]*:/i.test(p) || p.startsWith("/") || p.startsWith("~") || p.split("/").some(s => s === ".." || s === ".")) return null;
  try { p = decodeURI(p); } catch (e) {}
  return p;
}
async function handleAt(path, kind = "file", create = false) {
  const rp = relPath(path); if (!rp || !root) return null;
  const parts = rp.split("/"), name = parts.pop();
  try {
    let d = root; for (const x of parts) d = await d.getDirectoryHandle(x, { create });
    return kind === "dir" ? await d.getDirectoryHandle(name, { create }) : await d.getFileHandle(name, { create });
  } catch (e) { return null; }
}
async function fileAt(path) { const h = await handleAt(path); if (!h) return null; try { return await h.getFile(); } catch (e) { return null; } }
async function newestIn(path, depth = 4) {   // modification time of a file, or of the newest file in a folder
  const f = await fileAt(path); if (f) return f.lastModified;
  const d = await handleAt(path, "dir"); if (!d) return null;
  let best = 0;
  const walk = async (dir, n) => { for await (const [name, h] of dir.entries()) { if (/^\.|^__pycache__$/.test(name)) continue; if (h.kind === "file") { try { best = Math.max(best, (await h.getFile()).lastModified); } catch (e) {} } else if (n > 0) await walk(h, n - 1); } };
  await walk(d, depth); return best || null;
}
async function listFiles(path, depth = 3) {
  const d = await handleAt(path, "dir"); if (!d) return [];
  const out = [];
  const walk = async (dir, pre, n) => {
    const ents = []; for await (const e of dir.entries()) ents.push(e);
    ents.sort((a, b) => (a[1].kind === b[1].kind ? a[0].localeCompare(b[0]) : a[1].kind === "file" ? -1 : 1));
    for (const [name, h] of ents) {
      if (/^\.|^__pycache__$|^node_modules$/.test(name)) continue;
      const p = pre + "/" + name;
      if (h.kind === "file") { const f = await h.getFile(); out.push({ path: p, name, mtime: f.lastModified, size: f.size }); }
      else if (n > 0) await walk(h, p, n - 1);
    }
  };
  await walk(d, relPath(path), depth); return out;
}
async function listDirs(path) { const d = await handleAt(path, "dir"); if (!d) return []; const out = []; for await (const [n, h] of d.entries()) if (h.kind === "directory" && !n.startsWith(".")) out.push(n); return out.sort(); }
const fmtTime = ms => { if (!ms) return "—"; const d = new Date(ms), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

/* images from the project folder, as blob URLs (kept until the file changes) */
const blobCache = new Map();
async function imageURL(path) {
  const rp = relPath(path); if (!rp || !IMG_TYPES[extOf(rp)]) return null;
  const f = await fileAt(rp); if (!f) return null;
  const c = blobCache.get(rp); if (c && c.mtime === f.lastModified && c.size === f.size) return c;
  if (c) setTimeout(() => URL.revokeObjectURL(c.url), 10000);
  const r = { url: URL.createObjectURL(new Blob([f], { type: IMG_TYPES[extOf(rp)] })), mtime: f.lastModified, size: f.size, path: rp };
  blobCache.set(rp, r); return r;
}
function resolveImages(el) {   // Markdown images that point into the project folder (figures/x.png, or ../figures/x.png from a beat)
  el.querySelectorAll("img[data-path]").forEach(async img => {
    const r = await imageURL(img.dataset.path);
    if (r) { img.src = r.url; img.title ||= r.path; }
    else { const s = document.createElement("span"); s.className = "imgmissing"; s.textContent = `Image not found: ${img.dataset.path}`; img.replaceWith(s); }
  });
}

/* what the board knows about each figure, table and experiment: thumbnail, staleness, last run */
const linked = {};
async function figureImage(p) {
  const outs = listField(p.fields.output).map(relPath).filter(Boolean);
  for (const o of outs) if (IMG_TYPES[extOf(o)] && await fileAt(o)) return o;
  for (const o of outs) { const png = o.replace(/\.[^.\/]+$/, ".png"); if (png !== o && await fileAt(png)) return png; }   // a PDF or EPS figure: its PNG twin
  return null;
}
async function lastRunOf(p) {
  const lr = (p.fields["last run"] || "").trim(); if (!lr) return null;
  const code = relPath(p.fields.code), slug = code ? code.split("/").pop() : null;
  const id = (lr.match(/^\s*([^\s(,;]+)/) || [])[1], date = (lr.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
  let path = null, mtime = null;
  if (slug && id) { const cand = `results/${slug}/${id}`; mtime = await newestIn(cand + "/run.json", 0) ?? await newestIn(cand); if (mtime != null) path = cand; }
  if (mtime == null && date) mtime = Date.parse(date + "T23:59:59");
  return { id, date, path, mtime };
}
async function inspectBeat(b) {
  const p = beatParts(b.text), info = { type: p.type, stale: false, why: [] };
  if (p.type === "Figure" || p.type === "Table") {
    const outs = listField(p.fields.output).map(relPath).filter(Boolean);
    info.outputs = outs;
    info.img = await figureImage(p);
    if (info.img) { const r = await imageURL(info.img); if (r) { info.url = r.url; info.imgMtime = r.mtime; } }
    let outM = null; for (const o of outs) { const m = await newestIn(o, 0); if (m != null) outM = outM == null ? m : Math.min(outM, m); }
    if (outM == null && info.imgMtime) outM = info.imgMtime;
    info.outMtime = outM; info.missing = outs.length > 0 && outM == null;
    const inputs = [...listField(p.fields.script), ...listField(p.fields.data)].map(relPath).filter(Boolean);
    info.inputs = [];
    for (const i of inputs) { const m = await newestIn(i); info.inputs.push({ path: i, mtime: m }); if (m != null && outM != null && m > outM + 1000) info.why.push(i); }
    info.stale = info.why.length > 0;
  } else if (p.type === "Experiment") {
    const code = relPath(p.fields.code);
    info.run = await lastRunOf(p);
    info.codeMtime = code ? await newestIn(code) : null;
    if (info.codeMtime && info.run && info.run.mtime && info.codeMtime > info.run.mtime + 1000) { info.stale = true; info.why = [code]; }
  }
  return info;
}
let linkedBusy = false, linkedAgain = false;
async function scanLinked(initial) {   // after loading, after each refresh from disk, and after you edit a path field
  if (linkedBusy) { linkedAgain = true; return; }
  linkedBusy = true;
  try {
    const repaint = [];
    for (const b of [...beats]) {
      const t = beatParts(b.text).type;
      if (!LINKED_TYPES.includes(t)) { if (linked[b.key]) { delete linked[b.key]; repaint.push(b); } continue; }
      const prev = linked[b.key], info = await inspectBeat(b);
      linked[b.key] = info;
      if (!prev || prev.url !== info.url || prev.stale !== info.stale || prev.missing !== info.missing || J(prev.run) !== J(info.run)) repaint.push(b);
      if (!initial && prev && prev.imgMtime && info.imgMtime && prev.imgMtime !== info.imgMtime) markChanged(b.key);   // a figure was regenerated
    }
    if (repaint.length) { repaint.forEach(paintCard); saveHl(); refreshTypePane(); writeGeneratedSoon(); }
  } catch (e) { console.warn("checking figures failed", e); }
  finally { linkedBusy = false; if (linkedAgain) { linkedAgain = false; scanLinked(initial); } }
}
let inspectTimer = null;
function inspectSoon() { clearTimeout(inspectTimer); inspectTimer = setTimeout(() => scanLinked(true), 700); }

/* a new beat takes its type from the stream it's created in */
function typeForLane(i) {
  const n = (meta.lanes[i]?.name || "").toLowerCase();
  return /figure|table/.test(n) ? "Figure" : /experiment/.test(n) ? "Experiment" : /literature|reference/.test(n) ? "References" : /hypothes/.test(n) ? "Hypothesis" : /\baims?\b/.test(n) ? "Aim" : "Paragraph";
}

/* ---------- dependencies: an arrow from A to B means B depends on A (experiment → figure → paragraph) ---------- */
const beatByKey = k => beats.find(b => b.key === k);
const inputsOf = k => meta.links.filter(l => l.to === k && beatByKey(l.from));
const feedsOf = k => meta.links.filter(l => l.from === k && beatByKey(l.to));
function depsHtml(k) {
  const chip = (l, other) => `<span class="dep"><button class="dep-open" data-k="${esc(other)}" title="Open">${icon(beatParts(beatByKey(other).text).type)}${esc(beatByKey(other).title)}</button><button class="dep-x" data-l="${esc(l.id)}" aria-label="Remove this dependency">✕</button></span>`;
  const ins = inputsOf(k), outs = feedsOf(k);
  const others = beats.filter(b => b.key !== k && !ins.some(l => l.from === b.key)).sort((a, b) => a.title.localeCompare(b.title));
  return `<div class="deprow"><span class="deph">Depends on</span>${ins.map(l => chip(l, l.from)).join("") || `<span class="none">nothing</span>`}
      <select id="f-adddep" aria-label="Add something this beat depends on"><option value="">+ add…</option>${others.map(b => `<option value="${esc(b.key)}">${esc(b.title)}</option>`).join("")}</select></div>
    <div class="deprow"><span class="deph">Used by</span>${outs.map(l => chip(l, l.to)).join("") || `<span class="none">nothing yet</span>`}</div>`;
}
function wireDeps(k) {
  const box = $("f-deps"); if (!box) return;
  box.innerHTML = depsHtml(k);
  box.querySelectorAll(".dep-open").forEach(b => b.onclick = () => openBeat(b.dataset.k));
  box.querySelectorAll(".dep-x").forEach(b => b.onclick = () => { meta.links = meta.links.filter(l => l.id !== b.dataset.l); drawLinks(); saveMetaSoon(); wireDeps(k); });
  $("f-adddep").onchange = e => { const from = e.target.value; if (!from) return; meta.links.push({ id: uid("a"), from, to: k, label: "" }); drawLinks(); saveMetaSoon(); wireDeps(k); };
}

/* ---------- the type tab ---------- */
const typeTabName = t => TYPE_FIELDS[t] ? (t === "Paragraph" ? "Details" : t) : null;
function fieldInput(name, ph, v) {
  const id = "tf-" + name.toLowerCase().replace(/\W+/g, "-");
  if (name === "Outcome") return `<div class="tf"><label for="${id}">Outcome</label><select id="${id}" data-field="Outcome">${OUTCOMES.map(o => `<option${o === (v || "not run").toLowerCase() ? " selected" : ""}>${o}</option>`).join("")}${v && !OUTCOMES.includes(v.toLowerCase()) ? `<option selected>${esc(v)}</option>` : ""}</select></div>`;
  const mono = /^(Output|Script|Data|Code|Run|Keys)$/.test(name) ? " mono" : "";
  return `<div class="tf${name === "Run" ? " withbtn" : ""}"><label for="${id}">${esc(name)}</label><input type="text" id="${id}" class="${mono.trim()}" data-field="${esc(name)}" value="${esc(v)}" placeholder="${esc(ph)}" spellcheck="${mono ? "false" : "true"}">${name === "Run" ? `<button class="mini" id="tf-copyrun" title="Copy the command">Copy</button>` : ""}</div>`;
}
function typePaneHtml(p) {
  const fs = TYPE_FIELDS[p.type]; if (!fs) return "";
  const top = { Figure: `<div class="figview" id="t-view"></div>`, Table: `<div class="figview tableview" id="t-view"></div>` }[p.type] || "";
  const extra = { Experiment: `<h4>Runs</h4><div id="t-runs" class="runs"><p class="help">Looking in results/…</p></div>`,
    References: `<h4>Keys</h4><div id="t-keys"></div><p class="help">Vetting status from References/vetting.md comes in the next phase.</p>`,
    Paragraph: `<p class="help" id="t-words"></p>` }[p.type] || "";
  return `<div class="tpane">${top}<div class="warn" id="t-warn" hidden></div><div class="tfields">${fs.map(([n, ph]) => fieldInput(n, ph, p.fields[n.toLowerCase()] || "")).join("")}</div><p class="help" id="t-times"></p>${extra}</div>`;
}
function wireTypePane(b) {
  const pane = panel.querySelector('[data-pane="type"]'); if (!pane) return;
  pane.querySelectorAll("[data-field]").forEach(el => el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
    const cur = beatByKey(b.key); if (!cur || conflicts[b.key]) return;
    cur.text = setField(cur.text, el.dataset.field, el.value);
    paintCard(cur); saveTextSoon(cur);
    if (/^(Output|Script|Data|Code|Last run)$/.test(el.dataset.field)) inspectSoon();
    if (/^(Script|Code)$/.test(el.dataset.field)) codeFilesChanged(cur);
    if (el.dataset.field === "Words") refreshTypePane();
  }));
  const cp = $("tf-copyrun"); if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText($("tf-run").value); cp.textContent = "Copied"; setTimeout(() => cp.textContent = "Copy", 1500); } catch (e) { $("tf-run").select(); } };
  refreshTypePane();
}
function syncTypeFields(p) {   // the file changed on disk: update the fields you're not typing in
  panel.querySelectorAll('[data-pane="type"] [data-field]').forEach(el => {
    if (document.activeElement === el) return;
    const v = p.fields[el.dataset.field.toLowerCase()] || (el.tagName === "SELECT" ? "not run" : "");
    if (el.value.trim() !== v.trim()) el.value = v;
  });
}
function csvRows(t, sep, max = 40) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < t.length && rows.length < max; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true; else if (c === sep) { row.push(cell); cell = ""; } else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; } else if (c !== "\r") cell += c;
  }
  if ((cell || row.length) && rows.length < max) { row.push(cell); rows.push(row); }
  return rows;
}
let typePaneSeq = 0;
async function refreshTypePane() {   // previews, warnings and file times in the open type tab
  const b = beatByKey(activeKey), pane = panel.querySelector('[data-pane="type"]'); if (!b || !pane) return;
  const seq = ++typePaneSeq, p = beatParts(b.text), info = linked[b.key] || (LINKED_TYPES.includes(p.type) ? await inspectBeat(b) : {});
  if (seq !== typePaneSeq || !panel.contains(pane)) return;
  const warn = $("t-warn"), times = $("t-times"), view = $("t-view");
  if (warn) {
    const msgs = [];
    if (info.stale && (p.type === "Figure" || p.type === "Table")) msgs.push(`<b>Stale.</b> Changed since the ${p.type.toLowerCase()} was last made: ${info.why.map(x => `<code>${esc(x)}</code>`).join(", ")}. Ask Claude to rerun the script.`);
    if (info.stale && p.type === "Experiment") msgs.push(`<b>Stale.</b> The code in <code>${esc(info.why[0])}</code> changed after the last run. Results cited from this run may not match the code.`);
    if (info.missing) msgs.push(`No output file yet at ${info.outputs.map(o => `<code>${esc(o)}</code>`).join(", ")}.`);
    (info.inputs || []).forEach(i => { if (i.mtime == null) msgs.push(`Not found: <code>${esc(i.path)}</code>.`); });
    warn.innerHTML = msgs.map(m => `<p>${m}</p>`).join(""); warn.hidden = !msgs.length;
  }
  if (times) {
    if (p.type === "Figure" || p.type === "Table") times.innerHTML = [info.outMtime ? `Output made ${fmtTime(info.outMtime)}` : null, ...(info.inputs || []).filter(i => i.mtime).map(i => `${esc(i.path.split("/").pop())} changed ${fmtTime(i.mtime)}`)].filter(Boolean).join(" · ");
    else if (p.type === "Experiment") times.innerHTML = [info.codeMtime ? `Code last changed ${fmtTime(info.codeMtime)}` : null, info.run?.mtime ? `last run ${fmtTime(info.run.mtime)}` : null].filter(Boolean).join(" · ");
  }
  if (view && p.type === "Figure") {
    view.innerHTML = info.url ? `<a href="${esc(info.url)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(info.url)}" alt="${esc(p.fields.caption || b.title)}"></a><div class="cap">${esc(info.img)}${p.fields.caption ? " · " + esc(p.fields.caption) : ""}</div>`
      : `<div class="empty">${listField(p.fields.output).length ? "No image to show yet. Output needs a PNG, JPG, SVG or WebP (a PDF figure shows its PNG twin)." : "Set Output to the figure file, e.g. figures/name.png. Claude's figure script writes it."}</div>`;
  }
  if (view && p.type === "Table") {
    const out = (info.outputs || [])[0], f = out ? await fileAt(out) : null;
    if (seq !== typePaneSeq) return;
    if (info.url) view.innerHTML = `<img src="${esc(info.url)}" alt="">`;
    else if (f && /^(csv|tsv)$/.test(extOf(out))) { const rows = csvRows(await f.text(), extOf(out) === "tsv" ? "\t" : ","); view.innerHTML = `<div class="tscroll"><table>${rows.map((r, i) => `<tr>${r.map(c => i ? `<td>${esc(c)}</td>` : `<th>${esc(c)}</th>`).join("")}</tr>`).join("")}</table></div><div class="cap">${esc(out)}${rows.length >= 40 ? " · first 40 rows" : ""}</div>`; }
    else if (f && extOf(out) === "md") { view.innerHTML = `<div class="mdprev">${renderMd(await f.text())}</div>`; }
    else if (f) view.innerHTML = `<pre class="codeview">${esc((await f.text()).slice(0, 20000))}</pre>`;
    else view.innerHTML = `<div class="empty">Set Output to the table file (CSV, Markdown or LaTeX). Claude's script writes it.</div>`;
  }
  if (p.type === "Experiment") renderRuns(b, p, info);
  if (p.type === "References") { const k = $("t-keys"); if (k) k.innerHTML = listField(p.fields.keys).map(x => `<span class="keychip">@${esc(x)}</span>`).join(" ") || `<p class="help">No keys yet.</p>`; }
  if (p.type === "Paragraph") { const w = $("t-words"), n = countWords(p.body), tgt = parseInt(p.fields.words, 10); if (w) w.textContent = tgt ? `${fmtN(n)} of ${fmtN(tgt)} words (${Math.round(n / tgt * 100)}%).` : `${fmtN(n)} words.`; }
}
async function renderRuns(b, p, info) {
  const box = $("t-runs"); if (!box) return;
  const code = relPath(p.fields.code), slug = code ? code.split("/").pop() : null;
  if (!slug) { box.innerHTML = `<p class="help">Set Code to the experiment's folder (code/experiments/name). Runs are read from results/name/.</p>`; return; }
  const runs = (await listDirs(`results/${slug}`)).reverse();
  if (!runs.length) { box.innerHTML = `<p class="help">No runs in <code>results/${esc(slug)}/</code> yet.</p>`; return; }
  const cur = info.run?.id;
  box.innerHTML = `<div class="runlist">${runs.map(r => `<button data-run="${esc(r)}" class="${r === cur ? "on" : ""}">${esc(r)}${r === cur ? " · last run" : ""}</button>`).join("")}</div><div id="t-run"></div>`;
  const show = async r => {
    box.querySelectorAll("[data-run]").forEach(x => x.classList.toggle("sel", x.dataset.run === r));
    const dir = `results/${slug}/${r}`, files = await listFiles(dir, 2), rj = files.find(f => f.name === "run.json");
    let meta_ = ""; if (rj) { try { meta_ = JSON.stringify(JSON.parse(await (await fileAt(rj.path)).text()), null, 2); } catch (e) { meta_ = await (await fileAt(rj.path)).text(); } }
    const imgs = files.filter(f => IMG_TYPES[f.name.split(".").pop().toLowerCase()]);
    $("t-run").innerHTML = `<p class="help"><code>${esc(dir)}/</code> · ${plural(files.length, "file")}: ${files.map(f => esc(f.path.slice(dir.length + 1))).join(", ")}</p>` +
      (imgs.length ? `<div class="runimgs">${imgs.map(f => `<img data-path="${esc(f.path)}" alt="${esc(f.name)}" title="${esc(f.path)}">`).join("")}</div>` : "") +
      (meta_ ? `<span class="lbl">run.json</span><pre class="codeview">${esc(meta_.slice(0, 20000))}</pre>` : `<p class="help">This run has no run.json. Every run should record one (see Claude/skills/Experiments and code.md).</p>`);
    resolveImages($("t-run"));
  };
  box.querySelectorAll("[data-run]").forEach(x => x.onclick = () => show(x.dataset.run));
  show(runs.includes(cur) ? cur : runs[0]);
}

/* ---------- the Code tab: the real files under code/, read and edited in place ---------- */
const hasCodeTab = p => LINKED_TYPES.includes(p.type) || !!(p.fields.script || p.fields.code);
async function codeFilesOf(p) {
  const out = [];
  for (const s of listField(p.fields.script).map(relPath).filter(Boolean)) out.push({ path: s, exists: !!(await fileAt(s)) });
  const c = relPath(p.fields.code);
  if (c) {
    if (await fileAt(c)) out.push({ path: c, exists: true });
    else { const fs = (await listFiles(c, 3)).filter(f => CODE_FILE.test(f.name)); if (fs.length) fs.forEach(f => out.push({ path: f.path, exists: true })); else out.push({ path: c + "/", exists: false, folder: true }); }
  }
  return out.filter((x, i, a) => a.findIndex(y => y.path === x.path) === i);
}
let code = null;   // the file open in the Code tab: {key, path, base, mtime, conflict}
let codeTimer = null;
function codePaneHtml() {
  return `<div class="codebar"><select id="c-file" aria-label="File"></select><span class="grow"></span><span id="c-status" class="cstatus"></span></div>
    <div class="warn" id="c-conflict" hidden></div>
    <div class="mdwrap codewrap"><textarea id="c-text" class="code" spellcheck="false" wrap="off" aria-label="Code" placeholder="Pick a file above."></textarea></div>
    <p class="help" id="c-help">This is the real file. Claude writes, documents and runs it; what you type here saves straight to it. The board never runs code.</p>`;
}
async function wireCodePane(b) {
  const sel = $("c-file"), ta = $("c-text"); if (!sel) return;
  ta.addEventListener("keydown", e => {   // Tab indents instead of leaving the box
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText("    ", s, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); }
  });
  ta.addEventListener("input", () => { if (!code || code.conflict || code.readOnly) return; setCodeStatus("Unsaved"); clearTimeout(codeTimer); codeTimer = setTimeout(() => track(saveCode()), 700); });
  sel.onchange = async () => { await flushCode(); LS.set("codefile:" + b.key, sel.value); openCodeFile(b, sel.value); };
  await codeFilesChanged(b);
}
async function codeFilesChanged(b) {   // Script or Code changed: refill the file list
  const sel = $("c-file"); if (!sel || activeKey !== b.key) return;
  const files = await codeFilesOf(beatParts(b.text));
  if (!$("c-file") || activeKey !== b.key) return;
  if (!files.length) { sel.innerHTML = `<option value="">No code linked yet</option>`; sel.disabled = true; showNoCode(b); return; }
  sel.disabled = false;
  const want = LS.get("codefile:" + b.key, null), pick = files.find(f => f.path === want) ? want : files.find(f => /run|main|\.py$|\.r$/i.test(f.path) && f.exists)?.path || files[0].path;
  sel.innerHTML = files.map(f => `<option value="${esc(f.path)}"${f.path === pick ? " selected" : ""}>${esc(f.path)}${f.exists ? "" : " (not created yet)"}</option>`).join("");
  if (!code || code.key !== b.key || code.path !== pick) openCodeFile(b, pick);
}
function showNoCode(b) {
  const p = beatParts(b.text), ta = $("c-text"); code = null; ta.value = ""; ta.readOnly = true;
  $("c-help").innerHTML = p.type === "Experiment" ? `Set <b>Code</b> in the Experiment tab to the experiment's folder (e.g. <code>code/experiments/name</code>). Its files show here.` : `Set <b>Script</b> in the ${esc(p.type)} tab to the script that makes it (e.g. <code>code/figures/name.py</code>). It shows here.`;
  setCodeStatus("");
}
async function openCodeFile(b, path) {
  const ta = $("c-text"); if (!ta) return;
  $("c-conflict").hidden = true; ta.readOnly = false;
  $("c-help").textContent = "This is the real file. Claude writes, documents and runs it; what you type here saves straight to it. The board never runs code.";
  if (path.endsWith("/")) { code = null; ta.value = ""; ta.readOnly = true; setCodeStatus(""); $("c-help").innerHTML = `The folder <code>${esc(path)}</code> doesn't exist yet. Claude creates it when it sets up the experiment.`; return; }
  const f = await fileAt(path);
  if (f && f.size > 2e6) { code = { key: b.key, path, readOnly: true }; ta.value = ""; ta.readOnly = true; setCodeStatus(""); $("c-help").textContent = `${path} is too large to show here (${Math.round(f.size / 1e6)} MB).`; return; }
  const text = f ? await f.text() : "";
  code = { key: b.key, path, base: text, mtime: f ? f.lastModified : 0, exists: !!f };
  ta.value = text; ta.scrollTop = 0; ta.setSelectionRange(0, 0);
  setCodeStatus(f ? `Changed ${fmtTime(f.lastModified)}` : "Not created yet: type to create it");
}
function setCodeStatus(t) { const s = $("c-status"); if (s) s.textContent = t; }
function saveCode() {
  const c = code; if (!c || c.readOnly) return Promise.resolve();
  return enqueue("code:" + c.path, async () => {
    const ta = $("c-text"); if (code !== c || c.conflict || !ta) return;
    let t = ta.value; if (t === c.base) { setCodeStatus(`Saved ${fmtTime(c.mtime)}`); return; }
    const f = await fileAt(c.path), disk = f ? await f.text() : null;
    if (disk != null && disk !== c.base) {   // Claude changed it meanwhile: merge first
      const r = merge3(c.base, t, disk);
      if (r.conflict) { c.conflict = { mine: t, theirs: disk }; c.base = disk; c.mtime = f.lastModified; showCodeConflict(); return; }
      setCodeText(r.text); t = r.text; c.base = disk;
    }
    const h = await handleAt(c.path, "file", true); if (!h) throw new Error("Can't write " + c.path);
    const w = await h.createWritable(); await w.write(t); await w.close();
    c.base = t; c.mtime = (await h.getFile()).lastModified; c.exists = true;
    setCodeStatus(`Saved ${fmtTime(c.mtime)}`);
    if (ta.value !== t) { clearTimeout(codeTimer); codeTimer = setTimeout(() => track(saveCode()), 300); }
  });
}
async function flushCode() { if (codeTimer) { clearTimeout(codeTimer); codeTimer = null; await track(saveCode()).catch(() => {}); } }
function setCodeText(v) {
  const ta = $("c-text"); if (!ta || ta.value === v) return;
  const s = mapCaret(ta.value, v, ta.selectionStart), e = mapCaret(ta.value, v, ta.selectionEnd), top = ta.scrollTop, left = ta.scrollLeft;
  ta.value = v; ta.setSelectionRange(s, e); ta.scrollTop = top; ta.scrollLeft = left;
}
async function pollCode() {   // after Claude's round of edits: bring the open code file up to date, merging with your typing
  const c = code, ta = $("c-text"); if (!c || !ta || c.readOnly || c.conflict) return;
  const f = await fileAt(c.path); if (!f || f.lastModified === c.mtime || code !== c) return;
  const disk = await f.text(); c.mtime = f.lastModified;
  if (disk === c.base) return;
  const mine = ta.value;
  if (mine === c.base) { setCodeText(disk); c.base = disk; setCodeStatus(`Updated from disk ${fmtTime(f.lastModified)}`); flashCode(); return; }
  const r = merge3(c.base, mine, disk);
  if (r.conflict) { c.conflict = { mine, theirs: disk }; c.base = disk; showCodeConflict(); return; }
  setCodeText(r.text); c.base = disk; flashCode(); clearTimeout(codeTimer); codeTimer = setTimeout(() => track(saveCode()), 300);
}
function flashCode() { const w = panel.querySelector(".codewrap"); if (w) { w.classList.remove("flashc"); void w.offsetWidth; w.classList.add("flashc"); } }
function showCodeConflict() {
  const c = code, box = $("c-conflict"); if (!c || !box) return;
  box.hidden = false; $("c-text").readOnly = true;
  box.innerHTML = `<p><b>Claude changed the same lines of <code>${esc(c.path)}</code> while you were editing.</b> Nothing is written until you choose; the version you don't keep goes to Backups/Conflicts.</p>
    <div class="btnrow"><button id="cc-mine">Keep mine</button><button id="cc-theirs">Take Claude's</button></div>`;
  setCodeStatus("Needs your choice");
  const done = async keepMine => {
    const name = c.path.split("/").pop();
    try {
      const d = await (await subdir(BACKUP_DIR, true)).getDirectoryHandle("Conflicts", { create: true });
      await writeText(d, `${stamp()} ${name} (${keepMine ? "Claude's version" : "your version"}).txt`, keepMine ? c.conflict.theirs : c.conflict.mine);
    } catch (e) { return setStatus("Couldn't save the backup copy, so nothing was changed: " + e.message, true); }
    const keep = keepMine ? c.conflict.mine : c.conflict.theirs;
    c.conflict = null; box.hidden = true; $("c-text").readOnly = false;
    setCodeText(keep);
    if (keepMine) await track(saveCode()); else { c.base = keep; setCodeStatus("Took Claude's version"); }
  };
  $("cc-mine").onclick = () => done(true); $("cc-theirs").onclick = () => done(false);
}
