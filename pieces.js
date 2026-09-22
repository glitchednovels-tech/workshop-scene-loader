// Shared piece building and editing, used by the panel (loader.js) and the image menu (use-image.js).
import OBR, { buildShape, buildText, buildImage } from "./obr-sdk.js?v=30";
import { OBJ, CHILD, ROLE, ROOM, LABEL_GAP, LABEL_SIZE, normKey, sortConditions, sharedLabel, pieceBox } from "./common.js?v=30";

const COLORS = { bloom: "#5ca014", cyan: "#40d0e6", ember: "#f05050", brass: "#f0c83c", steel: "#8c90a0", white: "#f5f5f5", blue: "#5a96e6", violet: "#a070dc" };
const col = (c) => COLORS[c] || c || "#f5f5f5";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "i" + Math.random().toString(36).slice(2));
function seeded(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }
const round = (v) => Math.round(v * 100) / 100;

const META_FIELDS = ["id", "type", "label", "color", "hp", "maxHp", "dead", "notes", "w", "h", "hpVis", "hpPlayers", "shown", "img", "noImg", "imgData"];
export const NO_LABEL_IMAGE = ["text", "zone", "rect", "mat"];      // these never pick up an image just from their name
export const CREATURE = (m) => m.maxHp || ["token", "bloom"].includes(m.type) || m.img || m.imgData;
// The layer each kind of piece lives on; an image that replaces a piece keeps the piece's layer.
export const LAYER = { token: "CHARACTER", bloom: "CHARACTER", grenade: "PROP", shield: "PROP", prop: "PROP", item: "PROP", zone: "DRAWING", mat: "DRAWING", rect: "DRAWING", text: "TEXT" };
const STRETCH = ["rect", "zone", "mat", "shield"];               // images fill these edge to edge (walls, floors); others keep their shape
// Library key for a piece: its name, or its id when it has no name.
export const pieceKey = (m, itemId) => (normKey(m.label) || "id:" + (m.id || itemId));

/* ---------- Room settings (conditions, default HP visibility, image library) ---------- */
export const room = { conditions: null, defaultHpVis: "gm", images: {} };
export async function loadRoom() { const r = (await OBR.room.getMetadata())[ROOM] || {}; Object.assign(room, { conditions: r.conditions || null, defaultHpVis: r.defaultHpVis || "gm", images: r.images || {} }); }
export async function saveRoom(patch) { Object.assign(room, patch); await OBR.room.setMetadata({ [ROOM]: { ...room } }); }
export const conditions = () => sortConditions(room.conditions);

/* ---------- Scene -> items ---------- */
function libImage(o) {
  if (o.noImg || o.type === "text") return null;
  if (o.imgData && o.imgData.url) return { key: o.img || o.image || null, ...o.imgData };
  const keys = [o.image, o.img, o.id && "id:" + o.id, NO_LABEL_IMAGE.includes(o.type) ? "" : o.label].map(normKey).filter(Boolean);
  const k = keys.find((x) => room.images[x]);
  return k ? { key: k, ...room.images[k] } : null;
}

export function buildPiece(o, dpi, ox, oy) {
  const items = [];
  const x = (o.x + ox) * dpi, y = (o.y + oy) * dpi;
  const w = (o.w || 1) * dpi, h = (o.h || 1) * dpi;
  const c = col(o.color);
  const im = libImage(o);
  const m = {};
  for (const f of META_FIELDS) if (o[f] !== undefined) m[f] = o[f];
  Object.assign(m, { label: o.label || "", color: o.color || "", hp: o.hp ?? null, maxHp: o.maxHp ?? null, dead: !!o.dead, notes: o.notes || "", w: o.w || 1, h: o.h || 1,
    hpVis: o.hpVis || room.defaultHpVis || "gm", hpPlayers: o.hpPlayers || [], shown: o.shown || "", img: im ? im.key : null, noImg: !!o.noImg,
    imgData: im ? { url: im.url, mime: im.mime || "image/png", width: im.width, height: im.height } : null, ibs: null });
  const lw = Math.max(2, dpi * 0.05);
  const mainId = uid();
  const locked = o.locked ?? ["rect", "zone", "mat"].includes(o.type);
  const child = (b) => b.attachedTo(mainId).locked(true).disableHit(true).metadata({ [CHILD]: mainId });

  let main;
  if (im) {
    // Walls, zones and floors: stretch the image to fill the area. Everything else: fit inside it, keeping proportions.
    const cw = o.w || 1, ch = o.h || 1;
    let gdpi, sc = { x: 1, y: 1 };
    if (STRETCH.includes(o.type)) { gdpi = im.width / cw; sc = { x: 1, y: ch / (im.height / gdpi) }; }
    else gdpi = Math.max(im.width / cw, im.height / ch);
    m.ibs = sc;
    main = buildImage({ url: im.url, mime: im.mime || "image/png", width: im.width, height: im.height }, { dpi: gdpi, offset: { x: im.width / 2, y: im.height / 2 } })
      .position({ x: x + w / 2, y: y + h / 2 }).scale(sc).layer(LAYER[o.type] || "PROP");
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
  if (o.layer) main = main.layer(o.layer);   // keep whatever layer the piece was on
  main = main.id(mainId).name(o.label || o.type).locked(locked).metadata({ [OBJ]: m });
  if (o.rot) main = main.rotation(o.rot);
  if (o.hidden) main = main.visible(false);
  items.unshift(main.build());

  if (o.dead && canBeDead(o.type)) items.push(deadMarker(mainId, markerShape(o.type, !!im), { x, y, w, h }, dpi));
  const lt = sharedLabel(m);
  if (o.type !== "text" && lt) items.push(labelItem(mainId, lt, x, y + h + dpi * LABEL_GAP, dpi, o.dead));
  return items;
}
export const canBeDead = (type) => !["text", "zone", "rect", "mat", "grenade"].includes(type);
const markerShape = (type, isImage) => (type === "token" || (isImage && type !== "bloom") ? "circle" : "rect");

export function deadMarker(mainId, shape, box, dpi) {
  const { x, y, w, h } = box;
  const b = shape === "circle"
    ? buildShape().shapeType("CIRCLE").width(w * 0.7).height(h * 0.7).position({ x: x + w / 2, y: y + h / 2 })
    : buildShape().shapeType("RECTANGLE").width(w * 0.84).height(h * 0.84).position({ x: x + w * 0.08, y: y + h * 0.08 });
  return b.fillColor("#0c0c10").fillOpacity(0.35).strokeColor("#0c0c10").strokeWidth(Math.max(3, dpi * 0.1))
    .attachedTo(mainId).locked(true).disableHit(true).layer("ATTACHMENT").metadata({ [CHILD]: mainId, [ROLE]: "dead" }).build();
}
export function labelItem(mainId, text, x, y, dpi, dim) {
  return buildText().plainText(text).textType("PLAIN").width("AUTO").height("AUTO").fontSize(Math.max(12, dpi * LABEL_SIZE)).fontWeight(600)
    .fillColor(dim ? "#8c90a0" : "#e9ebf2").strokeColor("#0c0c10").strokeWidth(Math.max(1, dpi * 0.02)).position({ x, y })
    .attachedTo(mainId).locked(true).disableHit(true).layer("TEXT").metadata({ [CHILD]: mainId, [ROLE]: "label" }).build();
}

/* ---------- Items -> scene ---------- */
export function itemToObj(it, dpi, ox, oy) {
  const m = it.metadata[OBJ];
  const b = pieceBox(it, dpi);
  const o = { ...m, x: round(b.x / dpi - ox), y: round(b.y / dpi - oy), w: round(b.w / dpi), h: round(b.h / dpi) };
  if (m.img) o.image = m.img;
  delete o.img;
  o.hidden = !it.visible;
  o.locked = !!it.locked;
  o.layer = it.layer;
  delete o.ibs;
  if (it.rotation) o.rot = Math.round(it.rotation);
  return o;
}
/* ---------- Changing one piece ---------- */
export async function setPiece(id, patch) {
  const dpi = await OBR.scene.grid.getDpi();
  const [it] = await OBR.scene.items.getItems([id]);
  if (!it) return;
  const m = { ...it.metadata[OBJ], ...patch };
  await OBR.scene.items.updateItems([id], (ds) => { for (const d of ds) d.metadata[OBJ] = m; });
  await syncDecor({ ...it, metadata: { ...it.metadata, [OBJ]: m } }, dpi);
}
// Keeps the shared name label and the dead marker in step with the piece's data.
export async function syncDecor(it, dpi) {
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
export async function setHidden(id, hidden) {
  await OBR.scene.items.updateItems([id], (ds) => { for (const d of ds) d.visible = !hidden; });
}
// Replaces a piece with a freshly built one (used to swap between drawn shape and linked image).
export async function rebuildPiece(id, patch) {
  const dpi = await OBR.scene.grid.getDpi();
  const [it] = await OBR.scene.items.getItems([id]);
  if (!it) return null;
  const o = { ...itemToObj(it, dpi, 0, 0), ...patch };
  if (patch && "img" in patch) o.image = patch.img;
  if (patch && "imgData" in patch && !patch.imgData) delete o.imgData;
  const kids = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[CHILD] === id);
  const items = buildPiece(o, dpi, 0, 0);
  await OBR.scene.items.deleteItems([id, ...kids.map((k) => k.id)]);
  await OBR.scene.items.addItems(items);
  return items[0].id;
}

/* ---------- Images ---------- */
export function imageOf(item) {
  return item && item.type === "IMAGE" ? { url: item.image.url, mime: item.image.mime, width: item.image.width, height: item.image.height, name: item.name } : null;
}
export async function pickFromSelection() {
  const sel = await OBR.player.getSelection();
  if (!sel || !sel.length) return null;
  const its = await OBR.scene.items.getItems(sel);
  return imageOf(its.find((i) => i.type === "IMAGE"));
}
const entryOf = (img, name) => ({ url: img.url, mime: img.mime || "image/png", width: img.width, height: img.height, name: name || img.name || "" });

// Link an image to a name: every piece with that name uses it, now and in future scenes.
export async function linkImage(name, img) {
  const key = normKey(name);
  if (!key) throw new Error("Give the image a name first (the piece's name on the map).");
  const entry = entryOf(img, name.trim());
  await saveRoom({ images: { ...room.images, [key]: entry } });
  const matches = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && i.metadata[OBJ].type !== "text"
    && (normKey(i.metadata[OBJ].img) === key || (!i.metadata[OBJ].noImg && !NO_LABEL_IMAGE.includes(i.metadata[OBJ].type) && normKey(i.metadata[OBJ].label) === key)));
  for (const it of matches) await rebuildPiece(it.id, { img: key, imgData: entry, noImg: false });
  return matches.length;
}

// Put an image on exactly these pieces. With remember on, each piece's name (or id) is linked for future scenes too.
export async function applyImage(ids, img, remember = true) {
  const its = await OBR.scene.items.getItems(ids);
  const entry = entryOf(img);
  if (remember) {
    const images = { ...room.images };
    for (const it of its) { const m = it.metadata[OBJ]; images[pieceKey(m, it.id)] = { ...entry, name: m.label || m.id || entry.name }; }
    await saveRoom({ images });
  }
  const out = [];
  for (const it of its) {
    const m = it.metadata[OBJ];
    out.push(await rebuildPiece(it.id, { img: remember ? pieceKey(m, it.id) : null, imgData: entry, noImg: false }));
  }
  return out;
}

/* ---------- Combat window ---------- */
const BASE = new URL(".", import.meta.url).href;
export const COMBAT_POPOVER = "com.workshop.scene-loader/combat-window";
// Opens the docked combat window on the right (or leaves it alone if it's already open).
export async function openCombatWindow(focus) {
  const already = await OBR.popover.getWidth(COMBAT_POPOVER).catch(() => undefined);
  if (!already) {
    const vw = await OBR.viewport.getWidth(), vh = await OBR.viewport.getHeight();
    await OBR.popover.open({
      id: COMBAT_POPOVER, url: BASE + "combat.html?v=30", width: Math.min(500, vw - 40), height: Math.max(420, vh - 96),
      anchorReference: "POSITION", anchorPosition: { left: vw - 12, top: 64 },
      anchorOrigin: { horizontal: "RIGHT", vertical: "TOP" }, transformOrigin: { horizontal: "RIGHT", vertical: "TOP" },
      disableClickAway: true, marginThreshold: 8,
    });
  }
  if (focus) setTimeout(() => OBR.broadcast.sendMessage("com.workshop.scene-loader/combat-focus", focus, { destination: "LOCAL" }).catch(() => {}), already ? 0 : 1500);
}
