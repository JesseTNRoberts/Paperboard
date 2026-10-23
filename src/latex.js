
/* ================= LaTeX: assemble the paper from the beats and compile it to PDF in the browser =================
   The paper is built in document order: each section is a \section (an "Abstract" section becomes the abstract),
   Paragraph beats are their text converted from Markdown (LaTeX passes through), Figure and Table beats become floats.
   It goes into the conference template at export/template/main.tex, at the line "%% PAPERBOARD BODY" (or where it says
   \input{paperboard-body}); without a template, a plain article is used. Compiling uses TeX Live compiled to WebAssembly
   (texlyre-busytex, AGPL-3.0), downloaded once (about 225 MB) and then cached by the browser. */
const TEMPLATE_DIR = "export/template", MAIN_TEX = TEMPLATE_DIR + "/main.tex", BODY_MARK = /^[ \t]*%%[ \t]*PAPERBOARD[ \t]+BODY.*$/m, BODY_INPUT = /\\input\s*\{\s*paperboard-body(?:\.tex)?\s*\}/;
const DEFAULT_TEMPLATE = (title, hasBib) => `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{microtype}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[authoryear,round]{natbib}
\\usepackage{hyperref}
\\title{${texEscape(title)}}
\\author{}
\\date{\\today}
\\begin{document}
\\maketitle
%% PAPERBOARD BODY
${hasBib ? "\\bibliographystyle{plainnat}\n\\bibliography{references}\n" : ""}\\end{document}
`;
const latexOpts = () => { meta.latex ||= {}; meta.latex.include ||= {}; meta.latex.engine ||= "pdflatex"; return meta.latex; };
const INCLUDABLE = ["Experiment", "References", "Note"];   // left out unless you tick them

/* ---------- the body ---------- */
function floatTex(b, p, kind) {   // a Figure or Table beat as a float
  const outs = listField(p.fields.output).map(relPath).filter(Boolean);
  const label = (p.fields.label || "").trim() || `${kind === "figure" ? "fig" : "tab"}:${slugify(b.title)}`;
  const env = /^(yes|true|full|wide)$/i.test(p.fields.wide || "") ? kind + "*" : kind;
  const short = p.fields.caption ? mdInline(p.fields.caption) : "", long = p.body.trim() ? mdInline(p.body.trim().replace(/\n+/g, " ")) : short;
  let inner;
  if (kind === "figure") {
    const pick = outs.find(o => /\.pdf$/i.test(o)) || outs.find(o => /\.(png|jpe?g)$/i.test(o)) || outs[0];
    inner = pick ? `  \\includegraphics[width=${p.fields.width || "\\linewidth"}]{${pick}}` : `  \\fbox{\\parbox{0.9\\linewidth}{\\centering Figure “${texEscape(b.title)}” has no Output yet.}}`;
  } else {
    const tex = outs.find(o => /\.tex$/i.test(o)), csv = outs.find(o => /\.(csv|tsv)$/i.test(o)), img = outs.find(o => /\.(pdf|png|jpe?g)$/i.test(o));
    inner = tex ? `  \\input{${tex}}` : csv ? `  %%CSV:${csv}%%` : img ? `  \\includegraphics[width=\\linewidth]{${img}}` : `  \\fbox{Table “${texEscape(b.title)}” has no Output yet.}`;
  }
  const cap = long ? `  \\caption${short && short !== long ? `[${short}]` : ""}{${long}}\n` : "";
  return kind === "table" ? `\\begin{${env}}[t]\n  \\centering\n${cap}${inner}\n  \\label{${label}}\n\\end{${env}}` : `\\begin{${env}}[t]\n  \\centering\n${inner}\n${cap}  \\label{${label}}\n\\end{${env}}`;
}
function beatLatex(b, p = beatParts(b.text)) {   // one beat's LaTeX ("" for an empty beat)
  if (p.type === "Figure") return floatTex(b, p, "figure");
  if (p.type === "Table") return floatTex(b, p, "table");
  if (!p.body.trim()) return "";
  if (p.type === "Paragraph") return mdToLatex(p.body);
  return `\\paragraph{${mdInline(b.title)}.}\n` + mdToLatex(p.body);
}
const beatIncluded = p => !(INCLUDABLE.includes(p.type) && !latexOpts().include[p.type]);
function buildBody() {
  const parts = [];
  docOrder().forEach(({ act, beats: list }) => {
    const isAbstract = /^abstract$/i.test(act.name.trim());
    const chunk = [];
    list.forEach(b => {
      const p = beatParts(b.text); if (!beatIncluded(p)) return;
      const tag = `% beat: ${b.title.replace(/\n/g, " ")} (${b.key})`, tex = beatLatex(b, p);
      chunk.push(tex ? tag + "\n" + tex : tag + " (empty)");
    });
    if (isAbstract) { if (chunk.length) parts.push(`% section: ${act.name}\n\\begin{abstract}\n${chunk.join("\n\n")}\n% end: ${act.name}\n\\end{abstract}`); }
    else parts.push(`% section: ${act.name}\n\\section{${mdInline(act.name)}}\n\\label{sec:${slugify(act.name)}}\n\n${chunk.join("\n\n")}`);
  });
  return `% Written by Paperboard from the beats, in document order. Edit the beats, not this file.\n\n${parts.join("\n\n")}\n`;
}
async function csvTable(path) {   // a CSV table output, as a booktabs tabular
  const f = await fileAt(path); if (!f) return `\\fbox{Missing ${texEscape(path)}}`;
  const rows = csvRows(await f.text(), /\.tsv$/i.test(path) ? "\t" : ",", 500).filter(r => r.some(c => c.trim()));
  if (!rows.length) return "";
  const n = Math.max(...rows.map(r => r.length)), al = rows[1] ? rows[1].map(c => /^-?[\d.,]+%?$/.test(c.trim()) ? "r" : "l").join("") : "l".repeat(n);
  return `\\begin{tabular}{${al.padEnd(n, "l")}}\n\\toprule\n${rows[0].map(texEscape).join(" & ")} \\\\\n\\midrule\n${rows.slice(1).map(r => r.map(texEscape).join(" & ") + " \\\\").join("\n")}\n\\bottomrule\n\\end{tabular}`;
}
/* the whole paper: the template with the body put in, and every file the compile needs */
async function assemblePaper() {
  let body = buildBody();
  for (const m of [...body.matchAll(/^  %%CSV:(.+)%%$/gm)]) body = body.replace(m[0], (await csvTable(m[1])).replace(/^/gm, "  "));
  const tmplFile = await fileAt(MAIN_TEX), bib = await fileAt("References/references.bib");
  let main = tmplFile ? await tmplFile.text() : DEFAULT_TEMPLATE(root.name, !!bib && /\\cite|\\citep|\\citet/.test(body));
  const notes = [];
  if (BODY_MARK.test(main)) main = main.replace(BODY_MARK, () => BODY_START + "\n" + body + BODY_END);
  else if (BODY_INPUT.test(main)) main = main.replace(BODY_INPUT, () => BODY_START + "\n" + body + BODY_END);
  else {
    const at = main.search(/\\bibliography\s*\{|\\printbibliography|\\end\{document\}/);
    if (at < 0) throw new Error(`${MAIN_TEX} has no \\end{document}.`);
    main = main.slice(0, at) + BODY_START + "\n" + body + BODY_END + "\n" + main.slice(at);
    notes.push(`${MAIN_TEX} has no “%% PAPERBOARD BODY” line, so the paper went in before the bibliography. Add that line where the paper belongs.`);
  }
  const files = [];   // template files (except main.tex), at the top level as the template expects
  const tdir = await handleAt(TEMPLATE_DIR, "dir");
  if (tdir) for (const f of await listFiles(TEMPLATE_DIR, 4)) { if (f.path === MAIN_TEX) continue; files.push({ path: f.path.slice(TEMPLATE_DIR.length + 1), content: new Uint8Array(await (await fileAt(f.path)).arrayBuffer()) }); }
  if (bib) files.push({ path: "references.bib", content: await bib.text() });
  const missing = [];
  for (const a of new Set([...latexAssets(main)])) {   // figures and \input files, from the project at the same paths
    const rp = relPath(a); if (!rp || files.some(f => f.path === rp)) continue;
    const cands = /\.[a-z0-9]+$/i.test(rp) ? [rp] : [rp + ".pdf", rp + ".png", rp + ".jpg", rp + ".tex"];
    let found = false;
    for (const c of cands) { const f = await fileAt(c); if (f) { files.push({ path: c, content: new Uint8Array(await f.arrayBuffer()) }); found = true; break; } }
    if (!found && !files.some(f => f.path === rp || f.path.startsWith(rp + "."))) missing.push(a);
  }
  if (missing.length) notes.push(`Not found in the project: ${missing.join(", ")}.`);
  return { main, body, files, notes, template: tmplFile ? MAIN_TEX : null };
}

/* ---------- the TeX engine (loaded on first use) ---------- */
let texRunner = null, texLoading = null, texProgress = null;
const vendorURL = p => new URL("vendor/" + p, location.href);
function canCompile() { return /^https?:$/.test(location.protocol) && !!window.Worker && !!window.WebAssembly; }
async function texEngine() {
  if (texRunner) return texRunner;
  if (texLoading) return texLoading;
  texLoading = (async () => {
    const lib = await import(vendorURL("texlyre-busytex/index.js").href);
    const base = vendorURL("busytex").pathname.replace(/\/$/, "");
    const runner = new lib.BusyTexRunner({ busytexBasePath: base, preloadDataPackages: [base + "/texlive-recommended.js"], onDownloadProgress: pr => texProgress && texProgress(pr) });
    await runner.initialize(true);
    texRunner = { runner, lib };
    return texRunner;
  })();
  try { return await texLoading; } catch (e) { texLoading = null; throw e; }
}

/* ---------- the PDF panel ---------- */
let pdfURL = null, compiling = false, lastCompile = null;
function texErrors(log, main) {   // "! …" errors with the line they point at, mapped back to the beat
  const lines = log.split("\n"), mainLines = main.split("\n"), errs = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("!")) continue;
    let ln = null, ctx = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) { const m = lines[j].match(/^l\.(\d+)\s?(.*)$/); if (m) { ln = +m[1]; ctx = m[2]; break; } }
    let beat = null, section = null;
    if (ln) for (let k = Math.min(ln, mainLines.length) - 1; k >= 0; k--) {
      const id = beatTagId(mainLines[k]); if (id) { beat = id; break; }
      if (/^% ---- PAPERBOARD BODY START/.test(mainLines[k])) break;
    }
    const msg = lines[i].replace(/^!\s*/, ""), miss = msg.match(/File `([^']+)' not found/);
    if (errs.some(e => e.msg === msg && e.line === ln)) continue;
    errs.push({ msg, line: ln, ctx, beat, missing: miss ? miss[1] : null });
  }
  return errs;
}
function showPdfPanel() {
  activeKey = null; setPanelMode("half"); panel.classList.add("pdfp");
  const o = latexOpts();
  panel.innerHTML = `<header><div><div class="eyebrow">Paper</div><h2>PDF</h2></div><div class="hdrright"><button class="x" aria-label="Close">✕</button></div></header>
    <div class="pdfbar">
      <button id="x-compile" class="primary">Compile</button>
      <select id="x-engine" aria-label="TeX engine">${[["pdflatex", "pdfLaTeX"], ["xelatex", "XeLaTeX"], ["lualatex", "LuaLaTeX"]].map(([v, l]) => `<option value="${v}"${o.engine === v ? " selected" : ""}>${l}</option>`).join("")}</select>
      <span class="incl">Also include: ${INCLUDABLE.map(t => `<label><input type="checkbox" data-inc="${t}"${o.include[t] ? " checked" : ""}> ${t}</label>`).join(" ")}</span>
      <span class="grow"></span><a id="x-open" href="#" target="_blank" rel="noopener" hidden>Open in a new tab</a>
    </div>
    <p class="help" id="x-tmpl"></p>
    <div class="olbox" id="x-ol"></div>
    <div id="x-status" class="xstatus" role="status"></div>
    <div id="x-errs"></div>
    <div class="pdfview" id="x-view"><div class="empty">${canCompile() ? "Compile to see the paper." : "Compiling needs the online app (https://jessetnroberts.com/Paperboard/) in Chrome or Edge. Claude can also compile export/paper.tex for you."}</div></div>`;
  panel.hidden = false; panel.querySelector(".x").onclick = () => { panel.classList.remove("pdfp"); closePanel(); };
  $("x-engine").onchange = e => { latexOpts().engine = e.target.value; saveMetaSoon(); };
  panel.querySelectorAll("[data-inc]").forEach(c => c.onchange = () => { latexOpts().include[c.dataset.inc] = c.checked; saveMetaSoon(); });
  $("x-compile").onclick = compilePaper;
  (async () => { const t = await fileAt(MAIN_TEX); const el = $("x-tmpl"); if (el) el.innerHTML = t ? `Template: <code>${MAIN_TEX}</code>. Output: <code>export/paper.pdf</code>, with <code>export/paper.tex</code> and <code>export/paper.log</code>.` : `No conference template yet, so a plain article is used. Ask Claude to set up the conference's official template in <code>${TEMPLATE_DIR}/</code> (with a <code>%% PAPERBOARD BODY</code> line where the paper goes).`; })();
  if (lastCompile) renderCompile(lastCompile);
  renderOverleaf();
}
function setX(t, err) { const s = $("x-status"); if (s) { s.textContent = t; s.classList.toggle("err", !!err); } }
async function compilePaper() {
  if (compiling) return;
  if (!canCompile()) return setX("Compiling needs the online app in Chrome or Edge.", true);
  compiling = true; const btn = $("x-compile"); if (btn) { btn.disabled = true; btn.textContent = "Compiling…"; }
  const t0 = performance.now();
  try {
    setX("Putting the paper together…");
    await flushCode(); for (const b of beats) if (textTimers[b.key]) await flushBeat(b);
    const paper = await assemblePaper();
    const exp = await subdir("export", true);
    await writeText(exp, "paper.tex", paper.main);
    if (!texRunner) setX("Loading TeX (the first time downloads about 225 MB; after that it's cached)…");
    texProgress = pr => setX(`Downloading TeX: ${Math.round(pr.percent || 0)}% (${Math.round((pr.loaded || 0) / 1e6)} of ${Math.round((pr.total || 0) / 1e6)} MB). This happens once.`);
    const { runner, lib } = await texEngine();
    texProgress = null;
    setX("Compiling…");
    const engine = latexOpts().engine, Tool = engine === "xelatex" ? lib.XeLatex : engine === "lualatex" ? lib.LuaLatex : lib.PdfLatex;
    const r = await new Tool(runner).compile({ input: paper.main, bibtex: /\\bibliography\s*\{/.test(paper.main), rerun: true, additionalFiles: paper.files });
    await writeText(exp, "paper.log", r.log || "");
    if (r.pdf && r.pdf.length) { const h = await exp.getFileHandle("paper.pdf", { create: true }), w = await h.createWritable(); await w.write(r.pdf); await w.close(); }
    lastCompile = { ok: !!(r.pdf && r.pdf.length), pdf: r.pdf, errors: texErrors(r.log || "", paper.main), notes: paper.notes, secs: (performance.now() - t0) / 1000 };
    renderCompile(lastCompile);
    setStatus(lastCompile.ok ? "Compiled export/paper.pdf" : "Compile failed: see the PDF panel", !lastCompile.ok);
  } catch (e) {
    console.error(e); setX("Couldn't compile: " + (e.message || e), true);
  } finally { compiling = false; const b2 = $("x-compile"); if (b2) { b2.disabled = false; b2.textContent = "Compile"; } }
}
function renderCompile(c) {
  if (!$("x-view")) return;
  if (c.ok) {
    if (pdfURL) setTimeout(((u) => () => URL.revokeObjectURL(u))(pdfURL), 30000);
    pdfURL = URL.createObjectURL(new Blob([c.pdf], { type: "application/pdf" }));
    $("x-view").innerHTML = `<iframe title="Compiled paper" src="${esc(pdfURL)}"></iframe>`;
    const a = $("x-open"); a.href = pdfURL; a.hidden = false;
  } else $("x-view").innerHTML = `<div class="empty">No PDF this time. The first error is usually the one to fix.</div>`;
  const errs = c.errors.slice(0, 8);
  const missing = errs.filter(e => e.missing);
  setX(c.ok ? `Compiled in ${c.secs.toFixed(1)} s${errs.length ? `, with ${plural(c.errors.length, "error")}` : ""}. Saved export/paper.pdf.` : `Didn't compile (${plural(c.errors.length, "error")}).`, !c.ok);
  $("x-errs").innerHTML = (c.notes.length ? `<div class="warn">${c.notes.map(n => `<p>${esc(n)}</p>`).join("")}</div>` : "") + (errs.length ? `<div class="warn texerrs">${errs.map(e => {
    const b = e.beat && beatByKey(e.beat);
    return `<p><b>${esc(e.msg)}</b>${e.ctx ? ` <code>${esc(e.ctx.slice(0, 80))}</code>` : ""}${b ? ` <button class="mini" data-k="${esc(b.key)}">Open “${esc(b.title)}”</button>` : e.line ? ` <span class="help">line ${e.line} of export/paper.tex</span>` : ""}</p>`;
  }).join("")}${missing.length ? `<p>${missing.map(e => `<code>${esc(e.missing)}</code>`).join(", ")} isn't in the in-browser TeX. Remove it from <code>${MAIN_TEX}</code>, or ask Claude to compile <code>export/paper.tex</code> with full TeX Live.</p>` : ""}<p class="help">Full log: export/paper.log</p></div>` : "");
  $("x-errs").querySelectorAll("[data-k]").forEach(btn => btn.onclick = () => { panel.classList.remove("pdfp"); openBeat(btn.dataset.k); });
}
$("pdfbtn").onclick = () => { if (meta) showPdfPanel(); };
