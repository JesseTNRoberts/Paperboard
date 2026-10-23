
/* ================= Overleaf: export/overleaf is a git copy of the Overleaf project =================
   Paperboard keeps the paper written into it (main.tex with the % beat: markers, the template's files, references.bib,
   the figures). "Sync with Overleaf.command", double-clicked in the project folder, commits that, pulls Overleaf's
   changes, merges them and pushes. When the pull brings edits, Paperboard merges each beat's edits back into the beat,
   preamble edits into export/template/main.tex and new references into References/references.bib.
   export/.overleaf-sent/ holds what Paperboard last wrote, so it can tell Overleaf's edits from its own. */
const OL_DIR = "export/overleaf", OL_SENT = "export/.overleaf-sent", OL_MERGE = "export/overleaf-merge", SYNC_SCRIPT = "Sync with Overleaf.command";
const olOpts = () => { meta.overleaf ||= {}; meta.overleaf.done ||= []; return meta.overleaf; };
let olLast = { stamp: null, merges: "" }, olInfo = { linked: false, imported: null, notes: [] };
async function olRepo() { const d = await handleAt(OL_DIR, "dir"); if (!d) return null; try { await d.getDirectoryHandle(".git"); return d; } catch (e) { return null; } }
async function readAt(path) { const f = await fileAt(path); return f ? f.text() : null; }
async function writeAt(path, content) {   // creates folders as needed; writes only if the content differs
  const old = await fileAt(path);
  if (old) {
    if (typeof content === "string") { if (await old.text() === content) return false; }
    else if (old.size === content.length) { const a = new Uint8Array(await old.arrayBuffer()); let same = true; for (let i = 0; i < a.length; i++) if (a[i] !== content[i]) { same = false; break; } if (same) return false; }
  }
  const h = await handleAt(path, "file", true); if (!h) throw new Error("Can't write " + path);
  const w = await h.createWritable(); await w.write(content); await w.close(); return true;
}
async function olStamp() { const f = await fileAt(OL_DIR + "/main.tex"); return f ? f.lastModified + ":" + f.size : null; }

/* ---------- Paperboard -> export/overleaf ---------- */
let olTimer = null;
function olExportSoon() { clearTimeout(olTimer); olTimer = setTimeout(() => { if (root && meta) enqueue("overleaf", olSync).catch(e => console.warn("Overleaf", e)); }, 3000); }
async function olExport() {
  if (!(await olRepo())) return;
  const paper = await assemblePaper();
  const cur = await readAt(OL_DIR + "/main.tex"), sent = await readAt(OL_SENT + "/main.tex");
  if (cur != null && sent != null && !splitPaperTex(cur)) {   // the markers were taken out in Overleaf: don't overwrite their file
    olInfo.notes = ["Overleaf's main.tex no longer has Paperboard's markers, so Paperboard isn't overwriting it. Restore the markers in Overleaf (its history has them), or move export/overleaf/main.tex aside to start fresh."];
    renderOverleaf(); return;
  }
  await writeAt(OL_DIR + "/main.tex", paper.main); await writeAt(OL_SENT + "/main.tex", paper.main);
  for (const f of paper.files) {
    if (f.path === "README.md") continue;
    await writeAt(OL_DIR + "/" + f.path, f.content);
    if (f.path === "references.bib") await writeAt(OL_SENT + "/references.bib", f.content);
  }
  olLast.stamp = await olStamp();
}

/* ---------- export/overleaf -> the beats ---------- */
function bodyFromLatex(p, b, tex) {
  if (p.type !== "Paragraph") { const head = `\\paragraph{${mdInline(b.title)}.}`; if (tex.startsWith(head)) tex = tex.slice(head.length).replace(/^\n/, ""); }
  return latexToMd(tex);
}
function applyOverleaf(baseTex, theirsTex, notes) {   // merge Overleaf's edits (base -> theirs) into the beats; returns how many beats changed
  const B = splitPaperTex(baseTex), T = splitPaperTex(theirsTex);
  if (!B || !T) { notes.push("The Paperboard markers are missing from Overleaf's main.tex, so its edits couldn't be matched to beats."); return 0; }
  let n = 0;
  for (const [key, tBlock] of T.blocks) {
    const bBlock = B.blocks.get(key); if (bBlock === undefined || bBlock === tBlock) continue;
    const b = beatByKey(key); if (!b) { notes.push(`Overleaf edited text for a beat that no longer exists (${key}); it's in export/overleaf/main.tex.`); continue; }
    if (conflicts[key]) { notes.push(`“${b.title}” already needs your choice; Overleaf's edit to it waits until the next sync.`); continue; }
    const p = beatParts(b.text);
    if (p.type === "Figure" || p.type === "Table") {   // floats aren't rebuilt from LaTeX: keep Overleaf's version in the beat's notes
      b.text = setPart(b.text, "notes", (p.notes ? p.notes + "\n\n" : "") + `Overleaf edit (${today()}), not applied automatically:\n\n${tBlock}`);
      applyBeatText(b, b.text); markChanged(key); saveTextSoon(b); n++;
      notes.push(`Overleaf changed the ${p.type.toLowerCase()} “${b.title}”; its LaTeX is in the beat's Notes.`); continue;
    }
    const mine = beatLatex(b, p);
    let merged;
    if (mine === bBlock) merged = tBlock;
    else {
      const r = merge3(bBlock, mine, tBlock);
      if (r.conflict) {
        conflicts[key] = { who: "Overleaf", mine: b.text, theirs: setPart(b.text, "body", bodyFromLatex(p, b, tBlock)), merged: setPart(b.text, "body", r.text) };
        markChanged(key); paintCard(b); updateConflictBtn(); n++; continue;
      }
      merged = r.text;
    }
    const nt = setPart(b.text, "body", bodyFromLatex(p, b, merged));
    if (nt !== b.text) { applyBeatText(b, nt); markChanged(key); saveTextSoon(b); n++; }
  }
  for (const key of B.blocks.keys()) if (!T.blocks.has(key) && beatByKey(key)) notes.push(`The “% beat:” line for “${beatByKey(key).title}” was removed in Overleaf, so edits there couldn't be matched. Put the line back in Overleaf.`);
  for (const [name, t] of T.sections) if (B.sections.has(name) && B.sections.get(name) !== t && !name.startsWith("end: ")) notes.push(`Overleaf changed the heading of “${name}”. Rename sections in Paperboard's Settings.`);
  return n;
}
async function applyTemplateEdits(baseTex, theirsTex, notes) {   // preamble and ending: back into export/template/main.tex
  const B = splitPaperTex(baseTex), T = splitPaperTex(theirsTex); if (!B || !T || (B.pre === T.pre && B.post === T.post)) return;
  const tmpl = await readAt(MAIN_TEX);
  if (tmpl == null) { await writeAt(MAIN_TEX, T.pre + "%% PAPERBOARD BODY" + T.post); notes.push(`Overleaf's preamble is now the template, in ${MAIN_TEX}.`); return; }
  const m = tmpl.match(BODY_MARK); if (!m) { notes.push(`Overleaf changed the preamble, but ${MAIN_TEX} has no %% PAPERBOARD BODY line to line it up with.`); return; }
  const tpre = tmpl.slice(0, m.index), tpost = tmpl.slice(m.index + m[0].length);
  const a = merge3(B.pre, tpre, T.pre), c = merge3(B.post, tpost, T.post);
  if (a.conflict || c.conflict) { await backupFile("overleaf-template-main.tex", theirsTex); notes.push(`Overleaf and Paperboard both changed the template's preamble; Overleaf's whole file is in Backups. ${MAIN_TEX} is unchanged.`); return; }
  if (await writeAt(MAIN_TEX, a.text + m[0] + c.text)) notes.push(`Brought Overleaf's preamble changes into ${MAIN_TEX}.`);
}
async function applyBibEdits(base, theirs, notes) {
  if (base == null || theirs == null || base === theirs) return;
  const mine = await readAt("References/references.bib") ?? "";
  const r = merge3(base, mine, theirs);
  if (r.conflict) { await backupFile("overleaf-references.bib", theirs); notes.push("Overleaf and Paperboard both changed the same lines of references.bib; Overleaf's version is in Backups. References/references.bib is unchanged."); return; }
  if (await writeAt("References/references.bib", r.text)) notes.push("Brought Overleaf's changes to references.bib into References/references.bib.");
}
async function backupFile(name, text) { const d = await (await subdir(BACKUP_DIR, true)).getDirectoryHandle("Overleaf", { create: true }); await writeText(d, `${stamp()} ${name}`, text); }
async function olImport() {
  if (!(await olRepo())) return;
  const notes = [], o = olOpts(); let n = 0, saw = false;
  // 1. a clash the sync script set aside: merge with the real common version
  for (const dir of await listDirs(OL_MERGE)) {
    if (o.done.includes(dir)) continue;
    const at = n => readAt(`${OL_MERGE}/${dir}/${n}`);
    const base = await at("base-main.tex"), theirs = await at("theirs-main.tex");
    if (base && theirs) { n += applyOverleaf(base, theirs, notes); await applyTemplateEdits(base, theirs, notes); }
    await applyBibEdits(await at("base-references.bib"), await at("theirs-references.bib"), notes);
    o.done.push(dir); saw = true;
    if (theirs) await writeAt(OL_SENT + "/main.tex", theirs);   // Overleaf's version is now what export/overleaf holds
    const tb = await at("theirs-references.bib"); if (tb) await writeAt(OL_SENT + "/references.bib", tb);
  }
  // 2. edits that came in with a clean pull
  const cur = await readAt(OL_DIR + "/main.tex"), sent = await readAt(OL_SENT + "/main.tex");
  if (cur != null && !splitPaperTex(cur)) {   // a fresh Overleaf project: keep its main.tex, then put the paper in
    if (!sent) { await backupFile("overleaf-original-main.tex", cur); notes.push("Saved Overleaf's original main.tex in Backups/Overleaf and put the paper in its place."); }
  } else if (cur != null && sent != null && cur !== sent) {
    n += applyOverleaf(sent, cur, notes); await applyTemplateEdits(sent, cur, notes); saw = true;
    await writeAt(OL_SENT + "/main.tex", cur);
  }
  const curBib = await readAt(OL_DIR + "/references.bib"), sentBib = await readAt(OL_SENT + "/references.bib");
  if (curBib != null && sentBib != null && curBib !== sentBib) { await applyBibEdits(sentBib, curBib, notes); await writeAt(OL_SENT + "/references.bib", curBib); saw = true; }
  if (saw) {
    saveHl(); saveMetaSoon();
    olInfo.imported = Date.now(); olInfo.notes = notes;
    setStatus(n ? `Brought Overleaf's edits into ${plural(n, "beat")}.` : notes.length ? "Synced with Overleaf; see the Overleaf panel." : "Synced with Overleaf: no edits to bring in.", Object.keys(conflicts).length > 0);
    renderOverleaf();
  }
}
async function olSync() { await olImport(); await olExport(); }
async function olPoll() {   // the sync script ran: bring the edits in
  if (!root || !meta) return;
  const repo = await olRepo();
  if (!!repo !== olInfo.linked) { olInfo.linked = !!repo; renderOverleaf(); if (repo) return enqueue("overleaf", olSync); }
  if (!repo) return;
  const st = await olStamp(), merges = (await listDirs(OL_MERGE)).join("|");
  if (st !== olLast.stamp || merges !== olLast.merges) { olLast.merges = merges; await enqueue("overleaf", olSync); olLast.stamp = await olStamp(); }
}

/* ---------- the sync, in the Overleaf panel ---------- */
async function renderOverleaf() {
  const box = $("x-ol"); if (!box) return;
  const repo = await olRepo(), script = await fileAt(SYNC_SCRIPT);
  if (!repo) {
    box.innerHTML = `<b>Overleaf</b> <span class="help">Not linked.</span> <button class="mini" id="x-olsetup">${script ? "Show how to link" : "Set up sync with Overleaf"}</button><div id="x-olhow" hidden></div>`;
    $("x-olsetup").onclick = async () => { if (!script) await writeAt(SYNC_SCRIPT, SYNC_SCRIPT_TEXT); showOlHow(); };
    return;
  }
  box.innerHTML = `<b>Overleaf</b> <span class="help">Linked (export/overleaf). To sync, double-click <b>${SYNC_SCRIPT}</b> in the project folder.${olInfo.imported ? ` Last brought edits in ${fmtTime(olInfo.imported)}.` : ""}</span> <button class="mini" id="x-olsetup">Setup steps</button><div id="x-olhow" hidden></div>` +
    (olInfo.notes.length ? `<div class="warn">${olInfo.notes.map(n => `<p>${esc(n)}</p>`).join("")}</div>` : "");
  $("x-olsetup").onclick = async () => { if (!(await fileAt(SYNC_SCRIPT))) await writeAt(SYNC_SCRIPT, SYNC_SCRIPT_TEXT); showOlHow(); };
}
function showOlHow() {
  const h = $("x-olhow"); if (!h) return; h.hidden = false;
  const cmd = `xattr -c "${SYNC_SCRIPT}"; chmod +x "${SYNC_SCRIPT}"`;
  h.innerHTML = `<ol class="olsteps">
    <li>Paperboard has put <b>${SYNC_SCRIPT}</b> in the project folder. macOS blocks scripts a browser wrote until you allow it, once:
      in Terminal, type <code>cd </code> (with a space), drag the project folder into the window and press Return; then paste this and press Return:
      <div class="cmdrow"><code id="x-olcmd">${esc(cmd)}</code><button class="mini" id="x-olcopy">Copy</button></div>
      <span class="help">Without Terminal: double-click the script, and when macOS refuses, open System Settings &gt; Privacy &amp; Security, scroll down and click Open Anyway.</span></li>
    <li>In Overleaf, open the project and copy its Git link (Menu &gt; Integrations &gt; Git), and create a Git token (Account Settings &gt; Git integration).</li>
    <li>Double-click <b>${SYNC_SCRIPT}</b>. Paste the token and then the link when asked. The token goes into your Mac's Keychain.</li>
    <li>Double-click it again whenever you want to sync. It sends the paper and brings Overleaf's edits back into the beats.</li></ol>`;
  $("x-olcopy").onclick = async () => { try { await navigator.clipboard.writeText(cmd); $("x-olcopy").textContent = "Copied"; } catch (e) { const r = document.createRange(); r.selectNodeContents($("x-olcmd")); getSelection().removeAllRanges(); getSelection().addRange(r); } };
  renderOverleafLater();
}
function renderOverleafLater() { clearTimeout(renderOverleafLater.t); renderOverleafLater.t = setTimeout(async () => { if (await olRepo()) renderOverleaf(); }, 4000); }
