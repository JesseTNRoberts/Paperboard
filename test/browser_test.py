"""Headless Chromium test: the browser's private file system (OPFS) stands in for the project folder,
and the test plays Claude by editing files and touching claude-reload.txt while the app is open."""
import json, os, sys, time, pathlib
from playwright.sync_api import sync_playwright

BASE = sys.argv[1]            # e.g. http://localhost:8765/Storyboard.html
SAMPLE = pathlib.Path(sys.argv[2])
SHOTS = pathlib.Path(sys.argv[3]); SHOTS.mkdir(parents=True, exist_ok=True)
results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok))); print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  -- {detail}"), flush=True)

FS_JS = """
window.T = {
  async dir(path, create) { let d = await navigator.storage.getDirectory(); for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, {create}); return d; },
  async write(path, text) { const parts = path.split('/'), name = parts.pop(); const d = await T.dir(parts.join('/'), true); const h = await d.getFileHandle(name, {create:true}); const w = await h.createWritable(); await w.write(text); await w.close(); },
  async writeB64(path, b64) { const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const parts = path.split('/'), name = parts.pop(); const d = await T.dir(parts.join('/'), true); const h = await d.getFileHandle(name, {create:true}); const w = await h.createWritable(); await w.write(bin); await w.close(); },
  async read(path) { const parts = path.split('/'), name = parts.pop(); const d = await T.dir(parts.join('/')); return (await (await d.getFileHandle(name)).getFile()).text(); },
  async mtime(path) { const parts = path.split('/'), name = parts.pop(); const d = await T.dir(parts.join('/')); return (await (await d.getFileHandle(name)).getFile()).lastModified; },
  async exists(path) { try { await T.read(path); return true; } catch (e) { return false; } },
  async ls(path) { const d = await T.dir(path); const out = []; for await (const [n, h] of d.entries()) out.push(n + (h.kind === 'directory' ? '/' : '')); return out.sort(); },
  async rm(path) { const parts = path.split('/'), name = parts.pop(); const d = await T.dir(parts.join('/')); await d.removeEntry(name, {recursive:true}); },
  async touch(root) { await T.write(root + '/claude-reload.txt', 'reload ' + Date.now()); },
};
"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme="light")
    ctx.add_init_script("window.__rsbNoRemember = true")
    MARKED_JS = os.environ.get("MARKED_JS", "node_modules/marked/marked.min.js")   # npm install: serve the pinned library locally when the CDN is out of reach
    if os.path.exists(MARKED_JS):
        MARKED = open(MARKED_JS).read()
        ctx.route("**/marked.min.js", lambda r: r.fulfill(body=MARKED, content_type="text/javascript"))
    ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(BASE); page.evaluate(FS_JS)
    ev = lambda js, arg=None: page.evaluate(js, arg)

    # clean slate
    ev("async () => { const r = await navigator.storage.getDirectory(); for await (const [n] of r.entries()) await r.removeEntry(n, {recursive:true}); }")

    # ---------- 1. a new project from a template ----------
    ev("async () => { await T.write('fresh/Beats/Some idea.md', 'Just a thought, no header.\\n'); }")
    ev("async () => storyboard.openFolder(await T.dir('fresh'))")
    page.wait_for_selector(".tpl")
    page.screenshot(path=str(SHOTS / "0-template-picker.png"))
    page.click('.tpl[data-t="nih"]'); page.click("#create")
    page.wait_for_selector(".card")
    dirs = ev("() => T.ls('fresh')")
    check("template creates the project folders", all(d in dirs for d in ["Beats/", "Notes/", "References/", "Claude/", "code/", "data/", "results/", "figures/", "export/", "Backups/", "board.json"]), dirs)
    board = json.loads(ev("() => T.read('fresh/board.json')"))
    check("NIH template sections", [a["name"] for a in board["acts"]][:4] == ["Specific Aims", "Significance", "Innovation", "Approach: Aim 1"], board["acts"])
    page.wait_for_timeout(800)
    idea = ev("() => T.read('fresh/Beats/Some idea.md')")
    check("a beat without an ID gets one, its text kept as the body", idea.startswith("ID: b-") and idea.endswith("Just a thought, no header.\n"), idea)

    # ---------- 1b. New project: pick where it goes, name it, the app makes the folder ----------
    page.reload(); page.evaluate(FS_JS)
    ev("() => { window.showDirectoryPicker = async () => T.dir('Documents', true); }")   # stands in for the folder picker
    page.wait_for_selector("#newproj"); page.click("#newproj"); page.wait_for_selector("#pname")
    page.screenshot(path=str(SHOTS / "0b-new-project.png"))
    page.fill("#pname", "Sensor grant: draft 1"); page.click('.tpl[data-t="nsf"]'); page.click("#create")
    page.wait_for_function("() => document.getElementById('gate').hidden", timeout=8000)
    made = ev("() => T.ls('Documents')")
    check("New project makes a named folder inside the chosen one", "Sensor grant draft 1/" in made, made)
    inner = ev("() => T.ls('Documents/Sensor grant draft 1')")
    check("…with board.json and every project folder", all(x in inner for x in ["board.json", "Beats/", "Notes/", "References/", "Claude/", "code/", "data/", "results/", "figures/", "export/", "Backups/"]), inner)
    check("…using the chosen template, and the board opens", json.loads(ev("() => T.read('Documents/Sensor grant draft 1/board.json')"))["template"] == "nsf" and page.inner_text("#projname") == "Sensor grant draft 1")
    page.reload(); page.evaluate(FS_JS); ev("() => { window.showDirectoryPicker = async () => T.dir('Documents', true); }")
    page.wait_for_selector("#newproj"); page.click("#newproj"); page.wait_for_selector("#pname"); page.fill("#pname", "Sensor grant draft 1"); page.click("#create"); page.wait_for_timeout(500)
    check("New project won't reuse an existing project's name", "already a Paperboard project" in page.inner_text("#gateerr"), page.inner_text("#gateerr"))

    # ---------- 2. the sample project ----------
    import base64
    allf = sorted((f for f in SAMPLE.rglob("*") if f.is_file()), key=lambda f: (f.parts[len(SAMPLE.parts)] == "figures", str(f)))   # outputs written last, as a real run would
    files = {str(f.relative_to(SAMPLE)): f.read_text() for f in allf if f.suffix not in (".png", ".pdf")}
    ev("async (files) => { for (const [p, t] of Object.entries(files)) await T.write('sample/' + p, t); }", files)
    page.wait_for_timeout(1100)
    for f in allf:
        if f.suffix in (".png", ".pdf"): ev("async ([p, b]) => T.writeB64('sample/' + p, b)", [str(f.relative_to(SAMPLE)), base64.b64encode(f.read_bytes()).decode()])
    PNG_B64 = base64.b64encode((SAMPLE / "figures/calibration_error.png").read_bytes()).decode()
    page.reload(); page.evaluate(FS_JS)
    ev("async () => storyboard.openFolder(await T.dir('sample'))")
    page.wait_for_selector(".card")
    page.wait_for_timeout(2500)   # generated files
    st = ev("() => storyboard.state()")
    check("sample: 8 live beats, 1 marked for deletion", len(st["beats"]) == 8 and len(st["marked"]) == 1, st)
    check("Restore button shows the marked beat", page.inner_text("#restore") == "Restore (1)")
    orig = {k: v for k, v in files.items() if k.startswith("Beats/") and "Satellite" not in k}
    code_orig = {k: v for k, v in files.items() if k.startswith("code/")}
    after = ev("async (names) => { const o = {}; for (const n of names) o[n] = await T.read('sample/' + n); return o; }", list(orig))
    check("opening the project changes no beat file (byte-identical)", all(after[k] == orig[k] for k in orig), [k for k in orig if after[k] != orig[k]])
    ls = ev("() => T.ls('sample')")
    check("digest.md, Claude adjusts.md, storyboard-open.json written", all(x in ls for x in ["digest.md", "Claude adjusts.md", "storyboard-open.json"]), ls)
    digest = ev("() => T.read('sample/digest.md')")
    H = lambda t: digest.index(" " + t + "\n\n_")
    check("digest lists beats in document order with checks", H("Opening problem statement") < H("Contributions") < H("Prior calibration work") < H("Calibration experiment") < H("Figure 1 calibration error") < H("Results overview") < H("Limitations")
          and "Beats with a Claude adjust (2):** Contributions; Results overview" in digest and "[Open] items (1):** Contributions" in digest, digest[:1500])
    adj = ev("() => T.read('sample/Claude adjusts.md')")
    check("Claude adjusts.md lists both adjusts with file paths", "## Contributions" in adj and "Beats/Results overview.md" in adj and "Tighten this to three bullet points" in adj)
    notes = ev("() => T.ls('sample/Notes')")
    check("section notes written", "Section - Introduction.md" in notes, notes)
    sn = ev("() => T.read('sample/Notes/Section - Introduction.md')")
    check("section note lists its beats below BEATS IN ORDER", "BEATS IN ORDER" in sn and "1. Opening problem statement\n2. Contributions" in sn, sn)
    dmt = ev("() => T.mtime('sample/digest.md')")
    page.wait_for_timeout(3500)
    check("digest not rewritten when nothing changed", ev("() => T.mtime('sample/digest.md')") == dmt)
    backups = ev("() => T.ls('sample/Backups')")
    check("daily backup made in Backups/", any(b.endswith(" daily/") for b in backups), backups)

    # board screenshots
    page.click("#fit"); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "1-board-light.png"))
    page.click("#sectionsbtn"); page.click('#ctx [data-fit="s2"]'); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "1b-section-light.png"))
    page.click("#fit"); page.wait_for_timeout(200)

    # ---------- 3. open a beat, type, Claude edits the same file elsewhere ----------
    view0 = ev("() => storyboard.state().view")
    page.click('.card[data-key="b-intro1"]')
    page.wait_for_selector("#f-title")
    open_json = json.loads(ev("() => T.read('sample/storyboard-open.json')"))
    check("storyboard-open.json names the open beat", open_json["open"] == "Beats/Opening problem statement.md", open_json)
    mt0 = ev("() => T.mtime('sample/Beats/Contributions.md')")
    page.click('[data-tab="beat"]')
    # put the cursor after "drift" in the last paragraph and type
    ev("""() => { const ta = document.getElementById('f-text'); const i = ta.value.indexOf('drift') + 5; ta.focus(); ta.setSelectionRange(i, i); }""")
    page.keyboard.type(" sharply", delay=10)
    # Claude, within the save window: edits the first paragraph and appends notes below
    ev("""async () => {
      let t = await T.read('sample/Beats/Opening problem statement.md');
      t = t.replace('Urban air quality is usually measured', 'Urban air quality is mostly measured');
      t = t.replace(/\\n*$/, '\\n') + '\\n=== Notes ===\\n\\nClaude adjust (done 2026-10-23):\\n\\nTightened the opening.\\n';
      await T.write('sample/Beats/Opening problem statement.md', t); await T.touch('sample'); }""")
    page.wait_for_timeout(4500)
    ta = ev("() => { const ta = document.getElementById('f-text'); return { v: ta.value, s: ta.selectionStart, focused: document.activeElement === ta }; }")
    check("editor shows both your typing and Claude's edit", "drift sharply" in ta["v"] and "mostly measured" in ta["v"], ta["v"])
    check("cursor stayed on the same words", ta["v"][:ta["s"]].endswith("drift sharply"), ta["v"][max(0, ta["s"] - 30):ta["s"] + 10])
    check("focus stayed in the editor", ta["focused"])
    notes_v = ev("() => document.getElementById('f-notes').value")
    check("Notes tab updated in place with Claude's appended note", "Tightened the opening." in notes_v, notes_v)
    page.wait_for_timeout(1200)
    disk = ev("() => T.read('sample/Beats/Opening problem statement.md')")
    check("merged text written back to the file", "drift sharply" in disk and "mostly measured" in disk and "Tightened the opening." in disk, disk)
    check("card highlighted as changed", "changed" in page.get_attribute('.card[data-key="b-intro1"]', "class"))
    check("Clear highlights button shows", page.is_visible("#clearhl"))
    check("view did not move", ev("() => storyboard.state().view") == view0, (view0, ev("() => storyboard.state().view")))
    check("unrelated beat files untouched", ev("() => T.mtime('sample/Beats/Contributions.md')") == mt0)
    # every tab saves: type in Synopsis, check only the synopsis changed
    before = ev("() => T.read('sample/Beats/Opening problem statement.md')")
    page.click('[data-tab="syn"]'); ev("() => { const t = document.getElementById('f-syn'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); }"); page.keyboard.type(" Added.", delay=5)
    page.wait_for_timeout(1500)
    after_syn = ev("() => T.read('sample/Beats/Opening problem statement.md')")
    check("synopsis tab saves, and only the synopsis changes", after_syn == before.replace("close that gap.\n", "close that gap. Added.\n", 1), after_syn[:400])
    page.click('[data-tab="adj"]'); page.focus("#f-adj"); page.keyboard.type("Check the EPA figure.", delay=5)
    page.wait_for_timeout(2500)
    check("Claude adjust tab saves and the adjust dot shows", "Check the EPA figure." in ev("() => T.read('sample/Beats/Opening problem statement.md')") and page.is_visible("#f-adjdot"))
    check("Claude adjusts.md picks up the new adjust", "Check the EPA figure." in ev("() => T.read('sample/Claude adjusts.md')"))
    page.click('[data-size="half"]'); page.click('[data-tab="beat"]'); page.click('[data-view="split"]'); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "2-editor-light.png"))
    page.click('[data-tab="adj"]'); page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / "2b-editor-adjust-light.png"))
    page.click('[data-tab="beat"]')

    # opening and closing a beat without editing leaves the file alone
    page.keyboard.press("Escape"); page.wait_for_timeout(300)
    mt_res = ev("() => T.mtime('sample/Beats/Results overview.md')")
    page.click('.card[data-key="b-res1"]'); page.wait_for_selector("#f-title"); page.wait_for_timeout(1500); page.keyboard.press("Escape")
    check("opening and closing a beat doesn't write it", ev("() => T.mtime('sample/Beats/Results overview.md')") == mt_res)

    # ---------- 4. a true conflict ----------
    page.click('.card[data-key="b-intro2"]'); page.wait_for_selector("#f-title"); page.click('[data-tab="beat"]')
    ev("""() => { const ta = document.getElementById('f-text'); ta.focus(); const i = ta.value.indexOf('We make three contributions.'); ta.setSelectionRange(i, i + 'We make three contributions.'.length); }""")
    page.keyboard.type("This paper makes three contributions.", delay=2)
    ev("""async () => { let t = await T.read('sample/Beats/Contributions.md'); t = t.replace('We make three contributions.', 'We offer three contributions.'); await T.write('sample/Beats/Contributions.md', t); await storyboard.poll(); }""")
    page.wait_for_selector(".panel.conflictp", timeout=6000)
    page.wait_for_timeout(1500)
    disk = ev("() => T.read('sample/Beats/Contributions.md')")
    check("conflict: nothing written until you choose", "We offer three contributions." in disk and "This paper makes" not in disk, disk)
    check("conflict: card says Needs your choice", "conflict" in page.get_attribute('.card[data-key="b-intro2"]', "class"))
    check("conflict: toolbar button shows", page.is_visible("#conflictsbtn"))
    check("conflict: combined text has markers", "<<<<<<< Your version" in ev("() => document.getElementById('cf-text').value"))
    page.screenshot(path=str(SHOTS / "3-conflict-light.png"))
    page.click("#cf-mine"); page.wait_for_timeout(1500)
    disk = ev("() => T.read('sample/Beats/Contributions.md')")
    check("Keep mine writes your version", "This paper makes three contributions." in disk and "We offer" not in disk, disk)
    conf = ev("() => T.ls('sample/Backups/Conflicts')")
    check("the version you didn't keep is in Backups/Conflicts", any("Claude's version" in c for c in conf), conf)
    check("conflict cleared", not page.is_visible("#conflictsbtn") and "conflict" not in page.get_attribute('.card[data-key="b-intro2"]', "class"))
    page.keyboard.press("Escape")

    # ---------- 5. Claude renames a beat, adds two beats ----------
    pos_before = json.loads(ev("() => T.read('sample/board.json')"))["beats"]["b-disc1"]
    ev("""async () => {
      const t = await T.read('sample/Beats/Limitations.md');
      await T.write('sample/Beats/Limitations of the deployment.md', t); await T.rm('sample/Beats/Limitations.md');
      await T.write('sample/Beats/Wildfire smoke.md', 'ID: b-smoke1\\nType: Paragraph\\nStatus:\\nSynopsis: Smoke events break the correction.\\n\\nClaude adjust:\\n\\n---\\n\\nDuring smoke events the sensors over-read.\\n');
      await T.write('sample/Beats/Seasonal check.md', 'ID: b-season\\nType: Experiment\\nStatus:\\nSynopsis: Does the model hold in winter?\\n\\nClaude adjust:\\n\\n---\\n\\n');
      const b = JSON.parse(await T.read('sample/board.json')); b.beats['b-smoke1'] = { x: 4352 + 40 + 524, y: 155, tags: [] };
      await T.write('sample/board.json', JSON.stringify(b, null, 1)); await T.touch('sample'); }""")
    page.wait_for_timeout(4500)
    st = ev("() => storyboard.state()")
    disc = [b for b in st["beats"] if b["key"] == "b-disc1"]
    check("rename: same card, new title", disc and disc[0]["title"] == "Limitations of the deployment" and page.inner_text('.card[data-key="b-disc1"] h3') == "Limitations of the deployment", disc)
    pos_after = json.loads(ev("() => T.read('sample/board.json')"))["beats"]["b-disc1"]
    check("rename: position kept", pos_after["x"] == pos_before["x"] and pos_after["y"] == pos_before["y"], (pos_before, pos_after))
    check("new beats appear", page.is_visible('.card[data-key="b-smoke1"]') and page.is_visible('.card[data-key="b-season"]'))
    sm = page.eval_on_selector('.card[data-key="b-smoke1"]', "e => [e.style.left, e.style.top]")
    check("new beat uses Claude's layout entry", sm == ["4916px", "155px"], sm)
    hl = st["hl"]
    check("renamed and new beats highlighted", all(k in hl for k in ["b-disc1", "b-smoke1", "b-season"]), hl)
    page.click("#fit"); page.wait_for_timeout(200)
    page.screenshot(path=str(SHOTS / "4-after-claude-light.png"))

    # ---------- 6. TO DELETE and Restore ----------
    pos = page.eval_on_selector('.card[data-key="b-season"]', "e => [e.style.left, e.style.top]")
    page.click('.card[data-key="b-season"]', modifiers=["Shift"])
    page.click('.card[data-key="b-smoke1"]', modifiers=["Shift"])
    page.keyboard.press("Meta+Backspace"); page.wait_for_timeout(1200)
    beats_ls = ev("() => T.ls('sample/Beats')")
    check("⌘⌫ marks both selected beats TO DELETE in one press", "TO DELETE - Seasonal check.md" in beats_ls and "TO DELETE - Wildfire smoke.md" in beats_ls and "Seasonal check.md" not in beats_ls, beats_ls)
    check("their cards are hidden", not page.query_selector('.card[data-key="b-season"]'))
    check("Restore count updated", page.inner_text("#restore") == "Restore (3)", page.inner_text("#restore"))
    page.click("#restore"); page.click('#r-list button:has-text("Seasonal check")'); page.wait_for_timeout(1000)
    check("Restore brings the file and card back where it was", "Seasonal check.md" in ev("() => T.ls('sample/Beats')") and page.eval_on_selector('.card[data-key="b-season"]', "e => [e.style.left, e.style.top]") == pos)
    page.keyboard.press("Escape")

    # ---------- 7. you rename a beat ----------
    page.click('.card[data-key="b-season"]'); page.wait_for_selector("#f-title")
    page.fill("#f-title", "Winter generalization"); page.keyboard.press("Enter"); page.wait_for_timeout(1200)
    bl = ev("() => T.ls('sample/Beats')")
    check("title rename renames the file, ID unchanged", "Winter generalization.md" in bl and "Seasonal check.md" not in bl and ev("() => T.read('sample/Beats/Winter generalization.md')").startswith("ID: b-season"), bl)
    check("storyboard-open.json follows the rename", json.loads(ev("() => T.read('sample/storyboard-open.json')"))["open"] == "Beats/Winter generalization.md")
    page.keyboard.press("Escape")

    # ---------- 8. layout merge: Claude moves a card while you move another; clash on a third ----------
    ev("async () => storyboard.flush()")
    page.wait_for_timeout(500)
    box = page.query_selector('.card[data-key="b-exp1"]').bounding_box()
    cxp, cyp = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(cxp, cyp); page.mouse.down(); page.mouse.move(cxp + 40, cyp, steps=5); page.mouse.up()
    my_x = ev("() => parseInt(document.querySelector('.card[data-key=\"b-exp1\"]').style.left)")
    ev("""async () => { const b = JSON.parse(await T.read('sample/board.json')); b.beats['b-ref1'].x += 262; b.beats['b-exp1'].y += 240; await T.write('sample/board.json', JSON.stringify(b, null, 1)); await storyboard.poll(); }""")
    page.wait_for_timeout(2500)
    b = json.loads(ev("() => T.read('sample/board.json')"))["beats"]
    check("layout merge: Claude's move kept, your move kept, yours wins the clash", b["b-ref1"]["x"] == 2176 + 40 + 262 and b["b-exp1"]["y"] == 155 + 240 and b["b-exp1"]["x"] == my_x and my_x != 3304, (b["b-ref1"], b["b-exp1"], my_x))
    check("clashing card highlighted", "b-exp1" in ev("() => storyboard.state().hl"))

    # ---------- 9. highlights survive a reload; Clear highlights ----------
    n_hl = len(ev("() => storyboard.state().hl"))
    page.reload(); page.evaluate(FS_JS); ev("async () => storyboard.openFolder(await T.dir('sample'))"); page.wait_for_selector(".card", timeout=8000)
    check("highlights survive a reload", len(ev("() => storyboard.state().hl")) == n_hl and page.is_visible("#clearhl"), ev("() => storyboard.state().hl"))
    page.click("#clearhl")
    check("Clear highlights removes them and hides the button", not page.query_selector(".card.changed") and not page.is_visible("#clearhl"))

    # ---------- 10. safety: file text is never treated as HTML ----------
    ev("""async () => { let t = await T.read('sample/Beats/Results overview.md'); t = t.replace('=== Notes ===', 'Body <img src=x onerror="window.__pwned=1"> [x](javascript:window.__pwned=2)\\n\\n=== Notes ==='); await T.write('sample/Beats/Results overview.md', t); await storyboard.poll(); }""")
    page.wait_for_timeout(500)
    page.click('.card[data-key="b-res1"]'); page.wait_for_selector("#f-title"); page.click('[data-size="half"]'); page.click('[data-view="preview"]'); page.wait_for_timeout(500)
    check("raw HTML and javascript: links in a beat are not run", ev("() => !window.__pwned && !document.querySelector('#f-prev img[onerror]') && document.getElementById('f-prev').textContent.includes('<img src=x') && !document.querySelector('#f-prev a[href^=\"javascript\"]')"))
    page.click('[data-view="write"]'); page.keyboard.press("Escape")

    # ---------- P2. figures, code, experiments, dependencies ----------
    page.click("#sectionsbtn"); page.click('#ctx [data-fit="s5"]'); page.wait_for_timeout(1500)
    check("figure card shows a thumbnail of its PNG (the PDF's twin)", ev("() => { const i = document.querySelector('.card[data-key=\"b-fig1\"] img.thumb'); return !!i && i.complete && i.naturalWidth > 100; }"))
    check("project code untouched by opening", all(ev("(p) => T.read('sample/' + p)", k) == v for k, v in code_orig.items()))
    page.screenshot(path=str(SHOTS / "8-results-section-light.png"))
    page.click('.card[data-key="b-fig1"]'); page.wait_for_selector("#f-title"); page.click('[data-size="half"]')
    page.click('[data-tab="type"]'); page.wait_for_timeout(800)
    check("Figure tab shows the image large", ev("() => { const i = document.querySelector('#t-view img'); return !!i && i.naturalWidth > 100; }"))
    check("Figure tab: no stale warning on a fresh figure", page.is_hidden("#t-warn"), page.inner_text("#t-warn") if page.is_visible("#t-warn") else "")
    check("Figure tab shows the dependencies", "Calibration experiment" in page.inner_text("#f-deps") and "Results overview" in page.inner_text("#f-deps"), page.inner_text("#f-deps"))
    before = ev("() => T.read('sample/Beats/Figure 1 calibration error.md')")
    page.fill("#tf-caption", "Calibration error before and after correction, by relative humidity band."); page.wait_for_timeout(1300)
    after = ev("() => T.read('sample/Beats/Figure 1 calibration error.md')")
    check("editing Caption changes only the Caption line", after == before.replace("by humidity band.", "by relative humidity band."), after[:400])
    page.screenshot(path=str(SHOTS / "9-figure-tab-light.png"))
    # the Code tab
    page.click('[data-tab="code"]'); page.wait_for_timeout(800)
    check("Code tab opens the figure's script", ev("() => document.getElementById('c-file').value") == "code/figures/calibration_error.py" and "savefig" in ev("() => document.getElementById('c-text').value"))
    ev("""() => { const ta = document.getElementById('c-text'); ta.focus(); const i = ta.value.indexOf('import csv'); ta.setSelectionRange(i, i); }""")
    page.keyboard.type("# checked by the author\n", delay=5)
    ev("""async () => { const t = await T.read('sample/code/figures/calibration_error.py'); await T.write('sample/code/figures/calibration_error.py', t + '# Claude: added a note at the end\\n'); await T.touch('sample'); }""")
    page.wait_for_timeout(4500)
    code_ta = ev("() => { const ta = document.getElementById('c-text'); return { v: ta.value, s: ta.selectionStart }; }")
    code_disk = ev("() => T.read('sample/code/figures/calibration_error.py')")
    check("Code tab merges your edit with Claude's, and saves the merge", "# checked by the author" in code_ta["v"] and "Claude: added a note" in code_ta["v"] and code_disk == code_ta["v"], code_disk[-200:])
    check("Code tab keeps the cursor on the same words", code_ta["v"][:code_ta["s"]].endswith("# checked by the author\n"))
    page.screenshot(path=str(SHOTS / "10-code-tab-light.png"))
    # the script is now newer than the figure: stale
    ev("() => storyboard.poll()"); page.wait_for_timeout(1500)
    check("script newer than the figure: card says Stale", page.is_visible('.card[data-key="b-fig1"] .staletab'))
    page.click('[data-tab="type"]'); page.wait_for_timeout(600)
    check("Figure tab warns it's stale and names the script", page.is_visible("#t-warn") and "calibration_error.py" in page.inner_text("#t-warn"), page.inner_text("#t-warn") if page.is_visible("#t-warn") else "hidden")
    page.wait_for_timeout(2000)
    check("digest lists the stale figure", "Figure 1 calibration error (changed: code/figures/calibration_error.py)" in ev("() => T.read('sample/digest.md')"))
    # Claude reruns the script: a new PNG
    src0 = page.get_attribute('.card[data-key="b-fig1"] img.thumb', "src")
    page.wait_for_timeout(1100)
    ev("async (b) => { await T.writeB64('sample/figures/calibration_error.png', b); await T.writeB64('sample/figures/calibration_error.pdf', b); await T.touch('sample'); }", PNG_B64)
    page.wait_for_timeout(4500)
    check("regenerated figure: thumbnail reloads and the card is highlighted", page.get_attribute('.card[data-key="b-fig1"] img.thumb', "src") != src0 and "b-fig1" in ev("() => storyboard.state().hl"))
    check("regenerated figure: no longer stale", not page.query_selector('.card[data-key="b-fig1"] .staletab') and page.is_hidden("#t-warn"))
    # a real clash inside the code file
    page.click('[data-tab="code"]'); page.wait_for_timeout(500)
    ev("""() => { const ta = document.getElementById('c-text'); ta.focus(); const a = ta.value.indexOf('ax.set_xlabel'); const e = ta.value.indexOf('\\n', a); ta.setSelectionRange(a, e); }""")
    page.keyboard.type('ax.set_xlabel("Humidity (%)")', delay=3)
    ev("""async () => { const t = await T.read('sample/code/figures/calibration_error.py'); await T.write('sample/code/figures/calibration_error.py', t.replace(/^ax\\.set_xlabel.*$/m, 'ax.set_xlabel("RH band"); ax.set_ylabel("RMSE")')); await storyboard.poll(); }""")
    page.wait_for_timeout(1500)
    check("code clash: banner, nothing written until you choose", page.is_visible("#c-conflict") and 'RH band' in ev("() => T.read('sample/code/figures/calibration_error.py')"))
    page.click("#cc-mine"); page.wait_for_timeout(1000)
    check("code clash: Keep mine writes yours and backs up Claude's", 'Humidity (%)' in ev("() => T.read('sample/code/figures/calibration_error.py')") and any("calibration_error.py (Claude's version)" in x for x in ev("() => T.ls('sample/Backups/Conflicts')")))
    page.keyboard.press("Escape")
    # experiments
    page.click("#fit"); page.wait_for_timeout(300); page.click('.card[data-key="b-exp1"]'); page.wait_for_selector("#f-title"); page.click('[data-tab="type"]'); page.wait_for_timeout(1200)
    check("Experiment tab: fields, outcome and the last run", ev("() => document.getElementById('tf-outcome').value") == "inconclusive" and "2026-10-12-a · last run" in page.inner_text("#t-runs") and '"run_id": "2026-10-12-a"' in page.inner_text("#t-run"), page.inner_text("#t-runs")[:300])
    page.screenshot(path=str(SHOTS / "11-experiment-tab-light.png"))
    page.click('[data-tab="code"]'); page.wait_for_timeout(600)
    opts = ev("() => [...document.querySelectorAll('#c-file option')].map(o => o.value)")
    check("Experiment Code tab lists the folder's files", "code/experiments/calibration/run.py" in opts and "code/experiments/calibration/config.yaml" in opts, opts)
    page.keyboard.press("Escape")
    # images in Markdown, and dependencies by hand
    page.click('.card[data-key="b-res1"]'); page.wait_for_selector("#f-title"); page.click('[data-tab="beat"]'); page.click('[data-view="split"]'); page.wait_for_timeout(800)
    check("Preview shows an image from figures/ referenced as ../figures/…", ev("() => { const i = document.querySelector('#f-prev img'); return !!i && i.src.startsWith('blob:') && i.naturalWidth > 100; }"))
    page.screenshot(path=str(SHOTS / "12-preview-image-light.png"))
    page.select_option("#f-adddep", "b-ref1"); page.wait_for_timeout(900)
    check("adding a dependency in the editor draws an arrow in board.json", any(l["from"] == "b-ref1" and l["to"] == "b-res1" for l in json.loads(ev("() => T.read('sample/board.json')"))["links"]))
    page.click('[data-view="write"]'); page.keyboard.press("Escape")
    # a new beat in the Figures stream is a Figure with empty figure fields
    page.mouse.click(700, 760, button="right")
    lane_y = ev("() => { const v = storyboard.state().view; return v.y + (110 + 2 * 240 + 120) * v.s; }")
    page.keyboard.press("Escape"); page.mouse.click(1000, lane_y, button="right"); page.click('#ctx [data-a="beat"]'); page.wait_for_selector("#f-title"); page.wait_for_timeout(700)
    nf = [b for b in ev("() => storyboard.state().beats") if b["title"] == "New beat"]
    check("New beat in the Figures stream starts as a Figure with its fields", nf and "Type: Figure\nStatus:\nScript:\nOutput:\nData:\nCaption:\nSynopsis:" in nf[0]["text"], nf[0]["text"][:120] if nf else ev("() => storyboard.state().beats.map(b => b.title)"))
    page.fill("#f-title", "Figure 2 map"); page.keyboard.press("Enter"); page.wait_for_timeout(800); page.keyboard.press("Escape")

    # ---------- 11. menus, panels, new beat ----------
    page.click("#fit"); page.wait_for_timeout(200)
    page.mouse.click(700, 760, button="right")
    check("right-click on the board offers New beat here", page.is_visible('#ctx [data-a="beat"]'))
    page.click('#ctx [data-a="beat"]'); page.wait_for_selector("#f-title"); page.wait_for_timeout(800)
    nb = [b for b in ev("() => storyboard.state().beats") if b["title"] == "New beat"]
    check("New beat creates the empty template file", nb and nb[0]["text"] == f"ID: {nb[0]['key']}\nType: Paragraph\nStatus:\nSynopsis:\n\nClaude adjust:\n\n---\n\n" and "New beat.md" in ev("() => T.ls('sample/Beats')"), nb)
    page.fill("#f-title", "Data availability"); page.keyboard.press("Enter"); page.select_option("#f-type", "Note"); page.wait_for_timeout(1200)
    check("type picker writes the Type line", "Type: Note\n" in ev("() => T.read('sample/Beats/Data availability.md')"))
    # typing straight through several saves: the file must end up exactly as the editor
    page.click('[data-tab="beat"]'); page.focus("#f-text")
    for i in range(6): page.keyboard.type(f"Sentence {i} about data access and licences. ", delay=8); page.wait_for_timeout(150)
    page.wait_for_timeout(1500)
    body_ed = ev("() => document.getElementById('f-text').value")
    check("typing through several saves: file matches the editor exactly", ev("() => T.read('sample/Beats/Data availability.md')").endswith("---\n\n" + body_ed.strip() + "\n"), body_ed[-80:])
    page.keyboard.press("Escape")
    page.click('.card[data-key="b-intro1"]', button="right")
    check("right-click on a card offers Open, arrow, tags, delete", all(page.is_visible(f'#ctx [data-a="{a}"]') for a in ["open", "arrow", "del"]) and page.is_visible("#ctx .tg"))
    page.click('#ctx .tg[data-tag="done"]')
    def wait_board(js_cond, ms=6000):   # board.json is saved half a second after a change
        for _ in range(ms // 250):
            if ev("async () => { const b = JSON.parse(await T.read('sample/board.json')); return !!(" + js_cond + "); }"): return
            page.wait_for_timeout(250)
    wait_board("b.beats['b-intro1'].tags.includes('done')")
    check("tag from the menu saved in board.json", "done" in json.loads(ev("() => T.read('sample/board.json')"))["beats"]["b-intro1"]["tags"])
    page.click("#order"); check("Order panel lists sections in order", page.inner_text("#panel").index("Introduction") < page.inner_text("#panel").index("Results"))
    page.click("#settings"); page.click("#addlane"); wait_board("b.lanes[b.lanes.length - 1].name === 'New stream'")
    check("Settings adds a stream", json.loads(ev("() => T.read('sample/board.json')"))["lanes"][-1]["name"] == "New stream")
    page.keyboard.press("Escape")
    page.click("#restore"); page.click("#r-all"); page.wait_for_timeout(1200)
    check("Restore all brings every marked beat back", not page.is_visible("#restore") and "TO DELETE" not in " ".join(ev("() => T.ls('sample/Beats')")), ev("() => T.ls('sample/Beats')"))
    page.keyboard.press("Escape")
    # ---------- 13. Overleaf: export/overleaf is the git copy; edits there come back into the beats ----------
    page.click("#olbtn"); page.wait_for_selector("#x-ol")
    page.wait_for_function("() => /Not linked/.test(document.getElementById('x-ol').textContent)")
    page.click("#x-olsetup"); page.wait_for_timeout(500)
    script = ev("() => T.read('sample/Sync with Overleaf.command')")
    check("Set up writes the sync script into the project folder", script.startswith("#!/bin/bash") and "security find-generic-password" in script and page.is_visible("#x-olhow"))
    check("…with the one-time command that lets macOS run it", page.inner_text("#x-olcmd") == 'xattr -c "Sync with Overleaf.command"; chmod +x "Sync with Overleaf.command"')
    page.keyboard.press("Escape")
    # what the script's first run leaves: a git checkout of a fresh Overleaf project
    ev("""async () => { await T.write('sample/export/overleaf/.git/HEAD', 'ref: refs/heads/master\\n'); await T.write('sample/export/overleaf/main.tex', '\\\\documentclass{article}\\n\\\\begin{document}\\nOverleaf starter\\n\\\\end{document}\\n'); }""")
    def wait_file(path, cond_js, ms=15000):
        for _ in range(ms // 300):
            if ev("async () => { try { const t = await T.read('" + path + "'); return !!(" + cond_js + "); } catch (e) { return false; } }"): return True
            page.wait_for_timeout(300)
        return False
    ok = wait_file("sample/export/overleaf/main.tex", "t.includes('PAPERBOARD BODY START')")
    check("linking: the paper replaces Overleaf's starter file, which is kept in Backups", ok and any("overleaf-original-main.tex" in x for x in ev("() => T.ls('sample/Backups/Overleaf')")))
    ol = ev("() => T.ls('sample/export/overleaf')")
    check("linking: template files, references.bib and figures go into export/overleaf", all(x in ol for x in ["references.bib", "figures/"]) and "calibration_error.pdf" in ev("() => T.ls('sample/export/overleaf/figures')"), ol)
    # a co-author edits in Overleaf; the script pulls it in (clean merge)
    ev("""async () => {
      const p = 'sample/export/overleaf/main.tex'; let t = await T.read(p);
      t = t.replace('regulatory monitors per city', 'regulatory monitors per city (often fewer than ten)').replace('\\\\usepackage{amsmath}', '\\\\usepackage{amsmath}\\n\\\\usepackage{xcolor}');
      await T.write(p, t);
      const b = 'sample/export/overleaf/references.bib'; await T.write(b, (await T.read(b)) + '\\n@misc{newkey2026, title = {Added in Overleaf}, year = {2026}}\\n'); }""")
    ok = False
    for _ in range(40):
        body = [x for x in ev("() => storyboard.state().beats") if x["key"] == "b-intro1"][0]["text"]
        if "often fewer than ten" in body: ok = True; break
        page.wait_for_timeout(300)
    check("an edit made in Overleaf comes back into its beat, as Markdown", ok and "(often fewer than ten) [@epa2023]" in body, body[-400:])
    page.wait_for_timeout(1500)
    check("…and is saved to the beat file", "(often fewer than ten) [@epa2023]" in ev("() => T.read('sample/Beats/Opening problem statement.md')"))
    check("…and the card is highlighted", "b-intro1" in ev("() => storyboard.state().hl"))
    check("a preamble edit in Overleaf goes into export/template/main.tex", "\\usepackage{xcolor}" in ev("() => T.read('sample/export/template/main.tex')"))
    check("a reference added in Overleaf goes into References/references.bib", "newkey2026" in ev("() => T.read('sample/References/references.bib')"))
    # a clash: the script sets the three versions aside and takes Overleaf's; Paperboard asks
    ev("""async () => {
      const sent = await T.read('sample/export/.overleaf-sent/main.tex');
      const theirs = sent.replace('Third, the dataset and code, released openly.', 'Third, the dataset, released under CC-BY.');
      await T.write('sample/Beats/Contributions.md', (await T.read('sample/Beats/Contributions.md')).replace('Third, the dataset and code, released openly.', 'Third, our dataset and code, released openly on Zenodo.'));
      await storyboard.poll(); await new Promise(r => setTimeout(r, 1500));
      const d = 'sample/export/overleaf-merge/2026-10-23-120000/';
      await T.write(d + 'base-main.tex', sent); await T.write(d + 'ours-main.tex', sent); await T.write(d + 'theirs-main.tex', theirs);
      await T.write('sample/export/overleaf/main.tex', theirs); }""")
    ok = False
    for _ in range(40):
        if "b-intro2" in ev("() => storyboard.state().conflicts"): ok = True; break
        page.wait_for_timeout(300)
    check("a clash with Overleaf shows Needs your choice on that beat", ok and "conflict" in (page.get_attribute('.card[data-key="b-intro2"]', "class") or ""))
    page.click('.card[data-key="b-intro2"]'); page.wait_for_selector(".panel.conflictp")
    check("the clash view names Overleaf", "you and overleaf changed the same lines" in page.inner_text("#panel").lower() and page.inner_text("#cf-theirs") == "Keep Overleaf's", page.inner_text("#panel")[:200])
    page.click("#cf-theirs"); page.wait_for_timeout(1500)
    check("Keep Overleaf's writes Overleaf's text into the beat", "released under CC-BY" in ev("() => T.read('sample/Beats/Contributions.md')"))
    page.keyboard.press("Escape")
    page.wait_for_timeout(4500)
    check("the next sync sends the merged paper back to export/overleaf", "released under CC-BY" in ev("() => T.read('sample/export/overleaf/main.tex')"))
    # an edit to a figure float in Overleaf is kept in the beat's notes, not applied
    ev("""async () => { const p = 'sample/export/overleaf/main.tex'; await T.write(p, (await T.read(p)).replace('[width=\\\\linewidth]{figures/calibration_error.pdf}', '[width=0.8\\\\linewidth]{figures/calibration_error.pdf}')); }""")
    ok = wait_file("sample/Beats/Figure 1 calibration error.md", "t.includes('Overleaf edit') && t.includes('0.8')")
    check("a figure edited in Overleaf: its LaTeX goes into the beat's Notes", ok)

    check("no script errors", not errors, errors)

    # ---------- dark screenshots ----------
    check("Markdown library loaded (pinned marked@12.0.2)", ev("() => !!window.marked && typeof marked.parse === 'function'"))
    page.emulate_media(color_scheme="dark"); page.reload(); page.evaluate(FS_JS)
    ev("async () => storyboard.openFolder(await T.dir('sample'))"); page.wait_for_selector(".card"); page.wait_for_timeout(500)
    page.click("#fit"); page.wait_for_timeout(300); page.screenshot(path=str(SHOTS / "5-board-dark.png"))
    page.click('.card[data-key="b-intro2"]'); page.wait_for_selector("#f-title"); page.click('[data-tab="beat"]'); page.wait_for_timeout(300)
    page.screenshot(path=str(SHOTS / "6-editor-dark.png"))
    page.keyboard.press("Escape"); page.click('.card[data-key="b-fig1"]'); page.wait_for_selector("#f-title"); page.click('[data-tab="type"]'); page.wait_for_timeout(800)
    page.screenshot(path=str(SHOTS / "13-figure-tab-dark.png"))
    page.click('[data-tab="code"]'); page.wait_for_timeout(600); page.screenshot(path=str(SHOTS / "14-code-tab-dark.png"))
    page.keyboard.press("Escape")
    page.set_viewport_size({"width": 390, "height": 844}); page.emulate_media(color_scheme="light"); page.wait_for_timeout(300)
    page.click("#fit"); page.wait_for_timeout(300); page.screenshot(path=str(SHOTS / "7-board-narrow.png"))
    page.set_viewport_size({"width": 1440, "height": 900})
    # the fallback renderer, as if the CDN were down
    ctx.unroute("**/marked.min.js"); ctx.route("**/marked.min.js", lambda r: r.abort())
    page.reload(); page.evaluate(FS_JS); ev("async () => storyboard.openFolder(await T.dir('sample'))"); page.wait_for_selector(".card")
    page.click('.card[data-key="b-res1"]'); page.wait_for_selector("#f-title"); page.click('[data-size="half"]'); page.click('[data-view="preview"]'); page.wait_for_timeout(300)
    check("without the CDN the fallback renderer previews safely", not ev("() => !!window.marked") and ev("() => document.getElementById('f-prev').innerHTML.includes('&lt;img') && !window.__pwned"), ev("() => document.getElementById('f-prev').innerHTML.slice(0, 300)"))
    page.click('[data-view="write"]'); page.keyboard.press("Escape")
    errors[:] = [e for e in errors if "ERR_FAILED" not in e and "net::" not in e]
    check("no script errors after the CDN test", not errors, errors)
    # copy the final project out for inspection
    final = ev("""async () => { const out = {}; async function walk(d, pre) { for await (const [n, h] of d.entries()) { try { if (h.kind === 'file') out[pre + n] = await (await h.getFile()).text(); else await walk(h, pre + n + '/'); } catch (e) {} } } await walk(await T.dir('sample'), ''); return out; }""")
    for k, v in final.items():
        f = SHOTS / "project" / k; f.parent.mkdir(parents=True, exist_ok=True); f.write_text(v)
    browser.close()

passed = sum(ok for _, ok in results); print(f"\n{passed}/{len(results)} browser checks passed")
sys.exit(0 if passed == len(results) else 1)
