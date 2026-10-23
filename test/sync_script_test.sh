#!/bin/bash
# Tests "Sync with Overleaf.command" against a local bare repo standing in for Overleaf (no Keychain needed).
set -u
SRC="$(cd "$(dirname "$0")/.." && pwd)/src/sync-with-overleaf.command"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export PAPERBOARD_OVERLEAF_TOKEN=test PAPERBOARD_NO_PAUSE=1 GIT_CONFIG_GLOBAL=/dev/null
pass=0; fail=0; ok() { if eval "$2"; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1"; fi; }
cd "$T"; git init -q --bare overleaf.git; git --git-dir=overleaf.git symbolic-ref HEAD refs/heads/master
git clone -q overleaf.git seed 2>/dev/null; cd seed; git config user.email a@b; git config user.name Coauthor
printf 'starter\n' > main.tex; git add -A; git commit -qm init; git push -q origin HEAD:master 2>/dev/null; cd ..
mkdir proj; cp "$SRC" "proj/Sync with Overleaf.command"; chmod +x "proj/Sync with Overleaf.command"; S="$T/proj/Sync with Overleaf.command"; R="$T/proj/export/overleaf"
echo "file://$T/overleaf.git" | "$S" >/dev/null
ok "first run connects: export/overleaf is a checkout of the Overleaf project" '[ -d "$R/.git" ] && [ "$(cat "$R/main.tex")" = starter ]'
printf 'A\nB\nC\nD\n' > "$R/main.tex"; "$S" </dev/null >/dev/null
ok "Paperboard's version is pushed" '[ "$(git --git-dir=overleaf.git show master:main.tex)" = "$(printf "A\nB\nC\nD")" ]'
(cd seed && git pull -q origin master 2>/dev/null && sed -i.bak 's/^A$/A overleaf/' main.tex && git commit -qam e && git push -q origin HEAD:master 2>/dev/null)
sed -i.bak 's/^D$/D paperboard/' "$R/main.tex"; rm -f "$R/main.tex.bak"; "$S" </dev/null >/dev/null
ok "edits on both sides in different lines merge and push" '[ "$(git --git-dir=overleaf.git show master:main.tex)" = "$(printf "A overleaf\nB\nC\nD paperboard")" ]'
(cd seed && git pull -q origin master 2>/dev/null && sed -i.bak 's/^B$/B coauthor/' main.tex && git commit -qam e2 && git push -q origin HEAD:master 2>/dev/null)
sed -i.bak 's/^B$/B me/' "$R/main.tex"; rm -f "$R/main.tex.bak"; out="$("$S" </dev/null)"
M="$(ls -d "$T"/proj/export/overleaf-merge/* 2>/dev/null | head -1)"
ok "a clash sets base/ours/theirs aside and takes Overleaf's version" '[ -n "$M" ] && grep -q "B me" "$M/ours-main.tex" && grep -q "B coauthor" "$M/theirs-main.tex" && grep -qx "B" "$M/base-main.tex" && grep -q "B coauthor" "$R/main.tex"'
ok "…and says so" 'printf %s "$out" | grep -q "both changed the same lines"'
sed -i.bak 's/^B coauthor$/B resolved/' "$R/main.tex"; rm -f "$R/main.tex.bak"; "$S" </dev/null >/dev/null
ok "after Paperboard resolves it, the next run pushes the result" 'git --git-dir=overleaf.git show master:main.tex | grep -qx "B resolved"'
echo "$pass passed, $fail failed"; [ "$fail" = 0 ]
