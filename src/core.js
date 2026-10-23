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

if (typeof module !== "undefined") module.exports = { NOTES_MARK, BEAT_TYPES, parseBeat, beatParts, setPart, setField, getField, newBeatText, newId, countWords, isBlankBeat,
  merge3, mapCaret, lcsPairs, mergeMeta, hasMarkers, cleanTitle, titleOfFile, normType, MARK_MINE, MARK_THEIRS };
