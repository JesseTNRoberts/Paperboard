# Paperboard

A storyboard for academic papers and grant proposals. Sections run left to right, streams of work (argument, experiments, figures, literature, risks) run across them, and every paragraph, figure, experiment or reference set is a card.

The project itself lives in a folder of plain files on your computer. Claude (in the desktop app) reads and changes the same files; when it writes `claude-reload.txt`, the board refreshes in place, highlights what changed, and merges Claude's edits with whatever you were typing. There is no AI inside the app.

**Open it:** https://jessetnroberts.com/Paperboard/ in Chrome or Edge (it needs the File System Access API). Choose **New project**, or **Open a project folder**.

## Compiling to PDF

**PDF** in the toolbar builds the paper from the beats in document order and compiles it in the browser with TeX Live 2026 compiled to WebAssembly ([texlyre-busytex](https://github.com/TeXlyre/texlyre-busytex)). The first compile downloads about 225 MB, which the browser then caches.

- **Sections and beats.** Sections become `\section`s, and a section named "Abstract" becomes the abstract. Paragraph beats are Markdown with LaTeX allowed (math, `\ref`, environments pass through). Figure and Table beats become floats labelled `fig:<title>` / `tab:<title>`.
- **Citations.** `[@key]` becomes `\citep`, `@key` becomes `\citet`, and `@fig:x` becomes `\ref{fig:x}`.
- **The template.** The conference template goes in `export/template/` (its `.cls`/`.sty`/`.bst`, and a `main.tex` with a `%% PAPERBOARD BODY` line where the paper goes). Without one, a plain article is used.
- **Output.** `export/paper.pdf`, `export/paper.tex`, `export/paper.log`.
- **Missing packages.** A few less common packages aren't in the in-browser TeX. The app names any it can't find; compile `export/paper.tex` with a full TeX Live instead:
  `TEXINPUTS=export/template//: BIBINPUTS=References: BSTINPUTS=export/template: latexmk -pdf -outdir=export export/paper.tex`

## Syncing with Overleaf (premium, Git integration)

`export/overleaf/` is a git checkout of your Overleaf project, and Paperboard keeps the paper written into it: `main.tex` with `% beat:` markers, the template's files, `references.bib` and the figures. In the PDF panel, **Set up sync with Overleaf** puts `Sync with Overleaf.command` in the project folder. Make it runnable once (`chmod +x`), then double-click it to sync.

- **First run.** It asks for your Overleaf Git token, which goes into the macOS Keychain under "Paperboard Overleaf", and for the project's Git link.
- **Each run.** It commits Paperboard's version, pulls Overleaf's changes, merges them, and pushes.
- **Back into the beats.** Paperboard (open in Chrome) merges Overleaf's edits back into the beats it can match by marker. Preamble edits go to `export/template/main.tex`, and new references to `References/references.bib`. Edits to figure or table floats are kept in that beat's Notes.
- **Clashes.** If both sides changed the same lines, the script sets the three versions aside in `export/overleaf-merge/` and takes Overleaf's. Paperboard merges them beat by beat and shows "Needs your choice" where they clash. Double-click again to send the result.

`test/sync_script_test.sh` tests the script against a local stand-in for Overleaf.

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
- `src/`: `head.html` (styles and markup), `core.js` (beat format, merging, cursor mapping, Markdown to LaTeX), `app.js` (board, editor, files, live refresh), `research.js` (beat types, figures, code, dependencies), `latex.js` (assembling and compiling the paper), `overleaf.js` and `sync-with-overleaf.command` (the Overleaf round trip).
- `vendor/`: texlyre-busytex (AGPL-3.0) and its TeX Live data. `texlive-recommended.data` is split into parts under 100 MB for GitHub; the loader joins them (marked `PAPERBOARD PATCH`).
- `sample/`: a small demo paper project. **Its numbers are synthetic demo data.**
- `test/`: `node test/core.test.js src/core.js sample/Beats` (format and merge tests); `test/browser_test.py <url> sample <outdir>` (headless Chromium with Playwright, using the browser's private file system as the project folder, playing Claude against the open app). Set `ACL_DIR` to a copy of https://github.com/acl-org/acl-style-files to include the compile tests, and `MARKED_JS` to a local `marked@12.0.2` if the CDN is out of reach.

## License

GNU AGPL-3.0 (see `LICENSE`). The in-browser TeX engine, texlyre-busytex, is AGPL-3.0; BusyTeX itself is MIT; TeX Live is under its own free licenses.
