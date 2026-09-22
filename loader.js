// Workshop Scene Loader — an Owlbear Rodeo extension (panel).
// Turns "War Table" scene text (positions in grid squares) into Owlbear items, and back,
// and gives the GM control over what players can see: exact HP, revealed condition, hidden pieces.
import OBR from "./obr-sdk.js?v=22";
import { OBJ, CHILD, SCENE, HP_VIS, DEFAULT_CONDITIONS, normKey, sortConditions, detectCondition, hpVisibleTo } from "./common.js?v=22";
import {
  room, loadRoom, saveRoom, conditions, CREATURE, pieceKey, buildPiece, canBeDead, itemToObj,
  setPiece, syncDecor, setHidden, rebuildPiece as rebuildRaw, pickFromSelection, linkImage, applyImage,
} from "./pieces.js?v=22";
const $ = (id) => document.getElementById(id);
// Rebuilding gives a piece a new id; keep its card open.
async function rebuildPiece(id, patch) { const nid = await rebuildRaw(id, patch); if (nid && openIds.has(id)) { openIds.delete(id); openIds.add(nid); } return nid; }

// Messages show as an Owlbear pop-up (always visible) and at the bottom of the panel.
function say(t, variant) {
  if (!t) return;
  $("msg").textContent = t; clearTimeout(say.t); say.t = setTimeout(() => ($("msg").textContent = ""), 6000);
  try { OBR.notification.show(t, variant || "DEFAULT"); } catch (e) {}
}
const why = (e) => (e && (e.message || e.error?.message || (typeof e === "string" ? e : ""))) || "unknown error";
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v); } e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return e; };


async function buildScene(scene) {
  if (!scene || !Array.isArray(scene.objects)) throw new Error("That text isn't a scene. It needs an \"objects\" list.");
  const dpi = await OBR.scene.grid.getDpi();
  let ox = +$("offX").value || 0, oy = +$("offY").value || 0;
  if ($("atCentre").checked) {
    const c = await screenCentre();
    ox = Math.round(c.x / dpi - (scene.cols || 10) / 2);
    oy = Math.round(c.y / dpi - (scene.rows || 10) / 2);
  }
  const items = [];
  for (const o of scene.objects) items.push(...buildPiece(o, dpi, ox, oy));
  await OBR.scene.items.addItems(items);
  await OBR.scene.setMetadata({ [SCENE]: { name: scene.name || "", round: scene.round || 1, status: scene.status || "", cols: scene.cols, rows: scene.rows, ox, oy } });
  return scene.objects.length;
}

/* ---------- Moving the whole loaded map ---------- */
async function screenCentre() {
  const w = await OBR.viewport.getWidth(), h = await OBR.viewport.getHeight();
  return OBR.viewport.inverseTransformPoint({ x: w / 2, y: h / 2 });
}
async function moveAll(dxCells, dyCells) {
  const dpi = await OBR.scene.grid.getDpi();
  const dx = Math.round(dxCells) * dpi, dy = Math.round(dyCells) * dpi;
  if (!dx && !dy) return;
  const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ]);
  if (!mains.length) { say("There's no loaded map to move."); return; }
  const kids = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[CHILD]);
  const probe = kids[0] && { id: kids[0].id, x: kids[0].position.x, y: kids[0].position.y };
  await OBR.scene.items.updateItems(mains.map((i) => i.id), (ds) => { for (const d of ds) { d.position.x += dx; d.position.y += dy; } });
  if (probe) {
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await OBR.scene.items.getItems([probe.id]);
    if (after && after.position.x === probe.x && after.position.y === probe.y) {
      await OBR.scene.items.updateItems(kids.map((i) => i.id), (ds) => { for (const d of ds) { d.position.x += dx; d.position.y += dy; } });
    }
  }
  const meta = (await OBR.scene.getMetadata())[SCENE] || {};
  await OBR.scene.setMetadata({ [SCENE]: { ...meta, ox: (meta.ox || 0) + Math.round(dxCells), oy: (meta.oy || 0) + Math.round(dyCells) } });
}
async function sceneOrigin() {
  const meta = (await OBR.scene.getMetadata())[SCENE] || {};
  return { ox: meta.ox || 0, oy: meta.oy || 0, cols: meta.cols || 10, rows: meta.rows || 10 };
}

async function exportScene() {
  const dpi = await OBR.scene.grid.getDpi();
  const meta = (await OBR.scene.getMetadata())[SCENE] || {};
  const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ]);
  const objects = mains.map((it) => {
    const o = itemToObj(it, dpi, meta.ox || 0, meta.oy || 0);
    for (const k of Object.keys(o)) { const v = o[k]; if (v === null || v === "" || v === false || (Array.isArray(v) && !v.length)) delete o[k]; }
    if (o.hpVis === "gm") delete o.hpVis;
    if (o.maxHp) { const c = detectCondition(o, room.conditions); if (c) o.condition = c.name; }
    return o;
  });
  return { name: meta.name || "Owlbear board", cols: meta.cols, rows: meta.rows, round: meta.round || 1, status: meta.status || "", objects };
}

/* ---------- Piece list ---------- */
let isGM = false, me = { id: "", name: "", role: "PLAYER" }, party = [];
const openIds = new Set();
let selected = new Set();
let renderTimer = null, renderPending = false;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    const a = document.activeElement;
    if (a && $("pieces").contains(a) && (a.tagName === "INPUT" || a.tagName === "SELECT")) { renderPending = true; return; }
    render().catch((e) => console.warn("[Workshop]", e));
  }, 120);
}

async function render() {
  renderPending = false;
  if (!(await OBR.scene.isReady())) { $("pieces").textContent = ""; $("noPieces").hidden = false; $("noPieces").textContent = "Open a scene to see its pieces."; return; }
  const showAll = isGM && $("showAll").checked;
  const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ]);
  const list = mains.filter((it) => {
    const m = it.metadata[OBJ];
    if (!isGM && !it.visible) return false;
    return showAll || CREATURE(m);
  });
  const ul = $("pieces"); ul.textContent = "";
  $("noPieces").hidden = list.length > 0;
  $("noPieces").textContent = "Nothing loaded yet.";
  for (const it of list) ul.append(isGM ? gmCard(it) : playerCard(it));
}

function subLine(m, it) {
  const parts = [];
  if (m.maxHp && hpVisibleTo(m, me)) parts.push(`${m.hp ?? m.maxHp} / ${m.maxHp} HP`);
  const s = el("span", { class: "sub" }, parts.join(" "));
  if (m.shown) s.append(el("span", { class: "badge shown", title: "Players see this condition" }, m.shown));
  if (isGM && !it.visible) s.append(el("span", { class: "badge hid" }, "Hidden"));
  if (m.dead) s.append(el("span", { class: "badge" }, "Dead"));
  if (isGM && m.img) s.append(el("span", { class: "badge" }, "Image"));
  return s;
}

function playerCard(it) {
  const m = it.metadata[OBJ];
  const li = el("li", { class: "piece" + (m.dead ? " dead" : "") });
  li.append(el("div", { class: "head" }, el("div", { class: "open" }, el("span", { class: "nm" }, m.label || m.type), subLine(m, it))));
  return li;
}

function gmCard(it) {
  const m = it.metadata[OBJ];
  const id = it.id, open = openIds.has(id);
  const li = el("li", { class: "piece" + (m.dead ? " dead" : "") + (selected.has(id) ? " sel" : ""), "data-id": id });
  const toggle = el("button", { class: "open", "aria-expanded": String(open), onclick: () => { open ? openIds.delete(id) : openIds.add(id); scheduleRender(); } },
    el("span", { class: "nm" }, (open ? "▾ " : "▸ ") + (m.label || m.type)), subLine(m, it));
  const eye = el("button", { class: "small" + (it.visible ? "" : " on"), title: it.visible ? "Hide this piece from players" : "Show this piece to players",
    onclick: async () => { await setHidden(id, it.visible); say(it.visible ? `${m.label || m.type} is now hidden from players.` : `${m.label || m.type} is now visible to players.`); } },
    it.visible ? "Hide" : "Reveal");
  li.append(el("div", { class: "head" }, toggle, eye));
  if (open) li.append(detail(it));
  return li;
}

function detail(it) {
  const m = it.metadata[OBJ], id = it.id, name = m.label || m.type;
  const box = el("div", { class: "detail" });

  // HP
  if (m.maxHp) {
    const hpIn = el("input", { type: "number", value: m.hp ?? m.maxHp, "aria-label": "Current HP for " + name });
    hpIn.onchange = () => setPiece(id, { hp: hpIn.value === "" ? null : +hpIn.value });
    const maxIn = el("input", { type: "number", value: m.maxHp, "aria-label": "Max HP for " + name });
    maxIn.onchange = () => setPiece(id, { maxHp: Math.max(1, +maxIn.value || 1) });
    const amt = el("input", { type: "number", value: "", placeholder: "amt", "aria-label": "Amount of damage or healing" });
    const apply = (sign) => { const n = Math.abs(+amt.value || 0); if (!n) return; const cur = m.hp ?? m.maxHp; setPiece(id, { hp: Math.min(m.maxHp, cur + sign * n) }); };
    box.append(el("div", {}, el("div", { class: "lbl" }, "HP"),
      el("div", { class: "row" }, hpIn, el("span", { class: "muted" }, "/"), maxIn, amt,
        el("button", { class: "small", onclick: () => apply(-1) }, "Damage"), el("button", { class: "small", onclick: () => apply(1) }, "Heal"))));

    // Who can see the exact HP
    const vis = m.hpVis || "gm";
    const seg = el("div", { class: "seg", role: "group", "aria-label": "Who can see the exact HP" },
      ...Object.entries(HP_VIS).map(([k, t]) => el("button", { class: "small" + (vis === k ? " on" : ""), "aria-pressed": String(vis === k), onclick: () => setPiece(id, { hpVis: k }) }, t)));
    const visBox = el("div", {}, el("div", { class: "lbl" }, "Exact HP visible to"), seg);
    if (vis === "some") {
      const chosen = m.hpPlayers || [];
      const known = new Map();
      for (const p of party) if (p.role !== "GM") known.set(p.id, { id: p.id, name: p.name });
      for (const p of chosen) if (!known.has(p.id)) known.set(p.id, p);
      const pl = el("div", { class: "players", style: "margin-top:5px" });
      if (!known.size) pl.append(el("span", { class: "muted" }, "No players are in the room right now. Players appear here once they join."));
      for (const p of known.values()) {
        const on = chosen.some((c) => c.id === p.id || c.name === p.name);
        const cb = el("input", { type: "checkbox" }); cb.checked = on;
        cb.onchange = () => setPiece(id, { hpPlayers: cb.checked ? [...chosen.filter((c) => c.id !== p.id), p] : chosen.filter((c) => c.id !== p.id && c.name !== p.name) });
        pl.append(el("label", {}, cb, p.name + (party.some((x) => x.id === p.id) ? "" : " (offline)")));
      }
      visBox.append(pl);
    }
    box.append(visBox);

    // Conditions
    const now = detectCondition(m, room.conditions);
    const chips = el("div", { class: "chips" });
    for (const c of conditions()) {
      const isNow = now && now.name === c.name, isShown = m.shown === c.name;
      chips.append(el("button", { class: "chip" + (isNow ? " now" : "") + (isShown ? " shown" : ""), "aria-pressed": String(isShown),
        title: (isNow ? "Matches the current HP. " : "") + (isShown ? "Players see this. Click to hide it." : "Click to show this to players."),
        onclick: () => setPiece(id, { shown: isShown ? "" : c.name }) }, c.name));
    }
    const custom = el("input", { type: "text", placeholder: "Or describe it your way…", "aria-label": "Custom condition text" });
    if (m.shown && !conditions().some((c) => c.name === m.shown)) custom.value = m.shown;
    const showCustom = el("button", { class: "small", onclick: () => setPiece(id, { shown: custom.value.trim() }) }, "Show");
    custom.onkeydown = (e) => { if (e.key === "Enter") showCustom.click(); };
    const status = el("div", { class: "note" }, m.shown ? `Players see: “${m.shown}”` : "Players see no condition.",
      now && m.shown && m.shown !== now.name ? ` Current HP says ${now.name}.` : "");
    const clear = m.shown ? el("button", { class: "small", onclick: () => setPiece(id, { shown: "" }) }, "Hide condition") : null;
    box.append(el("div", {}, el("div", { class: "lbl" }, "Condition (glowing = matches HP)"), chips,
      el("div", { class: "row", style: "margin-top:5px" }, custom, showCustom), el("div", { class: "row", style: "margin-top:4px" }, status, clear)));
  }

  // Visibility and dead
  const row = el("div", { class: "row" },
    el("button", { class: "small", onclick: () => setHidden(id, it.visible) }, it.visible ? "Hide from players" : "Reveal to players"));
  if (canBeDead(m.type)) row.append(el("button", { class: "small", onclick: () => setPiece(id, { dead: !m.dead }) }, m.dead ? "Revive" : "Mark dead"));
  box.append(el("div", {}, el("div", { class: "lbl" }, "On the map"), row));
  if (!m.maxHp && canBeDead(m.type)) {
    const maxIn = el("input", { type: "number", min: "1", placeholder: "max", "aria-label": "Max HP to track for " + name });
    box.append(el("div", {}, el("div", { class: "lbl" }, "Track HP"), el("div", { class: "row" }, maxIn,
      el("button", { class: "small", onclick: () => { const n = Math.round(+maxIn.value); if (n > 0) setPiece(id, { maxHp: n, hp: n, hpVis: m.hpVis || room.defaultHpVis || "gm" }); } }, "Start tracking"))));
  }

  // Image
  if (m.type !== "text") {
    const cur = m.imgData || (m.img && room.images[m.img]);
    const key = pieceKey(m, id);
    const imgRow = el("div", { class: "row" });
    if (cur) imgRow.append(el("img", { class: "thumb", src: cur.url, alt: "" }));
    imgRow.append(el("button", { class: "small", title: "Click an image on the map first, then press this",
      onclick: async () => {
        try {
          const img = await pickFromSelection();
          if (!img) { say("Click an image on the map first, then press this. (Or right-click the image → What should use this image?)", "WARNING"); return; }
          const n = m.label ? await linkImage(m.label, img) : (await applyImage([id], img, true)).length;
          say(`Done. ${n} piece${n === 1 ? "" : "s"} now use the image.`, "SUCCESS");
        } catch (e) { console.error("[Workshop] link:", e); say("Couldn't use the image: " + why(e), "ERROR"); }
      } }, cur ? "Replace with selected" : "Use selected image"));
    if (cur) imgRow.append(el("button", { class: "small", onclick: async () => { await rebuildPiece(id, { img: null, imgData: null, noImg: true }); say("Back to the drawn piece. The link stays in Linked images."); } }, "Remove"));
    else if (m.noImg && room.images[key]) imgRow.append(el("button", { class: "small", onclick: async () => { await rebuildPiece(id, { img: key, imgData: null, noImg: false }); } }, "Use linked image"));
    box.append(el("div", {}, el("div", { class: "lbl" }, "Image" + (m.label ? ` (for everything named “${m.label}”)` : "")), imgRow));
  }
  return box;
}

/* ---------- Linked-image library and settings ---------- */
function renderLib() {
  const ul = $("lib"); ul.textContent = "";
  const entries = Object.entries(room.images || {});
  $("noLib").hidden = entries.length > 0;
  for (const [k, v] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    ul.append(el("li", {}, el("img", { class: "thumb", src: v.url, alt: "" }), el("span", {}, v.name || k),
      el("button", { class: "small danger", onclick: async () => { const next = { ...room.images }; delete next[k]; await saveRoom({ images: next }); say(`Unlinked “${v.name || k}”. Pieces already on the map keep their image until you press Remove on them.`); } }, "Unlink")));
  }
}
function condText(list) { return sortConditions(list).map((c) => `${c.name} = ${c.min}`).join("\n"); }
function renderSettings() {
  $("defVis").value = room.defaultHpVis || "gm";
  if (document.activeElement !== $("condIn")) $("condIn").value = condText(room.conditions);
}

/* ---------- Wiring ---------- */
OBR.onReady(async () => {
  me = { id: await OBR.player.getId(), name: await OBR.player.getName(), role: await OBR.player.getRole() };
  isGM = me.role === "GM";
  for (const s of document.querySelectorAll(".gm")) s.hidden = !isGM;
  await loadRoom();
  renderLib(); renderSettings();
  try { party = await OBR.party.getPlayers(); } catch (e) { party = []; }
  OBR.party.onChange((p) => { party = p; scheduleRender(); });
  OBR.room.onMetadataChange(async () => { await loadRoom(); renderLib(); renderSettings(); scheduleRender(); });
  OBR.player.onChange((p) => {
    const roleChanged = p.role !== me.role;
    me = { id: p.id, name: p.name, role: p.role };
    if (roleChanged) { isGM = p.role === "GM"; for (const s of document.querySelectorAll(".gm")) s.hidden = !isGM; }
    const sel = new Set(p.selection || []);
    if (roleChanged || [...sel].join() !== [...selected].join()) {
      selected = sel;
      if (isGM && sel.size === 1) {
        OBR.scene.items.getItems([...sel]).then((its) => {
          const it = its[0]; if (!it) return;
          const target = it.metadata[OBJ] ? it.id : it.metadata[CHILD];
          if (target) { openIds.add(target); selected = new Set([target]); scheduleRender(); setTimeout(() => document.querySelector(`[data-id="${target}"]`)?.scrollIntoView({ block: "nearest" }), 250); }
        }).catch(() => {});
      }
      scheduleRender();
    }
  });
  document.addEventListener("focusout", () => { if (renderPending) setTimeout(() => { if (renderPending) scheduleRender(); }, 50); });
  if (await OBR.scene.isReady()) scheduleRender();
  OBR.scene.onReadyChange(() => scheduleRender());
  OBR.scene.items.onChange(() => scheduleRender());
  $("showAll").onchange = () => scheduleRender();

  $("buildBtn").onclick = async () => {
    let scene;
    try { scene = JSON.parse($("sceneIn").value); } catch (e) { say("That text isn't valid scene text. Copy the whole block Claude gave you, including the first { and last }."); return; }
    try { const n = await buildScene(scene); say(`Built ${n} pieces.`); $("buildSec").open = false; }
    catch (e) { say(e.message || "Couldn't build the scene. Is a scene open in this room?"); }
  };
  const step = () => Math.max(1, Math.round(+$("mvStep").value || 1));
  $("mvLeft").onclick = () => moveAll(-step(), 0);
  $("mvRight").onclick = () => moveAll(step(), 0);
  $("mvUp").onclick = () => moveAll(0, -step());
  $("mvDown").onclick = () => moveAll(0, step());
  $("mvCentre").onclick = async () => {
    const dpi = await OBR.scene.grid.getDpi();
    const c = await screenCentre(), o = await sceneOrigin();
    await moveAll(Math.round(c.x / dpi - o.cols / 2) - o.ox, Math.round(c.y / dpi - o.rows / 2) - o.oy);
    say("Map moved to the middle of your screen.");
  };
  $("mvToSel").onclick = async () => {
    const sel = await OBR.player.getSelection();
    if (!sel || !sel.length) { say("Click a piece on the map first, then press this button."); return; }
    const dpi = await OBR.scene.grid.getDpi();
    const b = await OBR.scene.items.getItemBounds(sel);
    const o = await sceneOrigin();
    await moveAll(Math.round(b.min.x / dpi) - o.ox, Math.round(b.min.y / dpi) - o.oy);
    say("Map's top-left moved to the selected item.");
  };
  $("exampleBtn").onclick = async () => {
    try { const r = await fetch("example-return-ledge.json"); $("sceneIn").value = await r.text(); say("Example loaded. Press Build on map."); }
    catch (e) { say("Couldn't load the example file."); }
  };
  $("clearBtn").onclick = async () => {
    const mine = await OBR.scene.items.getItems((i) => i.metadata && (i.metadata[OBJ] || i.metadata[CHILD]));
    if (!mine.length) { say("There are no loaded pieces to remove."); return; }
    await OBR.scene.items.deleteItems(mine.map((i) => i.id));
    say(`Removed ${mine.length} items.`);
  };
  $("exportBtn").onclick = async () => {
    try {
      const scene = await exportScene();
      const out = $("exportOut"); out.hidden = false; out.value = JSON.stringify(scene);
      $("copyBtn").hidden = false; say("Board exported. Copy it and paste it to Claude.");
    } catch (e) { say("Couldn't read the board. Is a scene open?"); }
  };
  $("copyBtn").onclick = async () => {
    try { await navigator.clipboard.writeText($("exportOut").value); say("Copied."); }
    catch (e) { $("exportOut").select(); say("Press Ctrl+C to copy the selected text."); }
  };

  // Linked images
  // The name is optional when picking from Owlbear images: the image's own name is used instead.
  const libLink = async (getter, emptyMsg) => {
    let img;
    try { img = await getter(); } catch (e) { console.error("[Workshop] image picker:", e); say("Couldn't get the image: " + why(e), "ERROR"); return; }
    if (!img) { if (emptyMsg) say(emptyMsg, "WARNING"); return; }
    const name = $("libName").value.trim();
    if (!name) { say("Type the name to link this image to (for example Mei), then try again.", "WARNING"); $("libName").focus(); return; }
    try {
      const n = await linkImage(name, img);
      $("libName").value = "";
      say(`Linked “${name}”.` + (n ? ` ${n} piece${n === 1 ? "" : "s"} on the map now use it.` : " It will be used the next time a piece with that name is built."), "SUCCESS");
    } catch (e) { console.error("[Workshop] link:", e); say("Couldn't save the link: " + why(e), "ERROR"); }
  };
  $("libSel").onclick = () => libLink(pickFromSelection, "Select an image on the map first (click it), then press this.");

  // Settings
  $("defVis").onchange = () => saveRoom({ defaultHpVis: $("defVis").value });
  $("applyVis").onclick = async () => {
    const v = $("defVis").value;
    const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && i.metadata[OBJ].maxHp);
    await OBR.scene.items.updateItems(mains.map((i) => i.id), (ds) => { for (const d of ds) d.metadata[OBJ] = { ...d.metadata[OBJ], hpVis: v }; });
    say(`Exact HP is now “${HP_VIS[v]}” on ${mains.length} piece${mains.length === 1 ? "" : "s"}.`);
  };
  $("condSave").onclick = async () => {
    const list = [];
    for (const line of $("condIn").value.split("\n")) {
      const mm = line.match(/^\s*(.+?)\s*[=:]\s*(\d+(?:\.\d+)?)\s*%?\s*$/);
      if (mm) list.push({ name: mm[1], min: +mm[2] });
    }
    if (!list.length) { say("Write one condition per line, like: Bloodied = 30"); return; }
    await saveRoom({ conditions: sortConditions(list) });
    say(`Saved ${list.length} conditions.`);
  };
  $("condReset").onclick = async () => { await saveRoom({ conditions: null }); $("condIn").value = condText(DEFAULT_CONDITIONS); say("Conditions reset to the default list."); };

  // Older boards showed HP in the shared label; move them to the new labels once.
  if (isGM && await OBR.scene.isReady()) {
    try {
      const dpi = await OBR.scene.grid.getDpi();
      const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && i.metadata[OBJ].maxHp && !i.metadata[OBJ].hpVis);
      if (mains.length) {
        await OBR.scene.items.updateItems(mains.map((i) => i.id), (ds) => { for (const d of ds) d.metadata[OBJ] = { ...d.metadata[OBJ], hpVis: room.defaultHpVis || "gm", hpPlayers: [], shown: "" }; });
        const fresh = await OBR.scene.items.getItems(mains.map((i) => i.id));
        for (const it of fresh) await syncDecor(it, dpi);
      }
    } catch (e) { console.warn("[Workshop] upgrade:", e); }
  }
});
