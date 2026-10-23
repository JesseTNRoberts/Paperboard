#!/bin/sh
# Assemble the single-file app from its parts (only for development; the result has no build step).
cd "$(dirname "$0")"
{ cat src/head.html; printf '<script id="core">\n'; cat src/core.js; printf '</script>\n<script>\n"use strict";\n'; cat src/app.js; cat src/research.js; cat src/latex.js; node -e 'process.stdout.write("const SYNC_SCRIPT_TEXT = " + JSON.stringify(require("fs").readFileSync("src/sync-with-overleaf.command", "utf8")) + ";\n")'; cat src/overleaf.js; printf '</script>\n</body>\n</html>\n'; } > index.html
