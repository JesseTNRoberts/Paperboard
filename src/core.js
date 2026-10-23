/* ================= core: beat files, merging, cursor mapping =================
   Pure functions with no DOM or file access, so they can be tested on their own.

   A beat file:
     ID: b-7f3k2a
     Type: Experiment
     Status: running
     Synopsis: one or two sentences

     Claude adjust:

     instructions to Claude (usually absent)

     ---

     the beat body

     === Notes ===

     notes

   Parsing records where each part sits in the file. Changing one part splices only that part's text,
   so an unedited file rebuilds byte for byte and editing one tab changes nothing else. */
const NOTES_MARK = "=== Notes ===";
const BEAT_TYPES = ["Paragraph", "Figure", "Table", "Experiment", "References", "Hypothesis", "Aim", "Note"];
const isDivider = l => /^---[ \t\r]*$/.test(l);
const isNotesMark = l => l.replace(/[ \t\r]+$/, "") === NOTES_MARK;

function scanLines(t) {   // [{s, e, nl}]: line start, end (before the newline), start of the next line
  const L = []; let s = 0;
  for (;;) { const e = t.indexOf("\n", s); if (e < 0) { L.push({ s, e: t.length, nl: t.length }); break; } L.push({ s, e, nl: e + 1 }); s = e + 1; }
  return L;
}
function section(t, a, b, inline) {   // a part of the file: [a,b) is its whole region, [cs,ce) the text itself without surrounding blank space
  const r = t.slice(a, b);
  const p = inline ? r.length - r.trimStart().length : r.match(/^(?:[ \t\r]*\n)*/)[0].length;
  const q = Math.max(p, r.trimEnd().length);
  return { a, b, cs: a + p, ce: a + q, value: t.slice(a + p, a + q) };
}
function parseBeat(t) {
  t = t ?? "";
  const L = scanLines(t), line = i => t.slice(L[i].s, L[i].e);
  const di = L.findIndex((_, i) => isDivider(line(i)));
  const P = { ok: di >= 0, fields: [], L };
  if (di < 0) { P.body = section(t, 0, t.length, false); P.syn = { missing: true, at: 0 }; P.adj = { missing: true, at: 0 }; P.notes = { missing: true }; return P; }
  let si = -1, ai = -1;
  for (let i = 0; i < di; i++) {
    const l = line(i);
    if (/^Claude adjust:/i.test(l)) { ai = i; break; }
    if (si < 0 && /^Synopsis:/i.test(l)) si = i;
  }
  const fieldEnd = si >= 0 ? si : ai >= 0 ? ai : di;
  for (let i = 0; i < fieldEnd; i++) {
    const m = line(i).match(/^([A-Za-z][A-Za-z0-9 _-]*?):([ \t]?)(.*?)(\r?)$/);
    if (m) P.fields.push({ key: m[1], line: i, colon: L[i].s + m[1].length + 1, vs: L[i].s + m[1].length + 1 + m[2].length, ve: L[i].e - m[4].length });
  }
  P.fieldInsert = L[fieldEnd].s;
  const synEnd = L[ai >= 0 ? ai : di].s;
  P.syn = si >= 0 ? section(t, L[si].s + 9, synEnd, true) : { missing: true, at: synEnd };
  P.adj = ai >= 0 ? section(t, L[ai].s + 14, L[di].s, true) : { missing: true, at: L[di].s };
  let ni = -1; for (let i = di + 1; i < L.length; i++) if (isNotesMark(line(i))) { ni = i; break; }
  P.body = section(t, L[di].nl, ni >= 0 ? L[ni].s : t.length, false);
  P.notes = ni >= 0 ? section(t, L[ni].nl, t.length, false) : { missing: true };
  return P;
}
/* everything the app needs from a beat, as plain values */
function beatParts(t) {
  const P = parseBeat(t), f = {};
  P.fields.forEach(x => { const k = x.key.toLowerCase(); if (!(k in f)) f[k] = t.slice(x.vs, x.ve).trim(); });
  const v = s => (s && !s.missing ? s.value : "");
  return { ok: P.ok, fields: f, id: f.id || "", type: normType(f.type), status: f.status || "",
    syn: v(P.syn), adj: v(P.adj), body: v(P.body), notes: v(P.notes) };
}
function normType(s) { const t = (s || "").trim().toLowerCase(); return BEAT_TYPES.find(x => x.toLowerCase() === t) || "Paragraph"; }
function cleanPart(part, v) {
  v = String(v ?? "").replace(/\r/g, "");
  if (part === "syn" || part === "adj") {
    v = v.replace(/^---[ \t]*$/gm, "– – –");   // a bare --- line would end the header early
    v = v.replace(/^(Claude adjust):/gim, "$1 –");
    v = v.replace(/^=== Notes ===[ \t]*$/gm, "\\=== Notes ===");
  }
  if (part === "body") v = v.replace(/^=== Notes ===[ \t]*$/gm, "\\=== Notes ===");   // would start the Notes early
  return v;
}
const spliceText = (t, a, b, s) => t.slice(0, a) + s + t.slice(b);
function ensureStructure(t) { return "Synopsis:\n\nClaude adjust:\n\n---\n\n" + t; }   // a free-form file keeps its text as the body
/* replace one part ("syn", "adj", "body" or "notes") and leave every other byte as it was */
function setPart(t, part, v) {
  t = t ?? ""; v = cleanPart(part, v);
  let P = parseBeat(t);
  if (!P.ok) {
    if (part === "body") { const s = P.body; return s.cs === s.ce || !v.trim() ? v : spliceText(t, s.cs, s.ce, v); }
    if (!v.trim()) return t;
    t = ensureStructure(t); P = parseBeat(t);
  }
  v = part === "syn" || part === "adj" ? v.trim() : v.replace(/^(?:[ \t]*\n)*/, "").trimEnd();   // surrounding blank space belongs to the layout, not the text
  const s = P[part], has = v !== "";
  if (part === "notes" && s.missing) {
    if (!has) return t;
    const sep = t.endsWith("\n\n") || t === "" ? "" : t.endsWith("\n") ? "\n" : "\n\n";
    return t + sep + NOTES_MARK + "\n\n" + v + "\n";
  }
  if (s.missing) {   // a Synopsis or Claude adjust line that isn't there yet
    if (!has) return t;
    return spliceText(t, s.at, s.at, part === "syn" ? `Synopsis: ${v}\n\n` : `Claude adjust:\n\n${v}\n\n`);
  }
  if (s.value === v) return t;
  if (has && s.cs !== s.ce) return spliceText(t, s.cs, s.ce + t.slice(s.ce).match(/^[ \t]*/)[0].length, v);   // the usual case: only the text itself changes
  const canon = {   // an empty part filled in, or a part emptied: use the standard spacing
    syn: has ? " " + v + "\n\n" : "\n\n",
    adj: has ? "\n\n" + v + "\n\n" : "\n\n",
    body: has ? "\n" + v + (P.notes.missing ? "\n" : "\n\n") : "\n",
    notes: has ? "\n" + v + "\n" : "\n"
  }[part];
  return spliceText(t, s.a, s.b, canon);
}
function getField(t, key) { return beatParts(t).fields[key.toLowerCase()] ?? ""; }
/* set one "Key: value" header line; a new key goes after the existing ones */
function setField(t, key, v) {
  t = t ?? ""; v = String(v ?? "").replace(/[\r\n]+/g, " ").trim();
  let P = parseBeat(t);
  if (!P.ok) { if (!v) return t; t = ensureStructure(t); P = parseBeat(t); }
  const f = P.fields.find(x => x.key.toLowerCase() === key.toLowerCase());
  if (f) {
    if (t.slice(f.vs, f.ve).trim() === v) return t;
    return t.slice(f.vs, f.ve).trim() && v ? spliceText(t, f.vs, f.ve, v) : spliceText(t, f.colon, f.ve, v ? " " + v : "");
  }
  if (!v) return t;
  return spliceText(t, P.fieldInsert, P.fieldInsert, `${key}: ${v}\n`);
}
const NEW_FIELDS = { Figure: ["Script", "Output", "Data", "Caption"], Table: ["Script", "Output", "Data", "Caption"], Experiment: ["Hypothesis", "Code", "Run", "Last run", "Outcome: not run"], References: ["Question", "Keys"] };
function newBeatText(id, type = "Paragraph") {   // the empty template, with the type's own fields
  const extra = (NEW_FIELDS[type] || []).map(f => f.includes(":") ? f + "\n" : f + ":\n").join("");
  return `ID: ${id}\nType: ${type}\nStatus:\n${extra}Synopsis:\n\nClaude adjust:\n\n---\n\n`;
}
const newId = () => "b-" + Math.random().toString(36).slice(2, 8).padEnd(6, "0");
const countWords = s => ((s || "").match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) || []).length;
const isBlankBeat = p => !p.syn.trim() && !p.adj.trim() && !p.body.trim() && !p.notes.trim();

/* ---------- three-way merge of text, line by line ---------- */
function lcsPairs(a, b) {   // map from index in a to index in b for the longest common subsequence of lines
  const out = new Map();
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) { out.set(p, p); p++; }
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s), n = A.length, m = B.length;
  if (n && m) {
    const w = m + 1, dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = A[i] === B[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (A[i] === B[j]) { out.set(p + i, p + j); i++; j++; } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++; else j++; }
  }
  for (let k = 0; k < s; k++) out.set(a.length - s + k, b.length - s + k);
  return out;
}
const sameLines = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
function addsAround(orig, changed) {   // `changed` is `orig` with lines added only before and/or after it: return a function that wraps another version the same way
  if (!orig.length || changed.length <= orig.length) return null;
  for (let s = 0; s + orig.length <= changed.length; s++)
    if (sameLines(changed.slice(s, s + orig.length), orig)) { const pre = changed.slice(0, s), post = changed.slice(s + orig.length); return other => [...pre, ...other, ...post]; }
  return null;
}
function addsAroundTrimmed(orig, changed) {   // the same, ignoring blank lines at the edges of the original block
  let a = 0, b = orig.length; while (a < b && !orig[a].trim()) a++; while (b > a && !orig[b - 1].trim()) b--;
  if (a === 0 && b === orig.length) return null;
  const core = orig.slice(a, b), w = addsAround(core, changed); if (!w) return null;
  return other => { let x = 0, y = other.length; while (x < y && !other[x].trim()) x++; while (y > x && !other[y - 1].trim()) y--; return w(other.slice(x, y)); };
}
const MARK_MINE = "<<<<<<< Your version", MARK_SEP = "=======", MARK_THEIRS = ">>>>>>> Claude's version";
function merge3(base, mine, theirs) {
  if (mine === theirs) return { text: mine, conflict: false };
  if (mine === base) return { text: theirs, conflict: false };
  if (theirs === base) return { text: mine, conflict: false };
  const O = base.split("\n"), A = mine.split("\n"), B = theirs.split("\n");
  const ma = lcsPairs(O, A), mb = lcsPairs(O, B);
  const out = []; let conflict = false, io = 0, ia = 0, ib = 0;
  for (;;) {
    let o = io; while (o < O.length && !(ma.has(o) && mb.has(o) && ma.get(o) >= ia && mb.get(o) >= ib)) o++;   // next line unchanged on both sides
    const ea = o < O.length ? ma.get(o) : A.length, eb = o < O.length ? mb.get(o) : B.length;
    const cO = O.slice(io, o), cA = A.slice(ia, ea), cB = B.slice(ib, eb);
    if (cO.length || cA.length || cB.length) {
      let w;
      if (sameLines(cA, cO)) out.push(...cB);
      else if (sameLines(cB, cO)) out.push(...cA);
      else if (sameLines(cA, cB)) out.push(...cA);
      else if ((w = addsAround(cO, cB) || addsAroundTrimmed(cO, cB))) out.push(...w(cA));   // Claude only added lines before/after (e.g. notes appended): keep your edit too
      else if ((w = addsAround(cO, cA) || addsAroundTrimmed(cO, cA))) out.push(...w(cB));   // you only added lines before/after
      else { conflict = true; out.push(MARK_MINE, ...cA, MARK_SEP, ...cB, MARK_THEIRS); }
    }
    if (o >= O.length) break;
    out.push(O[o]); io = o + 1; ia = ea + 1; ib = eb + 1;
  }
  return { text: out.join("\n"), conflict };
}
const hasMarkers = t => /^(<{7}|={7}|>{7})( |$)/m.test(t);

/* keep the cursor on the same words when text changes elsewhere: match lines, not characters */
function mapCaret(oldT, newT, pos) {
  if (oldT === newT) return pos;
  const O = oldT.split("\n"), N = newT.split("\n");
  let li = 0, acc = 0; while (li < O.length - 1 && acc + O[li].length + 1 <= pos) { acc += O[li].length + 1; li++; }
  const col = pos - acc, m = lcsPairs(O, N);
  const startOf = k => { let off = 0; for (let i = 0; i < k; i++) off += N[i].length + 1; return off; };
  if (m.has(li)) return startOf(m.get(li)) + col;
  // the cursor's own line changed: stay the same number of lines below the nearest unchanged line above it
  let p = li - 1; while (p >= 0 && !m.has(p)) p--;
  let q = li + 1; while (q < O.length && !m.has(q)) q++;
  const lo = p >= 0 ? m.get(p) + 1 : 0, hi = q < O.length ? m.get(q) - 1 : N.length - 1;
  let nl = lo + (li - (p + 1));
  if (nl > hi) nl = hi; if (nl < lo) nl = lo; if (nl > N.length - 1) nl = N.length - 1; if (nl < 0) nl = 0;
  if (hi < lo) return startOf(Math.min(lo, N.length - 1));   // the line was removed: go to the start of what follows
  const ol = O[li], nlS = N[nl]; let c = 0; while (c < col && c < nlS.length && ol[c] === nlS[c]) c++;   // same column if the start of the line is unchanged
  return startOf(nl) + (c === col ? col : Math.min(col, nlS.length));
}

/* ---------- three-way merge of board.json: per card, per act/stream/tag/note/arrow ---------- */
const J = v => JSON.stringify(v);
function pick3(b, l, d) { if (J(l) === J(b)) return d; return l; }
function mergeKeyed(b = {}, l = {}, d = {}, changed, clashes) {
  const res = {};
  new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(d)]).forEach(k => {
    const bv = b[k], lv = l[k], dv = d[k];
    if (J(lv) === J(bv)) { if (dv !== undefined) res[k] = dv; if (changed && J(dv) !== J(bv)) changed.add(k); }
    else if (J(dv) === J(bv) || J(dv) === J(lv)) { if (lv !== undefined) res[k] = lv; }
    else {   // both changed this card: yours wins
      if (lv !== undefined) res[k] = lv; else if (dv !== undefined) res[k] = dv;
      if (changed) changed.add(k); if (clashes) clashes.add(k);
    }
  });
  return res;
}
function mergeIdList(b = [], l = [], d = []) {
  if (J(l) === J(b)) return d; if (J(d) === J(b)) return l;
  const by = arr => new Map(arr.map(x => [x.id, x]));
  const B = by(b), L = by(l), D = by(d), out = [];
  d.forEach(x => { if (!L.has(x.id) && B.has(x.id) && J(B.get(x.id)) === J(x)) return; const r = L.has(x.id) ? pick3(B.get(x.id), L.get(x.id), x) : (B.has(x.id) ? undefined : x); if (r !== undefined) out.push(r); });
  l.forEach(x => { if (!D.has(x.id) && !B.has(x.id)) out.push(x); });   // added here
  return out;
}
function mergeMeta(base, local, disk, changed, clashes) {
  const out = {};
  new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(disk)]).forEach(k => {
    const b = base ? base[k] : undefined, l = local[k], d = disk[k];
    if (k === "beats") out[k] = mergeKeyed(b, l, d, changed, clashes);
    else if (k === "trash" || k === "sectionNotes") out[k] = mergeKeyed(b, l, d);
    else if (Array.isArray(l) || Array.isArray(d)) out[k] = mergeIdList(b, l, d);
    else { const v = pick3(b, l, d); if (v !== undefined) out[k] = v; }
  });
  return out;
}

/* ---------- file names ---------- */
const DEL_PREFIX = "TO DELETE - ";
const cleanTitle = t => String(t || "").replace(/[\/\\:*?"<>|\n\r\t]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").replace(/\.md$/i, "").trim();
const beatFile = title => title + ".md";
function titleOfFile(name) {
  if (!/\.md$/i.test(name) || name.startsWith(".")) return null;
  const t = name.replace(/\.md$/i, "");
  const del = t.startsWith(DEL_PREFIX) || /^TO DELETE\b/i.test(t);
  return { title: del ? t.replace(/^TO DELETE\s*-?\s*/i, "") : t, deleted: del };
}

/* ---------- Markdown + LaTeX → LaTeX ----------
   Beats are Markdown for prose (bold, italics, lists, quotes, links, images, [@key] citations), and anything that is
   already LaTeX passes through untouched: math ($…$, $$…$$, \[…\], \(…\)), commands with their arguments (\ref{…},
   \cite{…}, \SI{…}{…}), and whole environments (\begin{equation}…\end{equation}). */
const slugify = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
const TEX_SPECIAL = { "&": "\\&", "%": "\\%", "#": "\\#", "_": "\\_", "{": "\\{", "}": "\\}", "^": "\\^{}", "$": "\\$", "\\": "\\textbackslash{}" };
const texEscape = s => String(s ?? "").replace(/[&%#_{}^$\\]/g, c => TEX_SPECIAL[c]);
/* characters pdfLaTeX (Overleaf's default compiler) can't take straight from the text */
const UNI_TEX = { "µ": "\\textmu{}", "μ": "\\ensuremath{\\mu}", "°": "\\textdegree{}", "±": "\\ensuremath{\\pm}", "×": "\\ensuremath{\\times}", "÷": "\\ensuremath{\\div}",
  "≤": "\\ensuremath{\\leq}", "≥": "\\ensuremath{\\geq}", "≠": "\\ensuremath{\\neq}", "≈": "\\ensuremath{\\approx}", "∼": "\\ensuremath{\\sim}", "∝": "\\ensuremath{\\propto}",
  "→": "\\ensuremath{\\rightarrow}", "←": "\\ensuremath{\\leftarrow}", "↔": "\\ensuremath{\\leftrightarrow}", "⇒": "\\ensuremath{\\Rightarrow}", "∞": "\\ensuremath{\\infty}",
  "−": "\\ensuremath{-}", "·": "\\ensuremath{\\cdot}", "∑": "\\ensuremath{\\sum}", "√": "\\ensuremath{\\surd}", "∈": "\\ensuremath{\\in}", "∀": "\\ensuremath{\\forall}", "∃": "\\ensuremath{\\exists}",
  "²": "\\textsuperscript{2}", "³": "\\textsuperscript{3}", "¹": "\\textsuperscript{1}", "₂": "\\textsubscript{2}", "₃": "\\textsubscript{3}", "‰": "\\textperthousand{}", "™": "\\texttrademark{}",
  "α": "\\ensuremath{\\alpha}", "β": "\\ensuremath{\\beta}", "γ": "\\ensuremath{\\gamma}", "δ": "\\ensuremath{\\delta}", "ε": "\\ensuremath{\\epsilon}", "ζ": "\\ensuremath{\\zeta}", "η": "\\ensuremath{\\eta}",
  "θ": "\\ensuremath{\\theta}", "κ": "\\ensuremath{\\kappa}", "λ": "\\ensuremath{\\lambda}", "ν": "\\ensuremath{\\nu}", "ξ": "\\ensuremath{\\xi}", "π": "\\ensuremath{\\pi}", "ρ": "\\ensuremath{\\rho}",
  "σ": "\\ensuremath{\\sigma}", "τ": "\\ensuremath{\\tau}", "φ": "\\ensuremath{\\phi}", "χ": "\\ensuremath{\\chi}", "ψ": "\\ensuremath{\\psi}", "ω": "\\ensuremath{\\omega}",
  "Γ": "\\ensuremath{\\Gamma}", "Δ": "\\ensuremath{\\Delta}", "Θ": "\\ensuremath{\\Theta}", "Λ": "\\ensuremath{\\Lambda}", "Π": "\\ensuremath{\\Pi}", "Σ": "\\ensuremath{\\Sigma}", "Φ": "\\ensuremath{\\Phi}", "Ψ": "\\ensuremath{\\Psi}", "Ω": "\\ensuremath{\\Omega}" };
Object.assign(UNI_TEX, { "′": "\\ensuremath{'}", "″": "\\ensuremath{''}", "≡": "\\ensuremath{\\equiv}", "∗": "\\ensuremath{\\ast}", "∂": "\\ensuremath{\\partial}", "∇": "\\ensuremath{\\nabla}", "∫": "\\ensuremath{\\int}", "∏": "\\ensuremath{\\prod}",
  "≪": "\\ensuremath{\\ll}", "≫": "\\ensuremath{\\gg}", "⊂": "\\ensuremath{\\subset}", "⊆": "\\ensuremath{\\subseteq}", "∪": "\\ensuremath{\\cup}", "∩": "\\ensuremath{\\cap}", "∅": "\\ensuremath{\\emptyset}",
  "∉": "\\ensuremath{\\notin}", "¬": "\\ensuremath{\\neg}", "∧": "\\ensuremath{\\wedge}", "∨": "\\ensuremath{\\vee}", "⊕": "\\ensuremath{\\oplus}", "⊗": "\\ensuremath{\\otimes}", "↑": "\\ensuremath{\\uparrow}", "↓": "\\ensuremath{\\downarrow}",
  "⇔": "\\ensuremath{\\Leftrightarrow}", "⇐": "\\ensuremath{\\Leftarrow}", "∓": "\\ensuremath{\\mp}", "⋯": "\\ensuremath{\\cdots}", "ℓ": "\\ensuremath{\\ell}", "ℝ": "\\ensuremath{\\mathbb{R}}",
  "ϵ": "\\ensuremath{\\epsilon}", "ϑ": "\\ensuremath{\\vartheta}", "ϕ": "\\ensuremath{\\phi}", "ς": "\\ensuremath{\\varsigma}", "ι": "\\ensuremath{\\iota}", "υ": "\\ensuremath{\\upsilon}", "Ξ": "\\ensuremath{\\Xi}", "Υ": "\\ensuremath{\\Upsilon}",
  "⁻": "\\textsuperscript{-}", "⁰": "\\textsuperscript{0}", "⁴": "\\textsuperscript{4}", "⁵": "\\textsuperscript{5}", "⁶": "\\textsuperscript{6}", "⁷": "\\textsuperscript{7}", "⁸": "\\textsuperscript{8}", "⁹": "\\textsuperscript{9}",
  "₀": "\\textsubscript{0}", "₁": "\\textsubscript{1}", "₄": "\\textsubscript{4}", "₅": "\\textsubscript{5}", "₆": "\\textsubscript{6}", "₇": "\\textsubscript{7}", "₈": "\\textsubscript{8}", "₉": "\\textsubscript{9}", "ₓ": "\\textsubscript{x}" });
delete UNI_TEX["ℝ"];   // needs amssymb, which not every template loads
const UNI_RE = new RegExp("[" + Object.keys(UNI_TEX).join("") + "]", "g");
/* one-way: these have no single way back, so Overleaf edits don't turn every hyphen into a non-breaking one */
const UNI_ONEWAY = { "\u2011": "-", "\u2009": "\\,", "\u202F": "\\,", "\u200B": "{}", "\uFEFF": "{}", "\u2060": "{}" };
const UNI_ONEWAY_RE = new RegExp("[" + Object.keys(UNI_ONEWAY).join("") + "]", "g");
/* the same table as a preamble block, so pdfLaTeX also knows these characters inside math, in references.bib and in
   the template's own text. It only acts under pdfLaTeX (XeLaTeX and LuaLaTeX handle Unicode themselves). */
const UNI_BLOCK_START = "% ---- PAPERBOARD UNICODE START (written by Paperboard) ----", UNI_BLOCK_END = "% ---- PAPERBOARD UNICODE END ----";
function unicodePreamble() {
  const decl = Object.entries({ ...UNI_TEX, ...UNI_ONEWAY }).map(([c, tex]) => `\\DeclareUnicodeCharacter{${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}}{${tex}}`);
  return [UNI_BLOCK_START, "\\ifdefined\\Umathchar\\else\\ifdefined\\DeclareUnicodeCharacter", ...decl, "\\fi\\fi", UNI_BLOCK_END].join("\n");
}
const stripUnicodePreamble = t => String(t).replace(new RegExp("\\n?" + UNI_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?" + UNI_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n?"), "\n");
/* characters pdfLaTeX may still not know: beyond Latin, not in the table, not the usual typographic ones */
const PDFTEX_SAFE = /[\u0000-ɏ–—‘’‚“”„†‡•…‰‹›€™ -ÿ]/;
function unknownChars(t) { const out = new Map(); for (const c of String(t)) if (!PDFTEX_SAFE.test(c) && !(c in UNI_TEX) && !(c in UNI_ONEWAY)) out.set(c, (out.get(c) || 0) + 1); return out; }
const uniToTex = s => s.replace(UNI_ONEWAY_RE, c => UNI_ONEWAY[c]).replace(UNI_RE, c => UNI_TEX[c]);
const REF_PREFIX = /^(fig|tab|sec|eq|lst|app|alg):/;
function citeCmd(inner) {   // the inside of [ … ], Pandoc style: "see @a, p. 3; @b"
  const items = inner.split(";").map(x => x.trim()).filter(Boolean).map(x => { const m = x.match(/^(.*?)-?@([\w:.\-\/+]+)(.*)$/); return m ? { pre: m[1].trim(), key: m[2], post: m[3].replace(/^\s*,\s*/, "").trim() } : null; });
  if (!items.length || items.some(i => !i)) return null;
  if (items.every(i => REF_PREFIX.test(i.key))) return items.map(i => `\\ref{${i.key}}`).join(", ");
  const keys = items.map(i => i.key).join(","), pre = items[0].pre, post = items[items.length - 1].post;
  return pre ? `\\citep[${pre}][${post}]{${keys}}` : post ? `\\citep[${post}]{${keys}}` : `\\citep{${keys}}`;
}
function mdInline(src) {
  const keep = [], hold = t => "\u0000" + (keep.push(t) - 1) + "\u0000";
  let s = String(src ?? "");
  // 1. code, math and LaTeX commands are kept as they are
  s = s.replace(/`([^`]+)`/g, (m, c) => hold(`\\texttt{${texEscape(c)}}`));
  s = s.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?=\S)(?:[^$\\\n]|\\.)+?(?<=\S)\$/g, m => hold(m));
  let out = "", i = 0;
  while (i < s.length) {
    if (s[i] !== "\\") { out += s[i++]; continue; }
    let j = i + 1;
    if (/[A-Za-z@]/.test(s[j] || "")) {
      while (j < s.length && /[A-Za-z@]/.test(s[j])) j++;
      if (s[j] === "*") j++;
      for (;;) {   // its [optional] and {required} arguments, braces balanced
        if (s[j] === "[") { const k = s.indexOf("]", j); if (k < 0) break; j = k + 1; continue; }
        if (s[j] === "{") { let d = 0, k = j; for (; k < s.length; k++) { if (s[k] === "\\") { k++; continue; } if (s[k] === "{") d++; else if (s[k] === "}" && --d === 0) break; } if (k >= s.length) break; j = k + 1; continue; }
        break;
      }
      out += hold(s.slice(i, j)); i = j;
    } else if (j < s.length && !/\s/.test(s[j])) { out += hold(s.slice(i, j + 1)); i = j + 1; }   // \% \& \\ \, …
    else { out += s[i++]; }
  }
  s = out;
  // 2. citations and cross-references: [@a; @b], [see @a, p. 3], @a in running text, @fig:label
  s = s.replace(/\[([^\[\]]*@[\w:.\-\/+][^\[\]]*)\]/g, (m, inner) => { const c = citeCmd(inner); return c ? hold(c) : m; });
  s = s.replace(/(^|[\s(])@([A-Za-z][\w:.\-\/+]*[\w])/g, (m, pre, key) => pre + hold(REF_PREFIX.test(key) ? `\\ref{${key}}` : `\\citet{${key}}`));
  // 3. links, emphasis, quotes
  s = s.replace(/!?\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, text, url) => m.startsWith("!") ? "" : hold(`\\href{${url.replace(/[%#]/g, c => "\\" + c)}}{`) + text + hold("}"));
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "\uE000$1\uE001").replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1\uE000$2\uE001");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, "$1\uE002$2\uE003").replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1\uE002$2\uE003");
  s = s.replace(/(^|[\s(\[\u2014-])"(?=\S)([^"]*?\S)"/g, "$1\uE004$2\uE005");
  s = s.replace(/(^|[\s(\[])~(?=[\d.+\-])/g, (m, pre) => pre + hold("\\ensuremath{\\sim}"));   // "~1e-6" means approximately
  // 4. escape what's left, then put the kept pieces back
  s = uniToTex(texEscape(s)).replace(/\uE000/g, "\\textbf{").replace(/\uE001/g, "}").replace(/\uE002/g, "\\emph{").replace(/\uE003/g, "}").replace(/\uE004/g, "``").replace(/\uE005/g, "''");
  return s.replace(/\u0000(\d+)\u0000/g, (m, n) => keep[+n]).replace(/\u0000(\d+)\u0000/g, (m, n) => keep[+n]);
}
function mdTableToLatex(lines) {
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  const head = cells(lines[0]), align = cells(lines[1]).map(a => /^:-+:$/.test(a) ? "c" : /-+:$/.test(a) ? "r" : "l");
  const rows = lines.slice(2).map(cells);
  return `\\begin{tabular}{${align.join("")}}\n\\toprule\n${head.map(mdInline).join(" & ")} \\\\\n\\midrule\n${rows.map(r => r.map(mdInline).join(" & ") + " \\\\").join("\n")}\n\\bottomrule\n\\end{tabular}`;
}
function imagePath(p) { return String(p || "").trim().replace(/^<|>$/g, "").replace(/^\.\//, "").replace(/^(\.\.\/)+/, ""); }
function mdToLatex(md, opts = {}) {
  const lines = String(md ?? "").replace(/\r/g, "").split("\n"), out = [];
  let i = 0, para = [];
  const flush = () => { if (para.length) { out.push(mdInline(para.join("\n"))); para = []; } };
  const figure = (alt, path) => `\\begin{figure}[${opts.placement || "t"}]\n  \\centering\n  \\includegraphics[width=\\linewidth]{${imagePath(path)}}\n${alt ? `  \\caption{${mdInline(alt)}}\n` : ""}\\end{figure}`;
  while (i < lines.length) {
    const l = lines[i], t = l.trim();
    if (!t) { flush(); i++; continue; }
    let m;
    if ((m = t.match(/^\\begin\{([^}]+)\}/))) {   // a LaTeX environment: as is, up to its matching \end
      flush(); const env = m[1]; let depth = 0, j = i; const buf = [];
      for (; j < lines.length; j++) { buf.push(lines[j]); depth += (lines[j].split(`\\begin{${env}}`).length - 1) - (lines[j].split(`\\end{${env}}`).length - 1); if (depth <= 0) break; }
      out.push(buf.join("\n")); i = j + 1; continue;
    }
    if (/^(\$\$|\\\[)/.test(t)) {   // display math
      flush(); const close = t.startsWith("$$") ? "$$" : "\\]"; const buf = [l]; let j = i;
      if (!(t.length > 2 && t.endsWith(close))) { for (j = i + 1; j < lines.length; j++) { buf.push(lines[j]); if (lines[j].trim().endsWith(close)) break; } }
      out.push(buf.join("\n").replace(/^\s*\$\$/, "\\[").replace(/\$\$\s*$/, "\\]")); i = j + 1; continue;
    }
    if (/^```/.test(t)) { flush(); const buf = []; let j = i + 1; for (; j < lines.length && !/^```/.test(lines[j].trim()); j++) buf.push(lines[j]); out.push(`\\begin{verbatim}\n${buf.join("\n")}\n\\end{verbatim}`); i = j + 1; continue; }
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) { flush(); const cmd = ["subsection", "subsection", "subsubsection", "paragraph", "paragraph", "paragraph"][m[1].length - 1]; out.push(`\\${cmd}{${mdInline(m[2].replace(/\s+#+$/, ""))}}`); i++; continue; }
    if ((m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/))) { flush(); out.push(figure(m[1], m[2])); i++; continue; }
    if (/^\|.*\|$/.test(t) && /^\|?\s*:?-{2,}/.test((lines[i + 1] || "").trim())) {
      flush(); const buf = []; let j = i; for (; j < lines.length && /^\|.*\|$/.test(lines[j].trim()); j++) buf.push(lines[j]);
      out.push(`\\begin{center}\n${mdTableToLatex(buf)}\n\\end{center}`); i = j; continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push("\\par\\noindent\\rule{\\linewidth}{0.4pt}\\par"); i++; continue; }
    if (/^>\s?/.test(t)) { flush(); const buf = []; let j = i; for (; j < lines.length && /^\s*>/.test(lines[j]); j++) buf.push(lines[j].replace(/^\s*>\s?/, "")); out.push(`\\begin{quote}\n${mdToLatex(buf.join("\n"), opts)}\n\\end{quote}`); i = j; continue; }
    if (/^([-*+]|\d+[.)])\s+/.test(t)) {   // lists, with one level of nesting by indentation
      flush();
      const list = (start, indent) => {
        const ordered = /^\d/.test(lines[start].trim()), env = ordered ? "enumerate" : "itemize", items = []; let j = start;
        while (j < lines.length) {
          const ln = lines[j], ind = ln.match(/^\s*/)[0].length, tt = ln.trim();
          if (!tt) { const nx = lines[j + 1] || ""; if (/^\s*([-*+]|\d+[.)])\s+/.test(nx) && nx.match(/^\s*/)[0].length >= indent && /^\d/.test(nx.trim()) === ordered) { j++; continue; } break; }
          if (ind > indent && /^([-*+]|\d+[.)])\s+/.test(tt)) { const r = list(j, ind); items[items.length - 1] += "\n" + r.tex; j = r.end; continue; }
          if (ind < indent) break;
          if (ind === indent && /^([-*+]|\d+[.)])\s+/.test(tt) && /^\d/.test(tt) !== ordered) break;   // a different kind of list starts
          const mm = tt.match(/^([-*+]|\d+[.)])\s+(.*)$/);
          if (mm) items.push(mdInline(mm[2])); else if (items.length) items[items.length - 1] += " " + mdInline(tt); else break;
          j++;
        }
        return { tex: `\\begin{${env}}\n${items.map(x => "  \\item " + x).join("\n")}\n\\end{${env}}`, end: j };
      };
      const r = list(i, lines[i].match(/^\s*/)[0].length); out.push(r.tex); i = r.end; continue;
    }
    para.push(l); i++;
  }
  flush();
  return out.join("\n\n");
}
/* the files the paper uses (figures, \input files), to copy them for Overleaf */
function latexAssets(tex) {
  const out = new Set();
  for (const m of tex.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) out.add(m[1].trim());
  for (const m of tex.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) out.add(m[1].trim());
  return [...out];
}

/* ---------- the generated paper, split back into its beats (for edits made in Overleaf) ---------- */
const beatTagId = line => { const m = line.match(/^% beat: .* \(([^()]+)\) \(empty\)\s*$/) || line.match(/^% beat: .* \(([^()]+)\)\s*$/); return m ? m[1] : null; };
const BODY_START = "% ---- PAPERBOARD BODY START ----", BODY_END = "% ---- PAPERBOARD BODY END ----";
function splitPaperTex(tex) {   // {pre, post, blocks: Map(key -> latex), sections: Map(name -> latex), order}, or null without markers
  tex = String(tex ?? "").replace(/\r/g, "");
  const a = tex.indexOf(BODY_START), b = tex.indexOf(BODY_END);
  if (a < 0 || b < a) return null;
  const pre = tex.slice(0, a), post = tex.slice(b + BODY_END.length), body = tex.slice(a + BODY_START.length, b);
  const blocks = new Map(), sections = new Map(), order = []; let cur = null, buf = [];
  const close = () => { if (!cur) return; const t = buf.join("\n").replace(/^\n+|\s+$/g, ""); (cur.kind === "beat" ? blocks : sections).set(cur.id, t); order.push(cur); buf = []; };
  for (const line of body.split("\n")) {
    let m;
    if ((m = line.match(/^% beat: .* \(([^()]+)\) \(empty\)\s*$/) || line.match(/^% beat: .* \(([^()]+)\)\s*$/))) { close(); cur = { kind: "beat", id: m[1] }; continue; }
    if ((m = line.match(/^% section: (.*)$/))) { close(); cur = { kind: "section", id: m[1].trim() }; continue; }
    if ((m = line.match(/^% end: (.*)$/))) { close(); cur = { kind: "section", id: "end: " + m[1].trim() }; continue; }
    if (cur) buf.push(line);
  }
  close();
  return { pre, post, blocks, sections, order };
}
/* a file git left with conflict markers (merge.conflictStyle=diff3): the three versions it came from */
const hasGitConflict = t => /^<{7}( |$)/m.test(t || "") && /^>{7}( |$)/m.test(t || "");
function gitConflictSides(text) {
  const ours = [], base = [], theirs = []; let state = 0, sawBase = false, sawAny = false;   // 0 outside, 1 ours, 2 base, 3 theirs
  for (const line of String(text).split("\n")) {
    if (state === 0 && /^<{7}( |$)/.test(line)) { state = 1; sawAny = true; continue; }
    if (state === 1 && /^\|{7}( |$)/.test(line)) { state = 2; sawBase = true; continue; }
    if ((state === 1 || state === 2) && /^={7}$/.test(line)) { state = 3; continue; }
    if (state === 3 && /^>{7}( |$)/.test(line)) { state = 0; continue; }
    if (state === 0) { ours.push(line); base.push(line); theirs.push(line); }
    else if (state === 1) ours.push(line); else if (state === 2) base.push(line); else theirs.push(line);
  }
  return { conflict: sawAny, hasBase: sawBase, ours: ours.join("\n"), base: base.join("\n"), theirs: theirs.join("\n") };
}
/* LaTeX back to Markdown, only where it converts forward again to exactly the same LaTeX; otherwise the LaTeX itself (beats accept it) */
function latexToMd(tex) {
  const t = String(tex ?? "");
  let md = t
    .replace(/\\textbf\{([^{}]*)\}/g, "**$1**").replace(/\\(?:emph|textit)\{([^{}]*)\}/g, "*$1*")
    .replace(/\\texttt\{([^{}]*)\}/g, (m, c) => "`" + c.replace(/\\([&%#_{}$])/g, "$1").replace(/\\textbackslash\{\}/g, "\\") + "`")
    .replace(/\\citep\[([^\]]*)\]\[([^\]]*)\]\{([^}]+)\}/g, (m, pre, post, keys) => "[" + keys.split(",").map((k, i, a) => (i === 0 && pre ? pre + " " : "") + "@" + k.trim() + (i === a.length - 1 && post ? ", " + post : "")).join("; ") + "]")
    .replace(/\\citep\[([^\]]*)\]\{([^}]+)\}/g, (m, post, keys) => "[" + keys.split(",").map((k, i, a) => "@" + k.trim() + (i === a.length - 1 && post ? ", " + post : "")).join("; ") + "]")
    .replace(/\\citep\{([^}]+)\}/g, (m, keys) => "[" + keys.split(",").map(k => "@" + k.trim()).join("; ") + "]")
    .replace(/\\citet\{([^},]+)\}/g, "@$1")
    .replace(/(^|[\s(])\\ref\{((?:fig|tab|sec|eq|lst|app|alg):[^}]+)\}/g, "$1@$2")
    .replace(/``([^`']*)''/g, '"$1"')
    .replace(/\\([&%#_])/g, "$1");
  for (const [c, tex] of Object.entries(UNI_TEX)) md = md.split(tex).join(c);
  return mdToLatex(md) === t ? md : t;
}

if (typeof module !== "undefined") module.exports = { NOTES_MARK, BEAT_TYPES, parseBeat, beatParts, setPart, setField, getField, newBeatText, newId, countWords, isBlankBeat,
  merge3, mapCaret, lcsPairs, mergeMeta, hasMarkers, cleanTitle, titleOfFile, normType, MARK_MINE, MARK_THEIRS,
  mdToLatex, mdInline, texEscape, uniToTex, unicodePreamble, stripUnicodePreamble, unknownChars, slugify, latexAssets, splitPaperTex, latexToMd, BODY_START, BODY_END, hasGitConflict, gitConflictSides };
