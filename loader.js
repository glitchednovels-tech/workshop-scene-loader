// Workshop Scene Loader — an Owlbear Rodeo extension.
// Turns "War Table" scene text (positions in grid squares) into Owlbear items, and back.
import OBR, { buildShape, buildText } from "./obr-sdk.js";

const KEY = "com.workshop.scene-loader";
const OBJ = KEY + "/obj";     // metadata on a main piece
const CHILD = KEY + "/child"; // metadata on decoration attached to a piece
const SCENE = KEY + "/scene"; // scene-level metadata (name, round, status)

const COLORS = { bloom: "#5ca014", cyan: "#40d0e6", ember: "#f05050", brass: "#f0c83c", steel: "#8c90a0", white: "#f5f5f5", blue: "#5a96e6", violet: "#a070dc" };
const col = (c) => COLORS[c] || c || "#f5f5f5";
const $ = (id) => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "i" + Math.random().toString(36).slice(2));
function say(t) { $("msg").textContent = t; clearTimeout(say.t); say.t = setTimeout(() => ($("msg").textContent = ""), 5000); }
function seeded(str) { let h = 2166136261; for (const ch of String(str)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 10000) / 10000; }; }

function labelText(o) {
  let t = o.label || "";
  if (o.maxHp) t += (t ? " " : "") + (o.hp ?? o.maxHp) + "/" + o.maxHp;
  return t;
}

/* ---------- Scene -> items ---------- */
function buildPiece(o, dpi, ox, oy) {
  const items = [];
  const x = (o.x + ox) * dpi, y = (o.y + oy) * dpi;
  const w = (o.w || 1) * dpi, h = (o.h || 1) * dpi;
  const c = col(o.color);
  const meta = { [OBJ]: { id: o.id, type: o.type, label: o.label || "", color: o.color || "", hp: o.hp ?? null, maxHp: o.maxHp ?? null, dead: !!o.dead, notes: o.notes || "", w: o.w || 1, h: o.h || 1 } };
  const lw = Math.max(2, dpi * 0.05);
  const mainId = uid();
  const locked = o.locked ?? ["rect", "zone", "mat"].includes(o.type);
  const child = (b) => b.attachedTo(mainId).locked(true).disableHit(true).metadata({ [CHILD]: mainId });

  let main;
  switch (o.type) {
    case "token": {
      main = buildShape().id(mainId).shapeType("CIRCLE").width(w).height(h).position({ x: x + w / 2, y: y + h / 2 })
        .fillColor("#321c26").fillOpacity(1).strokeColor(c).strokeWidth(lw * 1.4).layer("CHARACTER");
      break;
    }
    case "grenade": {
      main = buildShape().id(mainId).shapeType("CIRCLE").width(w).height(h).position({ x: x + w / 2, y: y + h / 2 })
        .fillColor(o.dead ? "#1f2130" : c).fillOpacity(o.dead ? 0 : 0.8).strokeColor(o.dead ? "#8c90a0" : c).strokeWidth(lw).layer("PROP");
      break;
    }
    case "zone": {
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(c).fillOpacity(0).strokeColor(c).strokeWidth(lw).strokeDash([dpi * 0.2, dpi * 0.12]).layer("DRAWING");
      break;
    }
    case "mat": {
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(o.dead ? "#6e3737" : "#3c6e14").fillOpacity(0.25).strokeColor(o.dead ? "#6e3737" : "#3c6e14").strokeWidth(lw * 0.6).strokeDash([dpi * 0.08, dpi * 0.08]).layer("DRAWING");
      break;
    }
    case "text": {
      main = buildText().id(mainId).plainText(o.label || "Label").textType("PLAIN").width("AUTO").height("AUTO")
        .fontSize(dpi * 0.3).fontWeight(600).fillColor(c).position({ x, y }).layer("TEXT");
      break;
    }
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
    default: { // "rect" and anything unknown
      main = buildShape().id(mainId).shapeType("RECTANGLE").width(w).height(h).position({ x, y })
        .fillColor(c).fillOpacity(0).strokeColor(c).strokeWidth(lw * 1.2).layer("DRAWING");
    }
  }
  main = main.name(o.label || o.type).locked(locked).metadata(meta);
  if (o.rot) main = main.rotation(o.rot);
  if (o.hidden) main = main.visible(false);
  items.unshift(main.build());

  // dead marker
  if (o.dead && (o.type === "bloom" || o.type === "token")) items.push(deadMarker(mainId, o.type, x, y, w, h, dpi));
  // label under the piece
  if (o.type !== "text" && labelText(o)) items.push(labelItem(mainId, labelText(o), x, y + h + dpi * 0.05, dpi, o.dead));
  return items;
}

function deadMarker(mainId, type, x, y, w, h, dpi) {
  const b = type === "token"
    ? buildShape().shapeType("CIRCLE").width(w * 0.7).height(h * 0.7).position({ x: x + w / 2, y: y + h / 2 })
    : buildShape().shapeType("RECTANGLE").width(w * 0.84).height(h * 0.84).position({ x: x + w * 0.08, y: y + h * 0.08 });
  return b.fillColor("#0c0c10").fillOpacity(0.35).strokeColor("#0c0c10").strokeWidth(Math.max(3, dpi * 0.1))
    .attachedTo(mainId).locked(true).disableHit(true).layer("CHARACTER").metadata({ [CHILD]: mainId, [KEY + "/role"]: "dead" }).build();
}
function labelItem(mainId, text, x, y, dpi, dim) {
  return buildText().plainText(text).textType("PLAIN").width("AUTO").height("AUTO").fontSize(Math.max(12, dpi * 0.22)).fontWeight(600)
    .fillColor(dim ? "#8c90a0" : "#e9ebf2").position({ x, y }).attachedTo(mainId).locked(true).disableHit(true).layer("TEXT")
    .metadata({ [CHILD]: mainId, [KEY + "/role"]: "label" }).build();
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
    // Attached pieces normally follow their parent; move them ourselves only if they didn't.
    await new Promise((r) => setTimeout(r, 300));
    const [after] = await OBR.scene.items.getItems([probe.id]);
    if (after && after.position.x === probe.x && after.position.y === probe.y) {
      await OBR.scene.items.updateItems(kids.map((i) => i.id), (ds) => { for (const d of ds) { d.position.x += dx; d.position.y += dy; } });
    }
  }
  const all = await OBR.scene.getMetadata();
  const meta = all[SCENE] || {};
  await OBR.scene.setMetadata({ [SCENE]: { ...meta, ox: (meta.ox || 0) + Math.round(dxCells), oy: (meta.oy || 0) + Math.round(dyCells) } });
}
async function sceneOrigin() {
  const meta = (await OBR.scene.getMetadata())[SCENE] || {};
  return { ox: meta.ox || 0, oy: meta.oy || 0, cols: meta.cols || 10, rows: meta.rows || 10 };
}

/* ---------- Items -> scene ---------- */
async function exportScene() {
  const dpi = await OBR.scene.grid.getDpi();
  const meta = (await OBR.scene.getMetadata())[SCENE] || {};
  const ox = meta.ox || 0, oy = meta.oy || 0;
  const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ]);
  const objects = mains.map((it) => {
    const m = it.metadata[OBJ];
    const w = (it.width ? it.width * (it.scale?.x || 1) / dpi : m.w);
    const h = (it.height ? it.height * (it.scale?.y || 1) / dpi : m.h);
    const centred = it.type === "SHAPE" && it.shapeType !== "RECTANGLE";
    const x = (it.position.x - (centred ? w * dpi / 2 : 0)) / dpi - ox;
    const y = (it.position.y - (centred ? h * dpi / 2 : 0)) / dpi - oy;
    const o = { id: m.id, type: m.type, x: round(x), y: round(y), w: round(w), h: round(h) };
    if (m.label) o.label = m.label;
    if (m.color) o.color = m.color;
    if (m.maxHp != null) { o.maxHp = m.maxHp; o.hp = m.hp; }
    if (m.dead) o.dead = true;
    if (m.notes) o.notes = m.notes;
    if (!it.visible) o.hidden = true;
    if (it.locked) o.locked = true;
    if (it.rotation) o.rot = Math.round(it.rotation);
    return o;
  });
  return { name: meta.name || "Owlbear board", cols: meta.cols, rows: meta.rows, round: meta.round || 1, status: meta.status || "", objects };
}
const round = (v) => Math.round(v * 100) / 100;

/* ---------- Piece list: HP and dead ---------- */
async function refreshList() {
  const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && (i.metadata[OBJ].maxHp || ["token", "bloom"].includes(i.metadata[OBJ].type)));
  const ul = $("pieces"); ul.textContent = "";
  $("noPieces").hidden = mains.length > 0;
  for (const it of mains) {
    const m = it.metadata[OBJ];
    const li = document.createElement("li");
    if (m.dead) li.className = "dead";
    const left = document.createElement("div");
    left.innerHTML = `<div class="name"></div><div class="hp"></div>`;
    left.querySelector(".name").textContent = m.label || m.type;
    left.querySelector(".hp").textContent = m.maxHp ? `${m.hp ?? m.maxHp} / ${m.maxHp} HP` : "";
    const ctl = document.createElement("div"); ctl.className = "ctl";
    if (isGM) {
      const hpIn = document.createElement("input"); hpIn.type = "number"; hpIn.value = m.hp ?? ""; hpIn.setAttribute("aria-label", "HP for " + (m.label || m.type)); hpIn.id = "hp-" + it.id;
      hpIn.onchange = () => setPiece(it.id, { hp: hpIn.value === "" ? null : +hpIn.value });
      const dead = document.createElement("button"); dead.textContent = m.dead ? "Revive" : "Dead";
      dead.onclick = () => setPiece(it.id, { dead: !m.dead });
      if (m.maxHp) ctl.append(hpIn);
      ctl.append(dead);
    }
    li.append(left, ctl);
    ul.append(li);
  }
}

async function setPiece(id, patch) {
  const dpi = await OBR.scene.grid.getDpi();
  const [it] = await OBR.scene.items.getItems([id]);
  if (!it) return;
  const m = { ...it.metadata[OBJ], ...patch };
  await OBR.scene.items.updateItems([id], (drafts) => { for (const d of drafts) d.metadata[OBJ] = m; });
  // update the label
  const kids = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[CHILD] === id);
  const label = kids.find((k) => k.metadata[KEY + "/role"] === "label");
  if (label) await OBR.scene.items.updateItems([label.id], (ds) => { for (const d of ds) { d.text.plainText = labelText(m); d.text.style.fillColor = m.dead ? "#8c90a0" : "#e9ebf2"; } });
  // add or remove the dead marker
  const marker = kids.find((k) => k.metadata[KEY + "/role"] === "dead");
  if (m.dead && !marker && (m.type === "bloom" || m.type === "token")) {
    const w = (it.width || dpi) * (it.scale?.x || 1), h = (it.height || dpi) * (it.scale?.y || 1);
    const centred = it.shapeType !== "RECTANGLE";
    const x = it.position.x - (centred ? w / 2 : 0), y = it.position.y - (centred ? h / 2 : 0);
    await OBR.scene.items.addItems([deadMarker(id, m.type, x, y, w, h, dpi)]);
  } else if (!m.dead && marker) {
    await OBR.scene.items.deleteItems([marker.id]);
  }
}

/* ---------- Wiring ---------- */
let isGM = false;
OBR.onReady(async () => {
  isGM = (await OBR.player.getRole()) === "GM";
  $("gmTools").hidden = !isGM;
  $("moveTools").hidden = !isGM;
  const start = async () => { try { await refreshList(); } catch (e) {} };
  if (await OBR.scene.isReady()) start();
  OBR.scene.onReadyChange((ready) => { if (ready) start(); });
  OBR.scene.items.onChange(() => start());

  $("buildBtn").onclick = async () => {
    let scene;
    try { scene = JSON.parse($("sceneIn").value); } catch (e) { say("That text isn't valid scene text. Copy the whole block Claude gave you, including the first { and last }."); return; }
    try { const n = await buildScene(scene); say(`Built ${n} pieces.`); refreshList(); }
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
});
