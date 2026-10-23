
/* ================= LaTeX: the paper assembled from the beats, for Overleaf =================
   The paper is built in document order: each section is a \section (an "Abstract" section becomes the abstract),
   Paragraph beats are their text converted from Markdown (LaTeX passes through), Figure and Table beats become floats.
   It goes into the conference template at export/template/main.tex, at the line "%% PAPERBOARD BODY" (or where it says
   \input{paperboard-body}); without a template, a plain article is used. Overleaf compiles it (see overleaf.js). */
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
const latexOpts = () => { meta.latex ||= {}; meta.latex.include ||= {}; return meta.latex; };
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
  return `\\begin{tabular}{${al.padEnd(n, "l")}}\n\\toprule\n${rows[0].map(c => uniToTex(texEscape(c))).join(" & ")} \\\\\n\\midrule\n${rows.slice(1).map(r => r.map(c => uniToTex(texEscape(c))).join(" & ") + " \\\\").join("\n")}\n\\bottomrule\n\\end{tabular}`;
}
/* the whole paper: the template with the body put in, and every file it needs */
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

/* ---------- the Overleaf panel: template, what to include, and the sync ---------- */
function showOverleafPanel() {
  activeKey = null; setPanelMode(null); panel.classList.add("olp");
  const o = latexOpts();
  panel.innerHTML = `<header><div><div class="eyebrow">Paper</div><h2>Overleaf</h2></div><button class="x" aria-label="Close">✕</button></header>
    <p class="help">Paperboard builds the paper's LaTeX from the beats, in document order, and Overleaf compiles it.</p>
    <p class="help" id="x-tmpl"></p>
    <p class="incl">Also include: ${INCLUDABLE.map(t => `<label><input type="checkbox" data-inc="${t}"${o.include[t] ? " checked" : ""}> ${t} beats</label>`).join(" ")}</p>
    <div class="olbox" id="x-ol"></div>`;
  panel.hidden = false; panel.querySelector(".x").onclick = closePanel;
  panel.querySelectorAll("[data-inc]").forEach(c => c.onchange = () => { latexOpts().include[c.dataset.inc] = c.checked; saveMetaSoon(); });
  (async () => { const t = await fileAt(MAIN_TEX); const el = $("x-tmpl"); if (el) el.innerHTML = t ? `Template: <code>${MAIN_TEX}</code>.` : `No conference template yet, so a plain article is used. Ask Claude to set up the conference's official template in <code>${TEMPLATE_DIR}/</code> (with a <code>%% PAPERBOARD BODY</code> line where the paper goes).`; })();
  renderOverleaf();
}
$("olbtn").onclick = () => { if (meta) showOverleafPanel(); };
