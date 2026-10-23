#!/bin/bash
# Sync with Overleaf (written by Paperboard). Double-click to send the paper to Overleaf and bring Overleaf's edits back.
#
# export/overleaf/ is a git copy of your Overleaf project. Paperboard keeps the paper written into it, and this script:
#   1. commits what Paperboard wrote,
#   2. pulls Overleaf's changes and merges them,
#   3. pushes the result to Overleaf.
# Paperboard (open in Chrome) then merges Overleaf's edits back into the beats.
# If both sides changed the same lines, this script sets the three versions aside in export/overleaf-merge/ and takes
# Overleaf's version; Paperboard merges them beat by beat and asks you where they clash; then double-click again.
#
# The Overleaf token is kept in your macOS Keychain (service "Paperboard Overleaf"), never in a file.

cd "$(dirname "$0")" || exit 1
REPO="export/overleaf"
SERVICE="Paperboard Overleaf"
TRIPLES="main.tex references.bib"
say() { printf '%s\n' "$*"; }
finish() { say ""; say "$1"; say ""; [ -t 0 ] && [ -z "$PAPERBOARD_NO_PAUSE" ] && read -n 1 -s -r -p "Press any key to close."; echo; exit "${2:-0}"; }

command -v git >/dev/null 2>&1 || finish "git isn't installed. Run 'xcode-select --install' in Terminal, then try again." 1

token_get() {
  if [ -n "$PAPERBOARD_OVERLEAF_TOKEN" ]; then printf %s "$PAPERBOARD_OVERLEAF_TOKEN"; return; fi
  security find-generic-password -a "$USER" -s "$SERVICE" -w 2>/dev/null
}
TOKEN="$(token_get)"
if [ -z "$TOKEN" ]; then
  say "Paste your Overleaf Git authentication token (Overleaf: Account Settings > Git integration),"
  say "then press Return. It goes into your macOS Keychain; you won't be asked again."
  read -r -s TOKEN; echo
  [ -n "$TOKEN" ] || finish "No token given; nothing changed." 1
  security add-generic-password -U -a "$USER" -s "$SERVICE" -l "Paperboard Overleaf token" -w "$TOKEN" >/dev/null || finish "Couldn't save the token to the Keychain." 1
fi

ASKPASS="$(mktemp -t paperboard-askpass.XXXXXX)" || exit 1
trap 'rm -f "$ASKPASS"' EXIT
printf '#!/bin/sh\ncase "$1" in *sername*) echo git ;; *) printf "%%s\\n" "$PAPERBOARD_TOKEN" ;; esac\n' > "$ASKPASS"
chmod 700 "$ASKPASS"
export GIT_ASKPASS="$ASKPASS" PAPERBOARD_TOKEN="$TOKEN" GIT_TERMINAL_PROMPT=0
git_() { git -c credential.helper= -c core.quotepath=off "$@"; }

if [ ! -d "$REPO/.git" ]; then
  say "Connecting this project to Overleaf."
  say "Paste the project's Git link (Overleaf: Menu > Integrations > Git), e.g. https://git.overleaf.com/0123456789abcdef01234567"
  read -r URL
  URL="$(printf %s "$URL" | sed -E 's#^ *git clone +##; s#^(https?://)[^@/]*@#\1#; s# *$##')"
  [ -n "$URL" ] || finish "No link given; nothing changed." 1
  mkdir -p export
  if [ -e "$REPO" ] && [ -n "$(ls -A "$REPO" 2>/dev/null)" ]; then
    TMP="$REPO.clone-$$"
    git_ clone -q "$URL" "$TMP" || finish "Couldn't reach that Overleaf project. Check the link and the token (to re-enter the token, delete 'Paperboard Overleaf' in Keychain Access)." 1
    mv "$TMP/.git" "$REPO/.git" && rm -rf "$TMP"
  else
    git_ clone -q "$URL" "$REPO" || finish "Couldn't reach that Overleaf project. Check the link and the token (to re-enter the token, delete 'Paperboard Overleaf' in Keychain Access)." 1
  fi
  git_ -C "$REPO" config user.name "${PAPERBOARD_GIT_NAME:-Paperboard}"
  git_ -C "$REPO" config user.email "${PAPERBOARD_GIT_EMAIL:-paperboard@localhost}"
  finish "Connected. Paperboard (open in Chrome) now puts the paper into export/overleaf. Double-click this again to send it to Overleaf."
fi

cd "$REPO" || exit 1
BR="$(git_ rev-parse --abbrev-ref HEAD)"
git_ add -A
git_ diff --cached --quiet || git_ commit -q -m "Paperboard $(date '+%Y-%m-%d %H:%M')"
git_ fetch -q origin || finish "Couldn't reach Overleaf. Check your connection (and the token: to re-enter it, delete 'Paperboard Overleaf' in Keychain Access)." 1

if ! git_ merge -q --no-edit "origin/$BR" >/dev/null 2>&1; then
  STAMP="$(date '+%Y-%m-%d-%H%M%S')"
  OUT="../overleaf-merge/$STAMP"
  mkdir -p "$OUT"
  BASE="$(git_ merge-base HEAD "origin/$BR")"
  for f in $TRIPLES; do
    git_ show "$BASE:$f" > "$OUT/base-$f" 2>/dev/null || rm -f "$OUT/base-$f"
    git_ show "HEAD:$f" > "$OUT/ours-$f" 2>/dev/null || rm -f "$OUT/ours-$f"
    git_ show "origin/$BR:$f" > "$OUT/theirs-$f" 2>/dev/null || rm -f "$OUT/theirs-$f"
  done
  git_ merge --abort 2>/dev/null
  git_ reset -q --hard "origin/$BR"
  finish "Overleaf and Paperboard both changed the same lines. Paperboard is merging them beat by beat and will ask you where they clash. Then double-click this again to send the result."
fi

AHEAD="$(git_ rev-list --count "origin/$BR..HEAD")"
if [ "$AHEAD" != "0" ]; then git_ push -q origin "HEAD:$BR" || finish "Overleaf refused the push (someone may have just edited). Double-click again." 1; fi
finish "Synced with Overleaf. Sent: $([ "$AHEAD" != "0" ] && echo yes || echo nothing new). Paperboard is bringing Overleaf's edits into the beats."
