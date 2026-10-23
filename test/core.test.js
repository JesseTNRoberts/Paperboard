// Round-trip and merge tests for the core functions, run with: node test/core.test.js <core.js> <beats dir>
const fs = require("fs"), path = require("path"), assert = require("assert");
const C = require(path.resolve(process.argv[2]));
const dir = process.argv[3];
let n = 0, fail = 0;
const t = (name, fn) => { n++; try { fn(); } catch (e) { fail++; console.log("FAIL", name, "\n ", e.message.split("\n").slice(0, 8).join("\n  ")); } };

const PARTS = ["syn", "adj", "body", "notes"];
const files = fs.readdirSync(dir).filter(f => f.endsWith(".md")).map(f => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
// extra edge cases beyond the sample folder
files.push(["(empty file)", ""], ["(crlf)", "ID: b-x\r\nType: Figure\r\nSynopsis: s\r\n\r\nClaude adjust:\r\n\r\n---\r\n\r\nBody\r\n"],
  ["(no trailing newline after divider)", "ID: b-y\nSynopsis: a\n\nClaude adjust:\n\n---"],
  ["(notes only)", "ID: b-z\nSynopsis:\n\nClaude adjust:\n\n---\n\n=== Notes ===\n\nonly notes\n"],
  ["(new template)", C.newBeatText("b-new000")]);

for (const [f, text] of files) {
  const p = C.beatParts(text);
  t(`${f}: rebuilding each part with its own value is byte-identical`, () => {
    for (const part of PARTS) assert.strictEqual(C.setPart(text, part, p[part]), text, part);
    for (const k of Object.keys(p.fields)) assert.strictEqual(C.setField(text, k, p.fields[k]), text, "field " + k);
  });
  for (const part of PARTS) t(`${f}: editing ${part} changes only ${part}`, () => {
    const v = part === "body" && !p.ok ? "Changed body\nsecond line" : (p[part] ? p[part] + " EDITED" : "New " + part + " text");
    const out = C.setPart(text, part, v), q = C.beatParts(out);
    assert.strictEqual(q[part], v.trim(), "new value read back");
    for (const other of PARTS) if (other !== part) assert.strictEqual(q[other], p[other], other + " unchanged");
    assert.deepStrictEqual(q.fields, Object.assign({}, p.ok ? p.fields : {}, q.fields), "fields kept");
    if (p.ok) {   // and the bytes outside that part are identical
      const P = C.parseBeat(text), s = P[part];
      if (!s.missing && s.cs !== s.ce) assert.strictEqual(out.slice(0, s.cs) + out.slice(s.cs + v.length), text.slice(0, s.cs) + text.slice(s.ce), "bytes outside the part");
    }
    assert.strictEqual(C.setPart(out, part, p[part]) === text || !p[part] || !p.ok, true, "editing back restores the file when the part was non-empty");
  });
  t(`${f}: setting a field changes only that line`, () => {
    const out = C.setField(text, "Status", "edited status"), q = C.beatParts(out);
    assert.strictEqual(q.status, "edited status");
    for (const other of PARTS) assert.strictEqual(q[other], p[other], other);
    if (p.ok && "status" in p.fields) assert.strictEqual(out.split("\n").length, text.split("\n").length);
  });
}
t("emptying a part then refilling it is stable", () => {
  const f = files.find(x => x[0] === "Contributions.md")[1];
  const a = C.setPart(f, "adj", ""), b = C.setPart(a, "adj", "Again");
  assert.strictEqual(C.beatParts(a).adj, ""); assert.strictEqual(C.beatParts(b).adj, "Again");
  assert.ok(a.includes("Claude adjust:\n\n---\n"), a);
});
t("a bare --- typed into the synopsis can't break the header", () => {
  const f = C.newBeatText("b-q"), out = C.setPart(f, "syn", "one\n---\ntwo");
  assert.strictEqual(C.beatParts(out).body, ""); assert.ok(C.beatParts(out).syn.includes("– – –"));
});
t("=== Notes === typed into the body can't start the notes", () => {
  const out = C.setPart(C.newBeatText("b-q"), "body", "a\n=== Notes ===\nb");
  assert.strictEqual(C.beatParts(out).notes, ""); assert.ok(C.beatParts(out).body.includes("b"));
});
t("multi-line synopsis and inline adjust are read", () => {
  const p = C.beatParts(files.find(x => x[0] === "Results overview.md")[1]);
  assert.strictEqual(p.syn, "The corrected sensors track the reference monitors closely,\nexcept during wildfire smoke events.");
  assert.strictEqual(p.adj, "Draft this once the calibration run finishes.");
});
t("free-form file keeps its text as the body when a header is added", () => {
  const f = files.find(x => x[0] === "Satellite idea.md")[1], out = C.setField(f, "ID", "b-sat");
  assert.ok(out.endsWith(f)); assert.strictEqual(C.beatParts(out).id, "b-sat"); assert.strictEqual(C.beatParts(out).body, f.trim());
});
t("type defaults to Paragraph", () => { assert.strictEqual(C.beatParts("Synopsis:\n\nClaude adjust:\n\n---\n").type, "Paragraph"); });

/* merges */
const body = "ID: b-1\nSynopsis: s\n\nClaude adjust:\n\n---\n\nPara one.\n\nPara two is the last paragraph.\n";
t("you edit the last paragraph while Claude appends notes below it: clean merge", () => {
  const mine = body.replace("Para two is the last paragraph.", "Para two, now edited by me.");
  const theirs = body + "\n=== Notes ===\n\nClaude adjust (done 2026-10-23):\n\nDid the thing.\n";
  const r = C.merge3(body, mine, theirs);
  assert.strictEqual(r.conflict, false, r.text);
  assert.ok(r.text.includes("Para two, now edited by me.") && r.text.includes("Did the thing."), r.text);
});
t("you append notes while Claude edits the body: clean merge", () => {
  const mine = body + "\n=== Notes ===\n\nmy note\n", theirs = body.replace("Para one.", "Para one, revised by Claude.");
  const r = C.merge3(body, mine, theirs); assert.strictEqual(r.conflict, false); assert.ok(r.text.includes("revised by Claude") && r.text.includes("my note"));
});
t("same line changed both ways: conflict with markers", () => {
  const r = C.merge3(body, body.replace("Para one.", "Mine."), body.replace("Para one.", "Theirs."));
  assert.strictEqual(r.conflict, true); assert.ok(C.hasMarkers(r.text));
});
t("edits above and below each other merge", () => {
  const b = "a\nb\nc\nd\ne\n", r = C.merge3(b, "A\nb\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
  assert.deepStrictEqual(r, { text: "A\nb\nc\nd\nE\n", conflict: false });
});
t("Claude inserts lines in the middle of a paragraph you are editing at its end", () => {
  const b = "p1\np2\np3\n", r = C.merge3(b, "p1\np2\np3 mine\n", "p1\nnew\np2\np3\n");
  assert.deepStrictEqual(r, { text: "p1\nnew\np2\np3 mine\n", conflict: false });
});

/* cursor */
t("cursor stays on the same words with changes above and below", () => {
  const old = "alpha\nbeta gamma\ndelta\n", nw = "new first line\nalpha\nbeta gamma\ndelta\nnew last line\n";
  const pos = old.indexOf("gamma"); assert.strictEqual(C.mapCaret(old, nw, pos), nw.indexOf("gamma"));
});
t("cursor on a line Claude rewrote stays on that line", () => {
  const old = "a\nthe line I'm on\nc\n", nw = "x\ny\na\nthe line I am on now\nc\n";
  const pos = old.indexOf("line"), np = C.mapCaret(old, nw, pos);
  assert.strictEqual(nw.slice(0, np).split("\n").length, 4);
});
t("cursor when changes are on the same line before and after it (prefix/suffix trap)", () => {
  const old = "one\ntwo\nthree\nfour\n", nw = "zero\none\ntwo\nthree\nfour\nfive\n";
  for (let p = 0; p < old.length; p++) { const np = C.mapCaret(old, nw, p); const s = old.slice(p, p + 3); assert.strictEqual(nw.slice(np, np + s.length), s, "pos " + p); }
});

/* layout merge */
t("layout merges card by card; your position wins on a clash", () => {
  const base = { beats: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 20, y: 0 } }, acts: [{ id: "s1", name: "Intro", x: 0 }], notes: [] };
  const local = JSON.parse(JSON.stringify(base)); local.beats.a.x = 100; local.beats.c.x = 300;
  const disk = JSON.parse(JSON.stringify(base)); disk.beats.b.x = 200; disk.beats.c.x = 999; disk.beats.d = { x: 5, y: 5 }; disk.acts[0].name = "Introduction";
  const changed = new Set(), clashes = new Set(), m = C.mergeMeta(base, local, disk, changed, clashes);
  assert.strictEqual(m.beats.a.x, 100); assert.strictEqual(m.beats.b.x, 200); assert.strictEqual(m.beats.c.x, 300); assert.ok(m.beats.d);
  assert.strictEqual(m.acts[0].name, "Introduction"); assert.deepStrictEqual([...clashes], ["c"]); assert.ok(changed.has("b") && changed.has("d") && changed.has("c"));
});
t("file names", () => {
  assert.deepStrictEqual(C.titleOfFile("TO DELETE - Old outline.md"), { title: "Old outline", deleted: true });
  assert.strictEqual(C.cleanTitle("a/b: c?.md"), "a b c");
  assert.strictEqual(C.titleOfFile(".DS_Store"), null);
});
t("typing character by character (with spaces mid-way) leaves no stray spaces", () => {
  for (const part of ["syn", "adj", "body", "notes"]) {
    let f = files.find(x => x[0] === "Contributions.md")[1]; const start = C.beatParts(f)[part], typed = " Added more words.";
    for (let i = 1; i <= typed.length; i++) f = C.setPart(f, part, start + typed.slice(0, i));
    const want = C.setPart(files.find(x => x[0] === "Contributions.md")[1], part, start + typed);
    assert.strictEqual(f, want, part); assert.ok(!/ \n/.test(f.replace(/Synopsis: /, "")), part + " has a space before a newline");
  }
});
/* Markdown + LaTeX */
t("prose specials are escaped, LaTeX passes through", () => {
  const out = C.mdInline("30% of A&B_c costs $5 #1, but $x_i^2$ and \\SI{3}{\\percent} and \\ref{fig:a} stay");
  assert.strictEqual(out, "30\\% of A\\&B\\_c costs \\$5 \\#1, but $x_i^2$ and \\SI{3}{\\percent} and \\ref{fig:a} stay");
});
t("citations: Pandoc brackets, several keys, prefix/suffix, in-text, cross-refs", () => {
  assert.strictEqual(C.mdInline("[@a]"), "\\citep{a}");
  assert.strictEqual(C.mdInline("[@a; @b]"), "\\citep{a,b}");
  assert.strictEqual(C.mdInline("[see @a, p. 3]"), "\\citep[see][p. 3]{a}");
  assert.strictEqual(C.mdInline("[@a, ch. 2]"), "\\citep[ch. 2]{a}");
  assert.strictEqual(C.mdInline("As @smith2020 show"), "As \\citet{smith2020} show");
  assert.strictEqual(C.mdInline("see @fig:calib and [@tab:x]"), "see \\ref{fig:calib} and \\ref{tab:x}");
  assert.strictEqual(C.mdInline("mail me at a@b.org"), "mail me at a@b.org");
});
t("emphasis, code, quotes, links", () => {
  assert.strictEqual(C.mdInline('**b** and *i* and _u_ and `a_b` and "q" and [t](https://x.org/a_b)'), '\\textbf{b} and \\emph{i} and \\emph{u} and \\texttt{a\\_b} and ``q\'\' and \\href{https://x.org/a_b}{t}');
  assert.strictEqual(C.mdInline("snake_case_word stays"), "snake\\_case\\_word stays");
});
t("blocks: lists, quotes, images, tables, environments, display math", () => {
  const out = C.mdToLatex("Para one\nline two.\n\n- a\n- b\n\n1. x\n\n> q\n\n![Cap](../figures/f.png)\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n\\begin{equation}\na_1 = 2\n\\end{equation}\n\n$$\nx_2\n$$");
  for (const want of ["Para one\nline two.", "\\begin{itemize}\n  \\item a\n  \\item b\n\\end{itemize}", "\\begin{enumerate}\n  \\item x\n\\end{enumerate}", "\\begin{quote}\nq\n\\end{quote}",
    "\\includegraphics[width=\\linewidth]{figures/f.png}", "\\caption{Cap}", "\\begin{tabular}{lr}", "1 & 2 \\\\", "\\begin{equation}\na_1 = 2\n\\end{equation}", "\\[\nx_2\n\\]"]) assert.ok(out.includes(want), want + "\n---\n" + out);
});
t("figure paths and \\input files are found for the compile", () => {
  assert.deepStrictEqual(C.latexAssets("\\includegraphics[width=1cm]{figures/a.pdf} \\input{tables/t.tex}"), ["figures/a.pdf", "tables/t.tex"]);
});
t("the generated paper splits back into its beats, sections and template", () => {
  const tex = "\\documentclass{article}\n\\begin{document}\n" + C.BODY_START + "\n% section: Abstract\n\\begin{abstract}\n% beat: Summary (b-a)\nShort summary.\n% end: Abstract\n\\end{abstract}\n\n% section: Intro\n\\section{Intro}\n\n% beat: First (b-1)\nPara one.\n\n% beat: Empty one (b-2) (empty)\n\n% beat: Fig (b-3)\n\\begin{figure}x\\end{figure}\n" + C.BODY_END + "\n\\end{document}\n";
  const s = C.splitPaperTex(tex);
  assert.strictEqual(s.blocks.get("b-a"), "Short summary.");
  assert.strictEqual(s.blocks.get("b-1"), "Para one.");
  assert.strictEqual(s.blocks.get("b-2"), "");
  assert.strictEqual(s.blocks.get("b-3"), "\\begin{figure}x\\end{figure}");
  assert.strictEqual(s.pre, "\\documentclass{article}\n\\begin{document}\n");
  assert.strictEqual(s.post, "\n\\end{document}\n");
  assert.strictEqual(C.splitPaperTex("no markers"), null);
});
t("LaTeX edited in Overleaf comes back as Markdown when it can, LaTeX when it can't", () => {
  for (const md of ["Urban **air** is *often* measured [@a; @b], as @c show (see @fig:x); 30% & more.", "Text with `code_x` and \"quotes\" and [see @a, p. 3]."]) {
    const tex = C.mdToLatex(md); assert.strictEqual(C.latexToMd(tex), md);
    const edited = tex.replace("measured", "measured hourly"), back = C.latexToMd(edited); assert.strictEqual(C.mdToLatex(back), edited);
  }
  const raw = "We use \\SI{3}{\\micro\\gram} and \\cite{a} directly.";
  assert.strictEqual(C.mdToLatex(C.latexToMd(raw)), raw);
});
console.log(`${n - fail}/${n} tests passed`); process.exit(fail ? 1 : 0);
