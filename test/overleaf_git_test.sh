#!/bin/bash
# The Overleaf panel's git commands, run for real against a local bare repo standing in for Overleaf,
# and the conflict markers they leave read back by Paperboard's parser (src/core.js).
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Me GIT_AUTHOR_EMAIL=me@x GIT_COMMITTER_NAME=Me GIT_COMMITTER_EMAIL=me@x
# the exact commands the app shows, taken from src/overleaf.js
CMDS="$(node -e '
  const s = require("fs").readFileSync(process.argv[1], "utf8"), line = n => s.match(new RegExp("^const " + n + " = [^\\n]+", "m"))[0];
  const f = new Function("meta", "relPath", "LS", "root", [line("OL_DEFAULT"), line("olDir"), line("shq"), line("olBase"), line("olCd"), line("olFirstCmd"), line("olSyncCmd"), "return [olFirstCmd(\"URL_HERE\"), olSyncCmd()];"].join("\n"));
  console.log(f({ overleaf: {} }, p => p, { get: () => process.env.PB_BASE || "" }, { name: "proj" }).join("\n"));' "$ROOT/src/overleaf.js")"
FIRST="$(printf '%s\n' "$CMDS" | sed -n 1p)"; SYNC="$(printf '%s\n' "$CMDS" | sed -n 2p)"
[ -n "$FIRST" ] && [ -n "$SYNC" ] || { echo "FAIL couldn't read the commands from the app"; exit 1; }
first() { eval "${FIRST//URL_HERE/$1}"; }
pass=0; fail=0; ok() { if eval "$2"; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
cd "$T"
overleaf_like() { mkdir -p "$1/hooks"; printf '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] || { echo "error: wrong branch"; exit 1; }; done\n' > "$1/hooks/pre-receive"; chmod +x "$1/hooks/pre-receive"; }
# (a) a truly empty Overleaf project
git init -q --bare empty.git; git --git-dir=empty.git symbolic-ref HEAD refs/heads/main; overleaf_like empty.git
mkdir pa; cd pa; mkdir -p export/overleaf; printf 'PAPER\n' > export/overleaf/main.tex; printf '@misc{a}\n' > export/overleaf/references.bib
first "$T/empty.git" >/dev/null 2>&1
ok "first push into an empty Overleaf project sends the paper" '[ "$(git --git-dir=../empty.git show main:main.tex)" = PAPER ] && git --git-dir=../empty.git show main:references.bib >/dev/null 2>&1'
ok "…and comes back to the project folder" '[ -d export ]'
cd ..
# (b) an "empty" project that Overleaf gave a starter main.tex; this is the one the rest of the tests use
git init -q --bare overleaf.git; git --git-dir=overleaf.git symbolic-ref HEAD refs/heads/main; overleaf_like overleaf.git
git clone -q overleaf.git coauthor 2>/dev/null; (cd coauthor && printf 'starter\n' > main.tex && git add -A && git commit -qm init && git push -q origin HEAD:main 2>/dev/null)
mkdir proj; cd proj; mkdir -p export/overleaf; printf 'A\nB\nC\nD\n' > export/overleaf/main.tex
first "$T/overleaf.git" >/dev/null 2>&1
ok "first push over Overleaf's starter main.tex: Paperboard's version wins" '[ "$(git --git-dir=../overleaf.git show main:main.tex)" = "$(printf "A\nB\nC\nD")" ]'
first "$T/overleaf.git" >/dev/null 2>&1
ok "running the first-push command twice does no harm" '[ "$(git --git-dir=../overleaf.git show main:main.tex)" = "$(printf "A\nB\nC\nD")" ] && [ -z "$(git -C export/overleaf status --porcelain)" ]'
(cd ../coauthor && git pull -q --no-rebase origin main 2>/dev/null && sed -i.bak "s/^A$/A overleaf/" main.tex && rm -f main.tex.bak && git commit -qam e && git push -q origin HEAD:main 2>/dev/null)
sed -i.bak 's/^D$/D paperboard/' export/overleaf/main.tex; rm -f export/overleaf/main.tex.bak; eval "$SYNC" >/dev/null 2>&1
ok "edits on both sides in different lines merge and go to Overleaf" '[ "$(git --git-dir=../overleaf.git show main:main.tex)" = "$(printf "A overleaf\nB\nC\nD paperboard")" ]'
(cd ../coauthor && git pull -q origin main 2>/dev/null && sed -i.bak "s/^B$/B coauthor/" main.tex && rm -f main.tex.bak && git commit -qam e2 && git push -q origin HEAD:main 2>/dev/null)
sed -i.bak 's/^B$/B me/' export/overleaf/main.tex; rm -f export/overleaf/main.tex.bak; eval "$SYNC" >/dev/null 2>&1
ok "a clash leaves diff3 conflict markers and pushes nothing" 'grep -q "^|||||||" export/overleaf/main.tex && ! git --git-dir=../overleaf.git show main:main.tex | grep -q "B me"'
SIDES="$(node -e 'const C = require(process.argv[1]); const g = C.gitConflictSides(require("fs").readFileSync(process.argv[2], "utf8")); console.log(JSON.stringify(g));' "$ROOT/src/core.js" export/overleaf/main.tex)"
ok "Paperboard reads the common, its own and Overleaf's version from the markers" 'node -e "const g = JSON.parse(process.argv[1]); process.exit(g.conflict && g.hasBase && g.base === \"A overleaf\nB\nC\nD paperboard\n\" && g.ours === \"A overleaf\nB me\nC\nD paperboard\n\" && g.theirs === \"A overleaf\nB coauthor\nC\nD paperboard\n\" ? 0 : 1)" "$SIDES"'
printf 'A overleaf\nB me and coauthor\nC\nD paperboard\n' > export/overleaf/main.tex   # what Paperboard writes after merging the beats
eval "$SYNC" >/dev/null 2>&1
ok "running the same command again sends the resolved version" '[ "$(git --git-dir=../overleaf.git show main:main.tex)" = "$(printf "A overleaf\nB me and coauthor\nC\nD paperboard")" ]'
# with the project's full path given in the panel, the command works from any directory
cmds_for() { PB_BASE="$1" node -e '
  const s = require("fs").readFileSync(process.argv[1], "utf8"), line = n => s.match(new RegExp("^const " + n + " = [^\n]+", "m"))[0];
  const f = new Function("meta", "relPath", "LS", "root", [line("OL_DEFAULT"), line("olDir"), line("shq"), line("olBase"), line("olCd"), line("olSyncCmd"), "return olSyncCmd();"].join("\n"));
  console.log(f({ overleaf: {} }, p => p, { get: () => process.env.PB_BASE }, { name: "proj" }));' "$ROOT/src/overleaf.js"; }
ABS="$(cmds_for "$T/proj/")"
printf 'A overleaf\nB me and coauthor\nC\nD paperboard, from anywhere\n' > export/overleaf/main.tex
(cd / && eval "$ABS") >/dev/null 2>&1
ok "with the project's path, the sync command works from any folder" '[ "$(git --git-dir=../overleaf.git show main:main.tex | tail -1)" = "D paperboard, from anywhere" ]'
ok "…and the path is quoted (spaces are fine)" 'case "$(cmds_for "/Users/me/My Papers/proj")" in "cd \"/Users/me/My Papers/proj/export/overleaf\" &&"*) true;; *) false;; esac'
ok "…and ~/ still expands" 'case "$(cmds_for "~/My Papers/proj")" in "cd ~/\"My Papers/proj/export/overleaf\" &&"*) true;; *) false;; esac'
echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
