// Workshop Scene Loader — an Owlbear Rodeo extension (panel).
// Turns "War Table" scene text (positions in grid squares) into Owlbear items, and back,
// and gives the GM control over what players can see: exact HP, revealed condition, hidden pieces.
import OBR, { buildShape, buildText, buildImage } from "./obr-sdk.js?v=20";
import {
  OBJ, CHILD, ROLE, SCENE, ROOM, HP_VIS, DEFAULT_CONDITIONS, LABEL_GAP, LABEL_SIZE,
  normKey, sortConditions, detectCondition, hpVisibleTo, sharedLabel, pieceBox,
} from "./common.js?v=20";

const COLORS = { bloom: "#5ca014", cyan: "#40d0e6", ember: "#f05050", brass: "#f0c83c", steel: "#8c90a0", white: "#f5f5f5", blue: "#5a96e6", violet: "#a070dc" };
const col = (c) => COLORS[c] || c || "#f5f5f5";
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "i" + Math.random().toString(36).slice(2));
function say(t) { $("msg").textContent = t; clearTimeout(say.t); say.t = setTimeout(() => ($("msg").textContent = ""), 6000); }
function seeded(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
const round = (v) => Math.round(v * 100) / 100;
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === "class") e.className = v; else if (k.startsWith("on")) e[k] = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v); } e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false)); return e; };

const META_FIELDS = ["id", "type", "label", "color", "hp", "maxHp", "dead", "notes", "w", "h", "hpVis", "hpPlayers", "shown", "img", "noImg"];
const NO_LABEL_IMAGE = ["text", "zone", "rect", "mat"];      // these never pick up an image just from their name
const CREATURE = (m) => m.maxHp || ["token", "bloom"].includes(m.type) || m.img;

/* ---------- Room settings (conditions, default HP visibility, image library) ---------- */
let room = { conditions: null, defaultHpVis: "gm", images: {} };
async function loadRoom() { const r = (await OBR.room.getMetadata())[ROOM] || {}; room = { conditions: r.conditions || null, defaultHpVis: r.defaultHpVis || "gm", images: r.images || {} }; }
async function saveRoom(patch) { room = { ...room, ...patch }; await OBR.room.setMetadata({ [ROOM]: room }); }
const conditions = () => sortConditions(room.conditions);

/* ---------- Scene -> items ---------- */
function libImage(o) {
  if (o.noImg) return null;
  const k = normKey(o.image || o.img || (NO_LABEL_IMAGE.includes(o.type) ? "" : o.label));
  return k && room.images[k] ? { key: k, ...room.images[k] } : null;
}

function buildPiece(o, dpi, ox, oy) {
  const items = [];
  const x = (o.x + ox) * dpi, y = (o.y + oy) * dpi;
  const w = (o.w || 1) * dpi, h = (o.h || 1) * dpi;
  const c = col(o.color);
  const im = o.type === "text" ? null : libImage(o);
  const m = {};
  for (const f of META_FIELDS) if (o[f] !== undefined) m[f] = o[f];
  Object.assign(m, { label: o.label || "", color: o.color || "", hp: o.hp ?? null, maxHp: o.maxHp ?? null, dead: !!o.dead, notes: o.notes || "", w: o.w || 1, h: o.h || 1,
    hpVis: o.hpVis || room.defaultHpVis || "gm", hpPlayers: o.hpPlayers || [], shown: o.shown || "", img: im ? im.key : null, noImg: !!o.noImg });
  const lw = Math.max(2, dpi * 0.05);
  const mainId = uid();
  const locked = o.locked ?? ["rect", "zone", "mat"].includes(o.type);
  const child = (b) => b.attachedTo(mainId).locked(true).disableHit(true).metadata({ [CHILD]: mainId });

  let main;
  if (im) {
    const fit = Math.max(im.width, im.height) / Math.max(o.w || 1, o.h || 1);
    main = buildImage({ url: im.url, mime: im.mime || "image/png", width: im.width, height: im.height }, { dpi: fit, offset: { x: im.width / 2, y: im.height / 2 } })
      .position({ x: x + w / 2, y: y + h / 2 }).layer(["token", "bloom"].includes(o.type) ? "CHARACTER" : "PROP");
  } else switch (o.type) {
    case "token":
      main = buildShape().id(mainId).shapeType("CIRCLE").width(w).height(h).position({ x: x + w / 2, y: y + h / 2 })
        .fillColor("#321c26").fillOpacity(1).strokeColor(c).strokeWidth(lw * 1.4).layer("CHARACTER");
      break;
    case "grenade":
      main = buildShape().id(mainId).shapeType("CIRCLE").width(w).height(h).position({ x: x + w / 2, y: y + h / 2 })
        .fillColor(o.dead ? "#1f2130" : c).fillOpacity(o.dead ? 0 : 0.8).strokeColor(o.dead ? "#8c90a0" : c).strokeWidth(lw).layer("PROP");
      break;
    case "zone":
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(c).fillOpacity(0).strokeColor(c).strokeWidth(lw).strokeDash([dpi * 0.2, dpi * 0.12]).layer("DRAWING");
      break;
    case "mat":
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(o.dead ? "#6e3737" : "#3c6e14").fillOpacity(0.25).strokeColor(o.dead ? "#6e3737" : "#3c6e14").strokeWidth(lw * 0.6).strokeDash([dpi * 0.08, dpi * 0.08]).layer("DRAWING");
      break;
    case "text":
      main = buildText().id(mainId).plainText(o.label || "Label").textType("PLAIN").width("AUTO").height("AUTO")
        .fontSize(dpi * 0.3).fontWeight(600).fillColor(c).position({ x, y }).layer("TEXT");
      break;
    case "shield": {
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor("#1f2130").fillOpacity(1).strokeColor(c).strokeWidth(lw).layer("PROP");
      const vertical = h >= w, cap = Math.min(w, h);
      const capA = vertical ? { x: x, y: y - dpi * 0.2 } : { x: x - dpi * 0.2, y: y };
      const capB = vertical ? { x: x, y: y + h + dpi * 0.02 } : { x: x + w + dpi * 0.02, y: y };
      for (const p of [capA, capB]) {
        items.push(child(buildShape().shapeType("RECTANGLE").width(vertical ? cap : dpi * 0.18).height(vertical ? dpi * 0.18 : cap).position(p)
          .fillColor("#f05050").fillOpacity(0).strokeColor("#f05050").strokeWidth(lw * 0.7).layer("PROP")).build());
      }
      break;
    }
    case "bloom": {
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(c).fillOpacity(0.08).strokeColor(c).strokeWidth(lw).layer("CHARACTER");
      const r = seeded(o.id);
      for (let i = 0; i < 4; i++) {
        const sw = (0.45 + r() * 0.45) * w, sh = (0.4 + r() * 0.45) * h;
        const px = x + r() * (w - sw) + (r() - 0.5) * dpi * 0.3, py = y + r() * (h - sh) + (r() - 0.5) * dpi * 0.3;
        items.push(child(buildShape().shapeType("RECTANGLE").width(sw).height(sh).position({ x: px, y: py })
          .fillColor(c).fillOpacity(0).strokeColor(c).strokeWidth(lw * 0.7).layer("CHARACTER")).build());
      }
      break;
    }
    default: // "rect" and anything unknown
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(c).fillOpacity(0).strokeColor(c).strokeWidth(lw * 1.2).layer("DRAWING");
  }
  main = main.id(mainId).name(o.label || o.type).locked(locked).metadata({ [OBJ]: m });
  if (o.rot) main = main.rotation(o.rot);
  if (o.hidden) main = main.visible(false);
  items.unshift(main.build());

  if (o.dead && canBeDead(o.type)) items.push(deadMarker(mainId, markerShape(o.type, !!im), { x, y, w, h }, dpi));
  const lt = sharedLabel(m);
  if (o.type !== "text" && lt) items.push(labelItem(mainId, lt, x, y + h + dpi * LABEL_GAP, dpi, o.dead));
  return items;
}
const canBeDead = (type) => !["text", "zone", "rect", "mat", "grenade"].includes(type);
const markerShape = (type, isImage) => (type === "token" || (isImage && type !== "bloom") ? "circle" : "rect");

function deadMarker(mainId, shape, box, dpi) {
  const { x, y, w, h } = box;
  const b = shape === "circle"
    ? buildShape().shapeType("CIRCLE").width(w * 0.7).height(h * 0.7).position({ x: x + w / 2, y: y + h / 2 })
    : buildShape().shapeType("RECTANGLE").width(w * 0.84).height(h * 0.84).position({ x: x + w * 0.08, y: y + h * 0.08 });
  return b.fillColor("#0c0c10").fillOpacity(0.35).strokeColor("#0c0c10").strokeWidth(Math.max(3, dpi * 0.1))
    .attachedTo(mainId).locked(true).disableHit(true).layer("ATTACHMENT").metadata({ [CHILD]: mainId, [ROLE]: "dead" }).build();
}
function labelItem(mainId, text, x, y, dpi, dim) {
  return buildText().plainText(text).textType("PLAIN").width("AUTO").height("AUTO").fontSize(Math.max(12, dpi * LABEL_SIZE)).fontWeight(600)
    .fillColor(dim ? "#8c90a0" : "#e9ebf2").strokeColor("#0c0c10").strokeWidth(Math.max(1, dpi * 0.02)).position({ x, y })
    .attachedTo(mainId).locked(true).disableHit(true).layer("TEXT").metadata({ [CHILD]: mainId, [ROLE]: "label" }).build();
}

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

/* ---------- Items -> scene ---------- */
function itemToObj(it, dpi, ox, oy) {
  const m = it.metadata[OBJ];
  const b = pieceBox(it, dpi);
  const o = { ...m, x: round(b.x / dpi - ox), y: round(b.y / dpi - oy), w: round(b.w / dpi), h: round(b.h / dpi) };
  if (m.img) o.image = m.img;
  delete o.img;
  o.hidden = !it.visible;
  o.locked = !!it.locked;
  if (it.rotation) o.rot = Math.round(it.rotation);
  return o;
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

/* ---------- Changing one piece ---------- */
async function setPiece(id, patch) {
  const dpi = await OBR.scene.grid.getDpi();
  const [it] = await OBR.scene.items.getItems([id]);
  if (!it) return;
  const m = { ...it.metadata[OBJ], ...patch };
  await OBR.scene.items.updateItems([id], (ds) => { for (const d of ds) d.metadata[OBJ] = m; });
  await syncDecor({ ...it, metadata: { ...it.metadata, [OBJ]: m } }, dpi);
}
// Keeps the shared name label and the dead marker in step with the piece's data.
async function syncDecor(it, dpi) {
  const m = it.metadata[OBJ];
  const kids = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[CHILD] === it.id);
  const b = pieceBox(it, dpi);
  const label = kids.find((k) => k.metadata[ROLE] === "label");
  const text = m.type === "text" ? "" : sharedLabel(m);
  if (text && label) {
    if (label.text.plainText !== text || label.text.style.fillColor !== (m.dead ? "#8c90a0" : "#e9ebf2"))
      await OBR.scene.items.updateItems([label.id], (ds) => { for (const d of ds) { d.text.plainText = text; d.text.style.fillColor = m.dead ? "#8c90a0" : "#e9ebf2"; } });
  } else if (text) {
    await OBR.scene.items.addItems([labelItem(it.id, text, b.x, b.y + b.h + dpi * LABEL_GAP, dpi, m.dead)]);
  } else if (label) {
    await OBR.scene.items.deleteItems([label.id]);
  }
  const marker = kids.find((k) => k.metadata[ROLE] === "dead");
  if (m.dead && !marker && canBeDead(m.type)) await OBR.scene.items.addItems([deadMarker(it.id, markerShape(m.type, it.type === "IMAGE"), b, dpi)]);
  else if (!m.dead && marker) await OBR.scene.items.deleteItems([marker.id]);
}
async function setHidden(id, hidden) {
  await OBR.scene.items.updateItems([id], (ds) => { for (const d of ds) d.visible = !hidden; });
}
// Replaces a piece with a freshly built one (used to swap between drawn shape and linked image).
async function rebuildPiece(id, patch) {
  const dpi = await OBR.scene.grid.getDpi();
  const [it] = await OBR.scene.items.getItems([id]);
  if (!it) return null;
  const o = { ...itemToObj(it, dpi, 0, 0), ...patch };
  if (patch && "img" in patch) o.image = patch.img;
  const kids = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[CHILD] === id);
  const items = buildPiece(o, dpi, 0, 0);
  await OBR.scene.items.deleteItems([id, ...kids.map((k) => k.id)]);
  await OBR.scene.items.addItems(items);
  if (openIds.has(id)) { openIds.delete(id); openIds.add(items[0].id); }
  return items[0].id;
}

/* ---------- Images ---------- */
async function pickFromAssets() {
  const res = await OBR.assets.downloadImages(false, "", "CHARACTER");
  if (!res || !res.length) return null;
  const a = res[0];
  return { url: a.image.url, mime: a.image.mime, width: a.image.width, height: a.image.height, name: a.name };
}
async function pickFromSelection() {
  const sel = await OBR.player.getSelection();
  if (!sel || !sel.length) return null;
  const its = await OBR.scene.items.getItems(sel);
  const img = its.find((i) => i.type === "IMAGE");
  return img ? { url: img.image.url, mime: img.image.mime, width: img.image.width, height: img.image.height, name: img.name } : null;
}
async function linkImage(name, img) {
  const key = normKey(name);
  if (!key) { say("Give the image a name first (the piece's name on the map)."); return 0; }
  await saveRoom({ images: { ...room.images, [key]: { url: img.url, mime: img.mime, width: img.width, height: img.height, name: name.trim() } } });
  // Swap every piece with that name (that hasn't opted out) over to the image.
  const matches = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && !NO_LABEL_IMAGE.includes(i.metadata[OBJ].type) && i.metadata[OBJ].type !== "text"
    && (normKey(i.metadata[OBJ].img) === key || (!i.metadata[OBJ].noImg && normKey(i.metadata[OBJ].label) === key)));
  for (const it of matches) await rebuildPiece(it.id, { img: key, noImg: false });
  return matches.length;
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
    const libEntry = m.img && room.images[m.img];
    const imgRow = el("div", { class: "row" });
    if (libEntry) imgRow.append(el("img", { class: "thumb", src: libEntry.url, alt: "" }));
    imgRow.append(
      el("button", { class: "small", onclick: async () => { try { const img = await pickFromAssets(); if (!img) return; const n = await linkImage(m.label || m.id, img); say(`Linked. ${n} piece${n === 1 ? "" : "s"} now use the image.`); } catch (e) { say("Couldn't open your Owlbear images."); } } }, libEntry ? "Change image" : "Choose image"),
      el("button", { class: "small", onclick: async () => { const img = await pickFromSelection(); if (!img) { say("Select an image on the map first (click it), then press this."); return; } const n = await linkImage(m.label || m.id, img); say(`Linked. ${n} piece${n === 1 ? "" : "s"} now use the image.`); } }, "Use selected"));
    if (m.img) imgRow.append(el("button", { class: "small", onclick: async () => { await rebuildPiece(id, { img: null, noImg: true }); say("Back to the drawn piece. The image stays in Linked images."); } }, "Remove"));
    else if (m.noImg && room.images[normKey(m.label)]) imgRow.append(el("button", { class: "small", onclick: async () => { await rebuildPiece(id, { img: normKey(m.label), noImg: false }); } }, "Use linked image"));
    box.append(el("div", {}, el("div", { class: "lbl" }, "Image" + (m.label ? ` (linked to the name “${m.label}”)` : "")), imgRow));
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
  const libLink = async (getter, emptyMsg) => {
    const name = $("libName").value.trim();
    if (!name) { say("Type the name first, exactly as it appears on the map (for example Mei)."); $("libName").focus(); return; }
    let img; try { img = await getter(); } catch (e) { img = null; }
    if (!img) { if (emptyMsg) say(emptyMsg); return; }
    const n = await linkImage(name, img);
    $("libName").value = "";
    say(`Linked “${name}”.` + (n ? ` ${n} piece${n === 1 ? "" : "s"} on the map now use it.` : " It will be used the next time a piece with that name is built."));
  };
  $("libPick").onclick = () => libLink(pickFromAssets, "");
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
