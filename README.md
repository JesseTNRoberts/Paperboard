# Paperboard

A storyboard for academic papers and grant proposals. Sections run left to right, streams of work (argument, experiments, figures, literature, risks) run across them, and every paragraph, figure, experiment or reference set is a card.

The project itself lives in a folder of plain files on your computer. Claude (in the desktop app) reads and changes the same files; when it writes `claude-reload.txt`, the board refreshes in place, highlights what changed, and merges Claude's edits with whatever you were typing. There is no AI inside the app.

**Open it:** https://jessetnroberts.com/Paperboard/ in Chrome or Edge (it needs the File System Access API). Choose **New project**, or **Open a project folder**.

## The paper in LaTeX

Paperboard builds the paper's LaTeX from the beats in document order, and Overleaf compiles it (see the next section).

- **Sections and beats.** Sections become `\section`s, and a section named "Abstract" becomes the abstract. Paragraph beats are Markdown with LaTeX allowed (math, `\ref`, environments pass through). Figure and Table beats become floats labelled `fig:<title>` / `tab:<title>`.
- **Citations.** `[@key]` becomes `\citep`, `@key` becomes `\citet`, and `@fig:x` becomes `\ref{fig:x}`.
- **Symbols.** Characters pdfLaTeX can't take directly (µ, ≥, °, ², Greek letters…) are written as LaTeX commands.
- **Math.** Write math as LaTeX: `$…$` inline, `$$…$$` or `\[…\]` for display, or an `equation`/`align` environment. The beat editor's preview draws it with KaTeX, and it goes into the paper unchanged. `digest.md` lists beats that write math with Unicode characters (Greek letters, ², ₁, −, ≤…), so they can be converted.
- **Claude's text, until you approve it.** Prose Claude writes is wrapped in `{++ … ++}` in the beat. The editor's preview shows it in dark blue, the card says *To approve*, and in LaTeX it becomes `\claude{…}`, which `main.tex` defines as dark blue. Anything you type, in Paperboard or in Overleaf, is yours, even in the middle of Claude's text. To approve, press **Approve** in the beat editor (the selection, or the whole beat), or remove the `\claude{ }` wrapper in Overleaf. To print everything in black, put `\newcommand{\claude}[1]{#1}` in the template's preamble.
- **The template.** The conference template goes in `export/template/` (its `.cls`/`.sty`/`.bst`, and a `main.tex` with a `%% PAPERBOARD BODY` line where the paper goes). Without one, Paperboard writes the *ACL review template there and downloads `acl.sty` and `acl_natbib.bst` from the official [acl-org/acl-style-files](https://github.com/acl-org/acl-style-files) repository. Overleaf's default compiler is pdfLaTeX, so the `main.tex` it gets carries a short block of `\DeclareUnicodeCharacter` lines (skipped by XeLaTeX and LuaLaTeX) for symbols such as ≥, α, ×, ², ⁸ and ∼, inside math too; the Overleaf panel names any other character pdfLaTeX may reject, and the beat it's in.

## Syncing with Overleaf (premium, Git integration)

A folder inside the project (`export/overleaf` by default) holds the paper as LaTeX: `main.tex` with `% beat:` markers, the template's files, `references.bib` and the figures. Paperboard starts writing it when you press **Start** in the **Overleaf** panel. You push that folder to Overleaf with git; the panel gives you the commands, filled in. Once linked, the toolbar's **Git ▾** menu copies either command in one click: **Sync (merge)** sends Paperboard's version and brings Overleaf's edits into the beats; **Send mine** makes Overleaf match Paperboard and drops Overleaf's edits since the last sync (they stay in Overleaf's history; no force-push). Before Overleaf's edits go into the beats, Paperboard snapshots them to `Backups/<time> before Overleaf`, and **Undo Overleaf's last edits** in the Overleaf panel puts them back. Give the project's full path in the Overleaf panel (in Finder, ⌥⌘C) and the command works from any Terminal window.

- **Once.** Paste the Overleaf project's Git link into the panel and run the first-push command it shows, from the project folder. It makes the folder a git repository and pushes the paper; this works for an empty Overleaf project, and if Overleaf already made a starter `main.tex`, Paperboard's version replaces it. When git asks, the username is `git` and the password is an Overleaf Git token; macOS keeps it in the Keychain.
- **After a round of edits.** Run the sync command from the panel:
  `cd "export/overleaf" && git add -A && (git commit -qm "Paperboard" || true) && git -c merge.conflictStyle=diff3 pull --no-rebase --no-edit && git push; cd - >/dev/null`
  It sends Paperboard's version and brings in Overleaf's. Paperboard then merges Overleaf's edits back into the beats it can match by marker, preamble edits into `export/template/main.tex`, and new references into `References/references.bib`. Edits to figure or table floats are kept in that beat's Notes.
- **Conflicts.** If both sides changed the same lines, git stops with conflict markers. Paperboard reads the three versions from them, merges beat by beat, and shows "Needs your choice" where the same lines changed. Once you've chosen, it writes the resolved files; run the same command again to send them.

`test/overleaf_git_test.sh` runs these commands against a local stand-in for Overleaf.

## What's in a project folder

```
board.json              layout: sections, streams, tags, card positions, arrows, sticky notes
digest.md               generated: every beat in document order, with checks
Claude adjusts.md       generated: every open Claude adjust
claude-reload.txt       written by Claude after each round of edits
storyboard-open.json    written by the app: the beat you have open
Beats/                  one Markdown file per beat
Notes/  References/  Claude/  code/  data/  results/  figures/  export/  Backups/
```

A beat file:

```
ID: b-7f3k2a
Type: Figure
Status:
Script: code/figures/calibration_error.py
Output: figures/calibration_error.pdf, figures/calibration_error.png
Data: results/calibration/2026-10-12-a/metrics.csv
Caption: Calibration error by humidity band.
Synopsis: One or two sentences.

Claude adjust:

What you want Claude to do (usually empty)

---

The beat itself.

=== Notes ===

Notes, finished adjusts, earlier versions.
```

The app round-trips this byte for byte: editing one part changes nothing else. It never deletes a file ("delete" renames it `TO DELETE - …`), and it never runs code.

## This repository

- `index.html`: the app, one self-contained file. Built from `src/` by `build.sh` (just concatenation).
- `src/`: `head.html` (styles and markup), `core.js` (beat format, merging, cursor mapping, Markdown to LaTeX), `app.js` (board, editor, files, live refresh), `research.js` (beat types, figures, code, dependencies), `latex.js` (assembling the paper's LaTeX), `overleaf.js` (the Overleaf round trip).
- `sample/`: a small demo paper project. **Its numbers are synthetic demo data.**
- `test/`: `node test/core.test.js src/core.js sample/Beats` (format and merge tests); `test/browser_test.py <url> sample <outdir>` (headless Chromium with Playwright, using the browser's private file system as the project folder, playing Claude against the open app). Set `MARKED_JS` to a local `marked@12.0.2` if the CDN is out of reach.

## License

GNU AGPL-3.0 (see `LICENSE`).
