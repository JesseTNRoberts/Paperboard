
/* ================= Overleaf: a folder in the project (export/overleaf by default) holds the paper as LaTeX, and is a git repository for the Overleaf project =================
   Paperboard keeps the paper written into it (main.tex with the % beat: markers, the template's files, references.bib,
   the figures), starting when you press Start. You push it to Overleaf with git, using the commands the Overleaf panel
   gives you (the first one makes the folder a repository and pushes to an empty Overleaf project). When a pull brings Overleaf's
   edits, Paperboard merges each beat's edits back into the beat, preamble edits into export/template/main.tex and new
   references into References/references.bib. If git stops with a conflict, Paperboard reads the three versions from
   the conflict markers (diff3 style), merges them beat by beat, writes the resolved files, and you run the command again.
   export/.overleaf-sent/ holds what Paperboard last wrote, so it can tell Overleaf's edits from its own. */
const OL_DEFAULT = "export/overleaf", OL_SENT = "export/.overleaf-sent";
const olDir = () => relPath(meta?.overleaf?.dir) || OL_DEFAULT;   // the folder in the project that is your git clone of the Overleaf project
const shq = s => `"${String(s).replace(/(["\\$`])/g, "\\$1")}"`;
const olBase = () => { try { return String(LS.get("projectPath:" + (root?.name || ""), "") || "").trim().replace(/\/+$/, ""); } catch (e) { return ""; } };   // the project folder's full path on this computer, if you gave it
const olCd = () => { const b = olBase(), d = olDir(); return !b ? shq(d) : b.startsWith("~/") ? "~/" + shq(b.slice(2) + "/" + d) : shq(b + "/" + d); };   // ~ only expands outside quotes
const olFirstCmd = url => `cd ${olCd()} && git init -q && git checkout -q -B main && git add -A && (git commit -qm "Paperboard" || true) && (git remote add origin ${shq(url)} 2>/dev/null || git remote set-url origin ${shq(url)}) && (git pull -q --no-rebase --no-edit --allow-unrelated-histories -X ours origin main 2>/dev/null || true) && git push -u origin main; cd - >/dev/null`;   // Overleaf only accepts the branch "main"
const olSyncCmd = () => `cd ${olCd()} && git add -A && (git commit -qm "Paperboard" || true) && git -c merge.conflictStyle=diff3 pull --no-rebase --no-edit && git push; cd - >/dev/null`;
const olOpts = () => { meta.overleaf ||= {}; return meta.overleaf; };
let olLast = { stamp: null }, olInfo = { linked: false, imported: null, notes: [], waiting: false, handled: null, noBase: false };
const olClashes = () => Object.keys(conflicts).filter(k => conflicts[k].who === "Overleaf" && beatByKey(k));
async function olActive() { return !!(meta?.overleaf?.on || await olRepo()); }   // Paperboard writes the paper into the folder once you start, git or not
async function olRepo() { const d = await handleAt(olDir(), "dir"); if (!d) return null; try { await d.getDirectoryHandle(".git"); return d; } catch (e) { return null; } }
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
async function olStamp() { const f = await fileAt(olDir() + "/main.tex"); return f ? f.lastModified + ":" + f.size : null; }

/* ---------- Paperboard -> the clone ---------- */
let olTimer = null;
function olExportSoon() { clearTimeout(olTimer); olTimer = setTimeout(() => { if (root && meta) enqueue("overleaf", olSync).catch(e => console.warn("Overleaf", e)); }, 3000); }
async function olExport() {
  if (!(await olActive())) return;
  const paper = await assemblePaper();
  if (J(paper.notes) !== J(olInfo.paperNotes || [])) { olInfo.paperNotes = paper.notes; renderOverleaf(); }
  const cur = await readAt(olDir() + "/main.tex"), sent = await readAt(OL_SENT + "/main.tex");
  if (cur != null && hasGitConflict(cur) && (olInfo.noBase || olClashes().length)) return;   // wait: git's conflict isn't merged yet, or you're still choosing
  if (cur != null && sent != null && !splitPaperTex(cur)) {   // the markers were taken out in Overleaf: don't overwrite their file
    olInfo.notes = [`Overleaf's main.tex no longer has Paperboard's markers, so Paperboard isn't overwriting it. Restore the markers in Overleaf (its history has them), or move ${olDir()}/main.tex aside to start fresh.`];
    renderOverleaf(); return;
  }
  await writeAt(olDir() + "/main.tex", paper.main); await writeAt(OL_SENT + "/main.tex", paper.main);
  for (const f of paper.files) {
    if (f.path === "README.md") continue;
    await writeAt(olDir() + "/" + f.path, f.content);
    if (f.path === "references.bib") await writeAt(OL_SENT + "/references.bib", f.content);
  }
  olLast.stamp = await olStamp();
}

/* ---------- the clone -> the beats ---------- */
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
    const b = beatByKey(key); if (!b) { notes.push(`Overleaf edited text for a beat that no longer exists (${key}); it's in ${olDir()}/main.tex.`); continue; }
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
        conflicts[key] = { who: "Overleaf", mine: b.text, theirs: setPart(b.text, "body", approveTyped(p.body, bodyFromLatex(p, b, tBlock))), merged: setPart(b.text, "body", r.text) };
        markChanged(key); paintCard(b); updateConflictBtn(); n++; continue;
      }
      merged = r.text;
    }
    const nt = setPart(b.text, "body", approveTyped(p.body, bodyFromLatex(p, b, merged)));   // words typed in Overleaf are the author's
    if (nt !== b.text) { applyBeatText(b, nt); markChanged(key); saveTextSoon(b); n++; }
  }
  for (const key of B.blocks.keys()) if (!T.blocks.has(key) && beatByKey(key)) notes.push(`The “% beat:” line for “${beatByKey(key).title}” was removed in Overleaf, so edits there couldn't be matched. Put the line back in Overleaf.`);
  for (const [name, t] of T.sections) if (B.sections.has(name) && B.sections.get(name) !== t && !name.startsWith("end: ")) notes.push(`Overleaf changed the heading of “${name}”. Rename sections in Paperboard's Settings.`);
  return n;
}
async function applyTemplateEdits(baseTex, theirsTex, notes) {   // preamble and ending: back into export/template/main.tex
  const B = splitPaperTex(baseTex), T = splitPaperTex(theirsTex); if (!B || !T) return;
  B.pre = stripUnicodePreamble(B.pre); T.pre = stripUnicodePreamble(T.pre);   // Paperboard's own block isn't part of the template
  if (B.pre === T.pre && B.post === T.post) return;
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
  if (!(await olActive())) return;
  const notes = [], o = olOpts(); let n = 0, saw = false;
  // 1. git stopped with a conflict: the markers hold the common version, Paperboard's and Overleaf's
  let cur = await readAt(olDir() + "/main.tex");
  olInfo.waiting = false; olInfo.noBase = false;
  if (cur != null && hasGitConflict(cur) && cur === olInfo.handled) { olInfo.waiting = true; cur = gitConflictSides(cur).theirs; }   // already merged into the beats
  else if (cur != null && hasGitConflict(cur)) {
    const g = gitConflictSides(cur);
    olInfo.handled = cur;
    if (!g.hasBase) { olInfo.noBase = true; notes.push(`git stopped with a conflict but without the common version. In the project folder run: cd ${shq(olDir())} && git merge --abort; cd - >/dev/null — then use the sync command from this panel (it asks git for that version).`); olInfo.notes = notes; renderOverleaf(); return; }
    n += applyOverleaf(g.base, g.theirs, notes); await applyTemplateEdits(g.base, g.theirs, notes);
    await writeAt(OL_SENT + "/main.tex", g.theirs); cur = g.theirs; saw = true; olInfo.waiting = true;
    notes.push("Overleaf and Paperboard both changed main.tex. Paperboard merged it beat by beat; run the sync command again to send the result.");
  }
  const bibNow = await readAt(olDir() + "/references.bib");
  if (bibNow != null && hasGitConflict(bibNow)) {
    const g = gitConflictSides(bibNow);
    if (g.hasBase) { await applyBibEdits(g.base, g.theirs, notes); await writeAt(OL_SENT + "/references.bib", g.theirs); saw = true; olInfo.waiting = true; }
  }
  // 2. edits that came in with a clean pull
  const sent = await readAt(OL_SENT + "/main.tex");
  if (cur != null && !splitPaperTex(cur)) {   // a fresh Overleaf project: keep its main.tex, then put the paper in
    if (!sent) { await backupFile("overleaf-original-main.tex", cur); notes.push("Saved Overleaf's original main.tex in Backups/Overleaf and put the paper in its place."); }
  } else if (cur != null && sent != null && cur !== sent) {
    n += applyOverleaf(sent, cur, notes); await applyTemplateEdits(sent, cur, notes); saw = true;
    await writeAt(OL_SENT + "/main.tex", cur);
  }
  const curBib = olInfo.waiting ? null : await readAt(olDir() + "/references.bib"), sentBib = await readAt(OL_SENT + "/references.bib");
  if (curBib != null && sentBib != null && curBib !== sentBib) { await applyBibEdits(sentBib, curBib, notes); await writeAt(OL_SENT + "/references.bib", curBib); saw = true; }
  if (saw) {
    saveHl(); saveMetaSoon();
    olInfo.imported = Date.now(); olInfo.notes = notes;
    setStatus(n ? `Brought Overleaf's edits into ${plural(n, "beat")}.` : notes.length ? "Synced with Overleaf; see the Overleaf panel." : "Synced with Overleaf: no edits to bring in.", Object.keys(conflicts).length > 0);
    renderOverleaf();
  }
}
async function olSync() { await olImport(); await olExport(); }
async function olPoll() {   // git ran: bring the edits in
  if (!root || !meta) return;
  const repo = await olRepo(), active = !!(meta.overleaf?.on || repo);
  $("olcopy").hidden = !repo;
  if (!!repo !== olInfo.linked) { olInfo.linked = !!repo; renderOverleaf(); if (active) return enqueue("overleaf", olSync); }
  if (!active) return;
  const st = await olStamp();
  if (st !== olLast.stamp) { await enqueue("overleaf", olSync); olLast.stamp = await olStamp(); }
}

/* ---------- the Overleaf panel: the git commands, filled in ---------- */
const cleanGitUrl = u => String(u || "").trim().replace(/^git clone\s+/, "").replace(/^(https?:\/\/)[^@\/]*@/, "$1").split(/\s/)[0];
const cmdRow = (id, cmd) => `<div class="cmdrow"><code id="${id}">${esc(cmd)}</code><button class="mini" data-copy="${id}">Copy</button></div>`;
function wireCopy(box) {
  box.querySelectorAll("[data-copy]").forEach(b => b.onclick = async () => {
    const el = $(b.dataset.copy);
    try { await navigator.clipboard.writeText(el.textContent); b.textContent = "Copied"; setTimeout(() => b.textContent = "Copy", 1500); }
    catch (e) { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); }
  });
}
async function renderOverleaf() {
  const box = $("x-ol"); if (!box) return;
  const repo = await olRepo(), o = olOpts();
  const all = [...olInfo.notes, ...(olInfo.paperNotes || [])];
  const notes = all.length ? `<div class="warn">${all.map(n => `<p>${esc(n)}</p>`).join("")}</div>` : "";
  const term = olBase() ? `Paste this into Terminal and press Return:` : `In Terminal, type <code>cd </code> (with a space), drag the <b>${esc(root.name)}</b> folder into the window and press Return; then paste this and press Return:`;
  const pathRow = `<label for="x-olpath" style="margin-top:10px">This project's folder on this computer <span class="help">(optional; then the command works from any Terminal window)</span></label>
      <input type="text" id="x-olpath" class="mono" placeholder="/Users/you/Papers/${esc(root.name)}" value="${esc(olBase())}" spellcheck="false">
      <p class="help">In Finder, select the <b>${esc(root.name)}</b> folder, press ⌥⌘C (Copy as Pathname) and paste it here. The <b>Copy sync command</b> button in the toolbar copies the command any time.</p>`;
  const wirePath = () => { const el = $("x-olpath"); if (!el) return; el.onchange = () => {
    const v = el.value.trim().replace(/^file:\/\//, "").replace(/\/+$/, "");
    if (v && !/^(\/|~\/)/.test(v)) { setStatus("That should be a full path, starting with / (or ~/).", true); el.value = olBase(); return; }
    LS.set("projectPath:" + root.name, v); renderOverleaf();
    if (v && v.split("/").pop() !== root.name) setStatus(`Saved. Note that the path ends in “${v.split("/").pop()}”, not “${root.name}”.`); }; };
  if (!repo && !o.on) {   // 1. not started
    box.innerHTML = `<b>Overleaf</b> <span class="help">Paperboard writes the paper as LaTeX into a folder in the project, and you push that folder to Overleaf with git.</span>
      <label for="x-oldir">Folder</label><input type="text" id="x-oldir" class="mono" value="${esc(olDir())}" spellcheck="false">
      <div class="btnrow"><button id="x-olstart" class="primary">Start writing the paper there</button></div>
      <p class="help">It gets main.tex (the paper, from the template and the beats), the template's files, references.bib and the figures. Already have a git clone of the Overleaf project in the project folder? Put its folder above and press Start; Paperboard will use it.</p>${notes}`;
    const dir = $("x-oldir");
    dir.onchange = () => { const v = relPath(dir.value); if (v && !/^(Beats|Notes|References|Backups|code|data|results|figures)(\/|$)/.test(v) && v !== "export/template") { o.dir = v; dir.value = v; saveMetaSoon(); } else dir.value = olDir(); };
    $("x-olstart").onclick = async () => { o.on = true; saveMetaSoon(); await enqueue("overleaf", olSync); renderOverleaf(); setStatus(`Writing the paper into ${olDir()}.`); };
    return;
  }
  if (!repo) {   // 2. writing, not yet pushed: the first push
    box.innerHTML = `<b>Overleaf</b> <span class="help">Paperboard is writing the paper into <code>${esc(olDir())}</code>. To put it in your Overleaf project, once:</span>
      <ol class="olsteps">
        <li>In Overleaf, open the project, copy its Git link (Menu &gt; Integrations &gt; Git) and paste it here:
          <input type="text" id="x-olurl" class="mono" placeholder="https://git.overleaf.com/0123456789abcdef01234567" value="${esc(o.url || "")}" spellcheck="false"></li>
        <li>${term}${cmdRow("x-olfirst", olFirstCmd(o.url || "<the Git link>"))}
          When git asks, the username is <code>git</code> and the password is an Overleaf Git token (Account Settings &gt; Git integration). macOS keeps it in your Keychain, so you're asked only once.</li>
      </ol>${pathRow}
      <p class="help">This makes the folder a git repository and pushes the paper to Overleaf. If the Overleaf project already has a starter main.tex, Paperboard's version replaces it (the starter stays in Overleaf's history).</p>${notes}`;
    const url = $("x-olurl");
    url.oninput = () => { o.url = cleanGitUrl(url.value); saveMetaSoon(); $("x-olfirst").textContent = olFirstCmd(o.url || "<the Git link>"); };
    wireCopy(box); wirePath(); renderOverleafLater(); return;
  }
  box.innerHTML = `<b>Overleaf</b> <span class="help">Linked: <code>${esc(olDir())}</code> is a git repository for your Overleaf project, and Paperboard keeps the paper in it as main.tex (with the template's files, references.bib and the figures).${olInfo.imported ? ` Last brought Overleaf's edits in at ${fmtTime(olInfo.imported)}.` : ""}</span>
    <p class="help" style="margin-top:8px">To sync after a round of edits, ${term.replace(/^In Terminal/, "in Terminal").replace(/then paste this and press Return:$/, "then run:")}</p>
    ${cmdRow("x-olsync", olSyncCmd())}
    <p class="help">It sends Paperboard's version, brings in Overleaf's, and Paperboard merges Overleaf's edits back into the beats within a few seconds. If git says there's a conflict, Paperboard merges it beat by beat (asking you where the same lines changed on both sides); then run the same command again.</p>${pathRow}${notes}`;
  wireCopy(box); wirePath();
}
function renderOverleafLater() { clearTimeout(renderOverleafLater.t); renderOverleafLater.t = setTimeout(async () => { if (await olRepo()) renderOverleaf(); else renderOverleafLater(); }, 4000); }

/* the toolbar's Copy sync command: the same command as the panel, one click away */
$("olcopy").onclick = async () => {
  const cmd = olSyncCmd(), btn = $("olcopy");
  try { await navigator.clipboard.writeText(cmd); } catch (e) { showOverleafPanel(); return; }
  btn.textContent = "Copied"; setTimeout(() => btn.textContent = "Copy sync command", 1500);
  setStatus(olBase() ? "Sync command copied: paste it into Terminal." : `Sync command copied. In Terminal, cd into the ${root.name} folder first (or give its path in the Overleaf panel, and the command works from anywhere).`);
};
