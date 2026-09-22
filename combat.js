// Workshop combat window (GM). Rounds and turns, turn order, start/end-of-turn effects, the active
// combatant's sheet, the attack → hit → reaction → damage flow, resource pools and manual overrides.
// Rules math lives in engine.js; sheets come from the combat pack generated from the Obsidian vault.
import OBR, { buildShape } from "./obr-sdk.js?v=31";
import * as E from "./engine.js?v=31";
import { KEY, OBJ, CHILD, AOE } from "./common.js?v=31";
import { setPiece, COMBAT_POPOVER } from "./pieces.js?v=31";

const CMB = KEY + "/combat";                 // scene metadata: round, turn, order, areas
const LS_PACK = "wsl.combatPack.v1", LS_RULES = "wsl.combatRules.v1";
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o ?? null));
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "");

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on")) e[k] = v;
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
function say(t, variant) {
  $("msg").textContent = t || "";
  clearTimeout(say.t); say.t = setTimeout(() => ($("msg").textContent = ""), 8000);
  if (t && variant) { try { OBR.notification.show(t, variant); } catch (e) {} }
}

/* ======================= Pack and rules (GM browser) ======================= */
let pack = null, sheets = {};
function loadPack() {
  try { pack = JSON.parse(localStorage.getItem(LS_PACK) || "null"); } catch (e) { pack = null; }
  sheets = {}; for (const s of (pack && pack.sheets) || []) sheets[s.id] = s;
}
function savePack(p) { localStorage.setItem(LS_PACK, JSON.stringify(p)); loadPack(); }
function rules() {
  let r = {}; try { r = JSON.parse(localStorage.getItem(LS_RULES) || "{}"); } catch (e) {}
  const base = (pack && pack.rules) || {};
  return { nat1: r.nat1 || base.nat1 || "degree", order: r.order || base.order || E.DEFAULT_ORDER, bloomIgnores: base.bloomIgnores || ["mana-shield", "absorption"] };
}
function saveRules(patch) { const r = { ...rules(), ...patch }; localStorage.setItem(LS_RULES, JSON.stringify({ nat1: r.nat1, order: r.order })); }

/* ======================= Scene state ======================= */
let items = new Map();        // id → item (main pieces with OBJ metadata)
let combat = emptyCombat();
let dpi = 150, gridFeet = 5;
function emptyCombat() { return { active: false, round: 1, turn: 0, mode: "manual", slots: [], areas: [], started: false }; }
async function readScene() {
  if (readScene.busy) { readScene.again = true; return; }
  readScene.busy = true;
  try { await readSceneNow(); } finally { readScene.busy = false; if (readScene.again) { readScene.again = false; await readScene(); } }
}
async function readSceneNow() {
  const list = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ]);
  items = new Map(list.map((i) => [i.id, i]));
  const meta = (await OBR.scene.getMetadata())[CMB];
  combat = { ...emptyCombat(), ...(meta || {}) };
  combat.slots = (combat.slots || []).map((s) => ({ ...s, ids: (s.ids || []).filter((id) => items.has(id)) })).filter((s) => s.ids.length);
  if (combat.turn >= combat.slots.length) combat.turn = 0;
  try { dpi = await OBR.scene.grid.getDpi(); const sc = await OBR.scene.grid.getScale(); gridFeet = (sc && sc.parsed && sc.parsed.multiplier) || 5; } catch (e) {}
}
async function saveCombat() { await OBR.scene.setMetadata({ [CMB]: clone(combat) }); }

const metaOf = (id) => (items.get(id) || {}).metadata?.[OBJ] || {};
const cbtOf = (id) => metaOf(id).cbt || null;
const sheetOf = (id) => sheets[(cbtOf(id) || {}).sheet] || null;
const nameOf = (id) => metaOf(id).label || (items.get(id) || {}).name || "Unnamed";
const activeSlot = () => (combat.active ? combat.slots[combat.turn] : null);

// Everything the engine needs to know about a combatant right now.
function view(id) {
  const m = metaOf(id), c = cbtOf(id) || {}, s = sheetOf(id) || {};
  const parts = clone(s.armorParts || (s.armor ? [{ name: "Armor", value: s.armor }] : []));
  let armor = s.armor ?? 10;
  for (const md of s.modes || []) if ((c.modes || {})[md.id] && md.armor) { armor += md.armor; parts.push({ name: md.name, value: md.armor, tags: md.armorTags || [] }); }
  const pools = (s.pools || []).map((p) => ({ ...p, cur: (c.pools || {})[p.id]?.cur ?? p.start ?? p.max }));
  for (const tp of c.tempPools || []) pools.push({ ...tp });
  return {
    id, name: nameOf(id), sheet: s, hp: m.hp ?? m.maxHp ?? s.hp ?? 0, maxHp: m.maxHp ?? s.hp ?? 0,
    armor, armorParts: parts, armorMod: c.armorMod || 0, dr: s.dr || {}, resist: s.resist || [], immune: s.immune || [], vuln: s.vuln || [],
    critReduce: s.critReduce || 0, size: s.size || "Medium", kind: s.kind || "construct", tags: s.tags || [], pools, attrs: s.attrs || {}, saves: s.saves || {},
  };
}
function saveBonus(v, attr) { return v.saves[attr] ?? v.attrs[attr] ?? 0; }

/* ======================= Undo ======================= */
const undoStack = [];
function snapshot(ids, label) {
  undoStack.push({ label, combat: clone(combat), metas: ids.filter((id) => items.has(id)).map((id) => ({ id, meta: clone(metaOf(id)) })) });
  if (undoStack.length > 40) undoStack.shift();
}
async function undo() {
  const u = undoStack.pop();
  if (!u) { say("Nothing to undo."); return; }
  for (const { id, meta } of u.metas) if (items.has(id)) await setPiece(id, meta);
  combat = u.combat; await saveCombat();
  say(`Undone: ${u.label}.`);
}

/* ======================= Writing combatant state ======================= */
async function writeCbt(id, fn, extra = {}) {
  const m = metaOf(id);
  const c = clone(m.cbt || {});
  const out = fn ? (fn(c) || c) : c;
  await setPiece(id, { ...extra, cbt: out });
  const it = items.get(id);
  if (it) items.set(id, { ...it, metadata: { ...it.metadata, [OBJ]: { ...m, ...extra, cbt: out } } });
}
function setPoolIn(c, poolId, cur, sheet) {
  c.pools = c.pools || {};
  const p = (sheet.pools || []).find((x) => x.id === poolId);
  const max = p ? p.max : Infinity;
  c.pools[poolId] = { ...(c.pools[poolId] || {}), cur: Math.max(0, Math.min(max, Math.round(cur))) };
}
function poolCur(id, poolId) { return view(id).pools.find((p) => p.id === poolId)?.cur ?? 0; }

async function addCombatant(id, sheetId) {
  const s = sheets[sheetId];
  const m = metaOf(id);
  const c = { sheet: sheetId || null, pools: {}, modes: {}, conds: [], effects: [], timers: [], armorMod: 0, econ: {} };
  if (s) {
    for (const p of s.pools || []) c.pools[p.id] = { cur: p.start ?? p.max };
    for (const md of s.modes || []) if (md.on) c.modes[md.id] = true;
  }
  const extra = {};
  if (s && !m.maxHp) { extra.maxHp = s.hp; extra.hp = s.hp; }
  await writeCbt(id, () => c, extra);
}
function guessSheet(id) {
  const n = (nameOf(id) || "").toLowerCase().trim();
  const cur = cbtOf(id)?.sheet; if (cur && sheets[cur]) return cur;
  for (const s of Object.values(sheets)) if (s.name.toLowerCase() === n || (s.aliases || []).some((a) => a.toLowerCase() === n)) return s.id;
  for (const s of Object.values(sheets)) if ((s.aliases || []).some((a) => a.length > 2 && n.includes(a.toLowerCase()))) return s.id;
  return "";
}

/* ======================= Ops (effects written in the sheets) ======================= */
// Applies one op to combatant `id`. ctx: {attackerId, damageDealt, log:[]}
async function applyOp(id, op, ctx = {}) {
  const log = ctx.log || [];
  const v = view(id), s = v.sheet;
  switch (op.op) {
    case "heal": {
      const amt = op.dice ? E.roll(op.dice).total : +op.amount || 0;
      const hp = Math.min(v.maxHp, v.hp + amt);
      await setPiece(id, { hp }); patchLocal(id, { hp });
      log.push(`${v.name}: +${hp - v.hp} HP (${v.hp} → ${hp})`); break;
    }
    case "damage": {
      const parts = E.rollDamageParts([{ dice: op.dice, type: op.type || "force", magical: op.magical }]);
      await dealDamage(id, parts.map((p) => ({ amount: p.amount, type: p.type, magical: p.magical })), {}, { log, label: op.name || "Effect" });
      break;
    }
    case "pool": case "selfPool": {
      const target = op.op === "selfPool" && ctx.attackerId ? ctx.attackerId : id;
      const tv = view(target);
      const p = tv.pools.find((x) => x.id === op.pool); if (!p) { log.push(`(no pool ${op.pool})`); break; }
      await writeCbt(target, (c) => { setPoolIn(c, op.pool, p.cur + (+op.delta || 0), tv.sheet); });
      log.push(`${tv.name}: ${p.name} ${op.delta > 0 ? "+" : ""}${op.delta}`); break;
    }
    case "setPool": {
      const p = v.pools.find((x) => x.id === op.pool); if (!p) break;
      const val = op.value === "max" ? p.max : +op.value || 0;
      await writeCbt(id, (c) => { setPoolIn(c, op.pool, val, s); if (op.rounds) { c.timers = (c.timers || []).filter((t) => t.pool !== op.pool); c.timers.push({ pool: op.pool, rounds: op.rounds, name: p.name }); } });
      log.push(`${v.name}: ${p.name} set to ${val}${op.rounds ? ` for ${op.rounds} rounds` : ""}`); break;
    }
    case "condition": {
      await writeCbt(id, (c) => { c.conds = (c.conds || []).filter((x) => x.name !== op.name); c.conds.push({ name: op.name, rounds: op.rounds || null }); });
      log.push(`${v.name}: ${op.name}${op.rounds ? ` (${op.rounds} rounds)` : ""}`); break;
    }
    case "stack": {
      let n = 0;
      await writeCbt(id, (c) => { c.conds = c.conds || []; const x = c.conds.find((q) => q.name === op.name); if (x) { x.count = (x.count || 1) + (op.add || 1); n = x.count; } else { c.conds.push({ name: op.name, count: op.add || 1, note: op.note }); n = op.add || 1; } });
      log.push(`${v.name}: ${op.name} ×${n}${op.note ? " — " + op.note : ""}`); break;
    }
    case "drain": {
      const amount = op.amount === "damage" ? (ctx.damageDealt || 0) : +op.amount || 0;
      if (!amount) break;
      const p = v.pools.find((x) => x.siphon && !(x.tags || []).includes("anti-siphon") && x.cur > 0);
      if (!p) { log.push(`${v.name}: drain blocked (no conductive path to a mana store)`); break; }
      const d = Math.min(p.cur, amount);
      await writeCbt(id, (c) => { setPoolIn(c, p.id, p.cur - d, s); });
      log.push(`${v.name}: ${p.name} drained −${d}`); break;
    }
    case "note": log.push(`Note: ${op.text}`); break;
    default: log.push(`(Resolve by hand: ${op.op}${op.text ? " — " + op.text : ""})`);
  }
}
function patchLocal(id, patch) { const it = items.get(id); if (it) items.set(id, { ...it, metadata: { ...it.metadata, [OBJ]: { ...it.metadata[OBJ], ...patch } } }); }

// Run a damage packet through the pipeline and write HP and pools.
async function dealDamage(id, parts, adj = {}, o = {}) {
  const v = view(id);
  const res = E.applyDamage({ ...v }, parts, adj, { order: rules().order, ignoreShieldTags: o.ignoreShieldTags || [], ignoreDR: o.ignoreDR });
  const hp = res.hpAfter;
  await writeCbt(id, (c) => { for (const p of res.poolsAfter) if (p.id && (v.sheet.pools || []).some((q) => q.id === p.id)) setPoolIn(c, p.id, p.cur, v.sheet); c.tempPools = (c.tempPools || []).map((tp) => ({ ...tp, cur: res.poolsAfter.find((x) => x.id === tp.id)?.cur ?? tp.cur })).filter((tp) => tp.cur > 0); }, { hp });
  const logs = o.log || [];
  logs.push(`${o.label || "Damage"} → ${v.name}: ${res.log.join(" · ") || "no damage"}`);
  if (v.hp > 0 && hp <= 0) {
    const cond = v.kind === "living" ? "Downed" : "Disabled";
    await applyOp(id, { op: "condition", name: cond }, { log: logs });
    logs.push(`${v.name} is ${cond}.`);
  }
  return res;
}

/* ======================= Turn processing ======================= */
let prompts = [];   // start/end-of-turn effects that need the GM's decision
const turnLog = [];
function logLine(t) { turnLog.push(`R${combat.round}·T${combat.turn + 1}  ${t}`); if (turnLog.length > 200) turnLog.shift(); }

async function processTurnPhase(slot, when) {
  const log = [];
  for (const id of slot.ids) {
    if (!items.has(id) || !cbtOf(id)) continue;
    const v = view(id), s = v.sheet || {};
    // pools: regeneration and mode upkeep
    await writeCbt(id, (c) => {
      c.pools = c.pools || {};
      for (const p of s.pools || []) {
        const st = { ...p, cur: c.pools[p.id]?.cur ?? p.start ?? p.max, carry: c.pools[p.id]?.carry || 0 };
        const r = E.applyRegen(st, when);
        if (r.gained) log.push(`${v.name}: ${p.name} +${r.gained}`);
        c.pools[p.id] = { cur: r.pool.cur, carry: r.pool.carry || 0 };
      }
      if (when === "start") {
        for (const md of s.modes || []) {
          if (!(c.modes || {})[md.id]) continue;
          for (const u of md.upkeep || []) {
            const f = u.per === "minute" ? 1 / 10 : 1;
            const cur = c.pools[u.pool]?.cur ?? 0, carry = (c.pools[u.pool]?.upCarry || 0) + u.amount * f;
            const whole = Math.floor(carry);
            c.pools[u.pool] = { ...(c.pools[u.pool] || {}), cur: Math.max(0, cur - whole), upCarry: carry - whole };
            if (whole) log.push(`${v.name}: ${md.name} −${whole} ${u.pool}`);
            if (cur - whole <= 0) log.push(`⚠ ${v.name}: ${u.pool} is empty (${md.name})`);
          }
        }
        c.econ = { action: false, bonus: false, reaction: false, move: false, attacks: 0 };
        // timed pools (shields raised for N rounds)
        c.timers = (c.timers || []).map((t) => ({ ...t, rounds: t.rounds - 1 })).filter((t) => {
          if (t.rounds > 0) return true;
          c.pools[t.pool] = { ...(c.pools[t.pool] || {}), cur: 0 }; log.push(`${v.name}: ${t.name} expired`); return false;
        });
      }
      if (when === "end") {
        c.conds = (c.conds || []).map((x) => (x.rounds ? { ...x, rounds: x.rounds - 1 } : x)).filter((x) => x.rounds === null || x.rounds === undefined || x.rounds > 0);
        c.armorMod = 0;
      }
    });
    // sheet turn effects + active effects
    const effects = [...(s.turnEffects || []).map((e) => ({ ...e, source: "sheet" })), ...((cbtOf(id) || {}).effects || [])];
    for (const e of effects) {
      if ((e.when || "start") !== when) continue;
      if (e.auto) { for (const op of e.ops || []) await applyOp(id, op, { log }); log.push(`${v.name}: ${e.name} applied`); }
      else prompts.push({ key: uid(), id, name: e.name, text: e.text || "", ops: e.ops || [], when, kind: "effect" });
    }
    if (when === "end") {
      await writeCbt(id, (c) => { c.effects = (c.effects || []).map((e) => (e.rounds ? { ...e, rounds: e.rounds - 1 } : e)).filter((e) => !e.rounds || e.rounds > 0); });
    }
    // areas: "when starting your turn in X radius"
    if (when === "start") for (const a of combat.areas || []) {
      if ((a.trigger || "start") !== "start") continue;
      const inside = a.templateId ? await inTemplate(a.templateId, id) : ((await distanceFeet(a.anchorId, id)) ?? Infinity) <= a.radius;
      if (inside) prompts.push({ key: uid(), id, name: `${a.name}: starts turn inside the area`, area: a, when, kind: "area" });
    }
  }
  for (const l of log) logLine(l);
  return log;
}
/* ---------- Area templates (circle, square/cube, line) ---------- */
// A template is a normal, movable Owlbear shape. Circles are positioned by their centre; squares and lines are
// rectangles that rotate around their corner. Lines start at the caster, 5 ft wide unless the sheet says otherwise.
const pxPerFt = () => dpi / gridFeet;
function areaDims(ar) {
  const shape = ar.shape || (ar.radius ? "circle" : "square");
  return { shape, radius: ar.radius || 0, size: ar.size || 0, length: ar.length || 0, width: ar.width || 5 };
}
function areaText(ar) {
  const d = areaDims(ar);
  return d.shape === "circle" ? `${d.radius} ft radius` : d.shape === "line" ? `${d.length} ft × ${d.width} ft line` : `${d.size} ft square`;
}
async function centreOf(id) {
  const b = await OBR.scene.items.getItemBounds([id]);
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, b };
}
async function placeTemplate(ar, originId, aimId, name) {
  const d = areaDims(ar), px = pxPerFt();
  const o = await centreOf(originId);
  let item;
  const meta = { [AOE]: { ...d, name: name || ar.name || "Area" } };
  if (d.shape === "circle") {
    const r = d.radius * px;
    item = buildShape().shapeType("CIRCLE").width(r * 2).height(r * 2).position({ x: o.x, y: o.y });
  } else if (d.shape === "line") {
    const L = d.length * px, W = d.width * px;
    let ang = 0;
    if (aimId) { const t = await centreOf(aimId); ang = Math.atan2(t.y - o.y, t.x - o.x) * 180 / Math.PI; }
    item = buildShape().shapeType("RECTANGLE").width(L).height(W).position(lineCorner(o, ang, W)).rotation(ang);
  } else {
    const S = d.size * px;
    item = buildShape().shapeType("RECTANGLE").width(S).height(S).position({ x: o.x - S / 2, y: o.y - S / 2 });
  }
  const built = item.fillColor("#f09040").fillOpacity(0.18).strokeColor("#f09040").strokeOpacity(0.9).strokeWidth(Math.max(2, px * 0.4)).strokeDash([px * 1.2, px * 0.6])
    .layer("DRAWING").locked(false).name(`${meta[AOE].name} (${areaText(ar)})`).metadata(meta).build();
  await OBR.scene.items.addItems([built]);
  return built.id;
}
// the rectangle's corner so that its centre line starts at `o` and points along `ang`
function lineCorner(o, ang, W) { const a = ang * Math.PI / 180; return { x: o.x + Math.sin(a) * W / 2, y: o.y - Math.cos(a) * W / 2 }; }
async function aimTemplate(tplId, originId, aimId) {
  const [t] = await OBR.scene.items.getItems([tplId]); if (!t) return;
  const o = await centreOf(originId), a = await centreOf(aimId);
  const ang = Math.atan2(a.y - o.y, a.x - o.x) * 180 / Math.PI;
  const W = t.height * Math.abs(t.scale?.y || 1);
  await OBR.scene.items.updateItems([tplId], (ds) => { for (const x of ds) { x.rotation = ang; x.position = lineCorner(o, ang, W); } });
}
async function rotateTemplate(tplId, deg) {
  await OBR.scene.items.updateItems([tplId], (ds) => {
    for (const x of ds) {
      if (x.shapeType !== "RECTANGLE") continue;
      const W = x.height * Math.abs(x.scale?.y || 1), a0 = (x.rotation || 0) * Math.PI / 180;
      const start = { x: x.position.x - Math.sin(a0) * W / 2, y: x.position.y + Math.cos(a0) * W / 2 }; // centre-line start stays put
      x.rotation = deg; x.position = lineCorner(start, deg, W);
    }
  });
}
// Is any part of a combatant's token inside the template?
async function inTemplate(tplId, id) {
  const [t] = await OBR.scene.items.getItems([tplId]);
  if (!t) return false;
  let b; try { b = await OBR.scene.items.getItemBounds([id]); } catch (e) { return false; }
  return templateHits(t, b);
}
export function templateHits(t, b) {
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
  const sx = Math.abs(t.scale?.x || 1), sy = Math.abs(t.scale?.y || 1);
  if (t.shapeType === "CIRCLE") {
    const r = (t.width * sx) / 2;
    const nx = Math.max(b.min.x, Math.min(t.position.x, b.max.x)), ny = Math.max(b.min.y, Math.min(t.position.y, b.max.y));
    return Math.hypot(t.position.x - nx, t.position.y - ny) <= r + 0.5;
  }
  // rectangle (square or line): move the token centre into the template's own frame, then pad by half the token
  const a = -(t.rotation || 0) * Math.PI / 180;
  const dx = cx - t.position.x, dy = cy - t.position.y;
  const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
  const pad = Math.min(b.max.x - b.min.x, b.max.y - b.min.y) / 2;
  return lx >= -pad && lx <= t.width * sx + pad && ly >= -pad && ly <= t.height * sy + pad;
}
async function removeTemplate(tplId) { if (tplId) await OBR.scene.items.deleteItems([tplId]).catch(() => {}); }

async function distanceFeet(anchorId, id) {
  try {
    const [a, b] = await Promise.all([OBR.scene.items.getItemBounds([anchorId]), OBR.scene.items.getItemBounds([id])]);
    const cx = (a.min.x + a.max.x) / 2, cy = (a.min.y + a.max.y) / 2;
    const nx = Math.max(b.min.x, Math.min(cx, b.max.x)), ny = Math.max(b.min.y, Math.min(cy, b.max.y));
    return Math.hypot(cx - nx, cy - ny) / dpi * gridFeet;
  } catch (e) { return null; }
}

async function beginTurn() {
  const slot = activeSlot(); if (!slot) return;
  prompts = prompts.filter((p) => p.when !== "start");
  await processTurnPhase(slot, "start");
  view_.id = slot.ids[0]; tab = "turn";
  try { await OBR.player.select(slot.ids, true); } catch (e) {}
  say(`Round ${combat.round} · Turn ${combat.turn + 1}: ${slot.name}`);
}
let endPending = false;          // end-of-turn effects waiting for the GM before the next turn starts
async function endTurn() {
  const slot = activeSlot(); if (!slot) { say("Start combat first (Order tab)."); return; }
  if (endPending) { await advance(); return; }
  snapshot([...slot.ids, ...(combat.slots[(combat.turn + 1) % combat.slots.length]?.ids || [])], `End turn (${slot.name})`);
  prompts = [];
  await processTurnPhase(slot, "end");
  if (prompts.length) { endPending = true; tab = "turn"; view_.id = slot.ids[0]; render(); say("Resolve the end-of-turn effects, then press CONTINUE."); return; }
  await advance();
}
async function advance() {
  endPending = false; prompts = [];
  const nx = E.nextTurn({ round: combat.round, turn: combat.turn, order: combat.slots });
  combat.round = nx.round; combat.turn = nx.turn;
  if (nx.newRound) {
    const left = (combat.areas || []).map((a) => ({ ...a, rounds: a.rounds - 1 }));
    for (const a of left) if (a.rounds <= 0) { await removeTemplate(a.templateId); logLine(`${a.name} ended`); }
    combat.areas = left.filter((a) => a.rounds > 0);
    logLine(`— Round ${combat.round} —`);
  }
  await saveCombat();
  await beginTurn();
  render();
}
async function prevTurnFn() {
  if (!combat.active) return;
  const p = E.prevTurn({ round: combat.round, turn: combat.turn, order: combat.slots });
  combat.round = p.round; combat.turn = p.turn; await saveCombat();
  view_.id = activeSlot()?.ids[0]; say("Moved back one turn. Effects that already ran weren't reversed (use Undo for that).");
  render();
}

/* ======================= UI state ======================= */
let tab = "turn";
const view_ = { id: null };       // combatant shown on the Turn tab
let draft = null;                 // the attack being resolved
const TABS = [["turn", "Turn"], ["attack", "Attack"], ["order", "Order"], ["library", "Library"]];

/* ======================= Rendering ======================= */
let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(() => render(), 120); }
function render() {
  // keep focus and caret on re-render
  const a = document.activeElement, key = a && a.dataset && a.dataset.k, sel = key && a.selectionStart;
  renderHeader();
  const main = $("main"); main.textContent = "";
  if (!pack) main.append(noPackCard());
  if (tab === "turn") main.append(...turnTab());
  if (tab === "attack") main.append(...attackTab());
  if (tab === "order") main.append(...orderTab());
  if (tab === "library") main.append(...libraryTab());
  if (key) { const el = document.querySelector(`[data-k="${CSS.escape(key)}"]`); if (el) { el.focus(); try { if (sel !== null && sel !== undefined) el.setSelectionRange(sel, sel); } catch (e) {} } }
}
function renderHeader() {
  const slot = activeSlot();
  $("bRound").textContent = combat.active ? `ROUND ${combat.round}` : "NO COMBAT";
  $("bTurn").textContent = combat.active ? `TURN ${combat.turn + 1} — ${slot ? slot.name.toUpperCase() : "?"}` : (combat.slots.length ? "Press Start in the Order tab" : "Add combatants in the Order tab");
  $("endBtn").textContent = endPending ? "CONTINUE" : "END TURN";
  $("endBtn").disabled = !combat.active;
  $("prevBtn").disabled = !combat.active;
  const tabs = $("tabs"); tabs.textContent = "";
  for (const [k, t] of TABS) tabs.append(h("button", { class: tab === k ? "on" : "", role: "tab", "aria-selected": String(tab === k), onclick: () => { tab = k; render(); } }, t));
}
function noPackCard() {
  return h("div", { class: "warnbox" }, "No combat pack loaded in this browser. Open the Library tab and paste the pack from your vault (Combat Sheets → Combat Pack).");
}
const bar = (cur, max, cls = "") => h("div", { class: "bar " + cls }, h("i", { style: `width:${max ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0}%` }), h("span", {}, `${cur} / ${max}`));

/* ---------- Turn tab: the active (or chosen) combatant's full sheet ---------- */
function turnTab() {
  const out = [];
  const slot = activeSlot();
  if (!view_.id || !items.has(view_.id)) view_.id = slot ? slot.ids[0] : ([...items.keys()].find((id) => cbtOf(id)) || null);
  if (slot && slot.ids.length > 1) out.push(h("div", { class: "row" }, h("span", { class: "muted" }, "Acting together:"), ...slot.ids.map((id) => h("button", { class: "sm" + (id === view_.id ? " on" : ""), onclick: () => { view_.id = id; render(); } }, nameOf(id)))));
  if (prompts.length) out.push(promptsCard());
  if (!view_.id) { out.push(h("p", { class: "muted" }, "No combatant yet. Use the Order tab to add pieces from the map.")); return out; }
  out.push(...sheetView(view_.id, { full: true }));
  return out;
}

function promptsCard() {
  return h("div", { class: "card act" }, h("h2", {}, endPending ? "End of turn effects" : "Start of turn effects"),
    ...prompts.map((p) => {
      const box = h("div", { class: "prompt" }, h("b", {}, `${nameOf(p.id)} — ${p.name}`), p.text ? h("span", { class: "note" }, p.text) : null);
      if (p.kind === "area") {
        const a = p.area, v = view(p.id);
        const noSave = (a.save && (a.save.noSaveTags || []).some((t) => v.tags.includes(t)));
        const sv = p.saveExpr ?? (a.save ? `1d20+${saveBonus(v, a.save.attr)}` : "");
        box.append(h("div", { class: "small" }, `${(a.damage || []).map((d) => d.dice + " " + d.type).join(" + ")}${a.save ? ` · ${a.save.attr} DC ${a.save.dc}${a.save.half ? " half" : ""}${noSave ? " (no save for this target)" : ""}` : ""}`));
        const row = h("div", { class: "row" });
        if (a.save && !noSave) row.append(h("label", { class: "small" }, "Save "), h("input", { class: "dice", "data-k": "psave-" + p.key, value: sv, oninput: (e) => (p.saveExpr = e.target.value) }));
        row.append(h("button", { class: "go sm", onclick: () => resolveAreaPrompt(p, noSave) }, "Roll and apply"), h("button", { class: "sm", onclick: () => dropPrompt(p) }, "Skip"));
        box.append(row);
      } else {
        box.append(h("div", { class: "row" }, h("button", { class: "go sm", onclick: async () => { const log = []; snapshot([p.id], p.name); for (const op of p.ops) await applyOp(p.id, op, { log }); log.forEach(logLine); dropPrompt(p); say(log.join(" · ")); } }, "Apply"),
          h("button", { class: "sm", onclick: () => dropPrompt(p) }, "Skip")));
      }
      return box;
    }));
}
function dropPrompt(p) { prompts = prompts.filter((x) => x !== p); render(); }
async function resolveAreaPrompt(p, noSave) {
  const a = p.area, v = view(p.id);
  let mult = 1, saveTxt = "";
  try {
    if (a.save && !noSave) {
      const r = E.roll(p.saveExpr ?? `1d20+${saveBonus(v, a.save.attr)}`);
      const ok = r.total >= a.save.dc;
      mult = ok ? (a.save.half ? 0.5 : 0) : 1;
      saveTxt = `save ${r.text} vs DC ${a.save.dc}: ${ok ? "success" : "fail"}`;
    }
    const parts = E.rollDamageParts(a.damage || []).map((d) => ({ amount: Math.floor(d.amount * mult), type: d.type, magical: d.magical, roll: d.roll }));
    snapshot([p.id], a.name);
    const log = [];
    await dealDamage(p.id, parts, {}, { log, label: `${a.name} (${parts.map((q) => q.roll.text).join("; ")}${mult !== 1 ? ` ×${mult}` : ""})` });
    if (saveTxt) log.unshift(saveTxt);
    log.forEach(logLine); say(log.join(" · "));
    dropPrompt(p);
  } catch (e) { say(e.message); }
}

function sheetView(id, o = {}) {
  const v = view(id), s = v.sheet || {}, c = cbtOf(id) || {};
  const out = [];
  const head = h("div", { class: "card" + (activeSlot()?.ids.includes(id) ? " act" : "") });
  head.append(h("div", { class: "row", style: "justify-content:space-between" }, h("h3", {}, v.name),
    h("span", { class: "muted" }, s.name ? `${s.name}${s.level ? " · Level " + s.level : ""} · ${v.size}${s.kind ? " " + s.kind : ""}` : "No sheet (HP only)")));
  // HP
  const hpIn = h("input", { type: "number", "data-k": "hpd-" + id, placeholder: "±", "aria-label": "Change HP by" });
  head.append(h("div", { class: "row" }, h("b", { style: "width:26px" }, "HP"), bar(v.hp, v.maxHp),
    hpIn, h("button", { class: "sm", onclick: () => changeHp(id, -Math.abs(+hpIn.value || 0)) }, "−"), h("button", { class: "sm", onclick: () => changeHp(id, Math.abs(+hpIn.value || 0)) }, "+"),
    h("button", { class: "sm", title: "Set HP exactly", onclick: () => setHpExact(id, hpIn.value) }, "=")));
  // defence summary
  const ea = E.effectiveArmor(v);
  const def = [h("span", { class: "chip" }, "Armor ", h("b", {}, ea.armor + (v.armorMod ? ` (${v.armorMod > 0 ? "+" : ""}${v.armorMod} temp)` : "")))];
  const dr = Object.entries(v.dr).filter(([, n]) => n); if (dr.length) def.push(h("span", { class: "chip" }, "DR ", h("b", {}, dr.map(([k, n]) => `${k} −${n}`).join(" · "))));
  if (v.resist.length) def.push(h("span", { class: "chip good" }, "Resist ", v.resist.join(", ")));
  if (v.immune.length) def.push(h("span", { class: "chip good" }, "Immune ", v.immune.join(", ")));
  if (v.vuln.length) def.push(h("span", { class: "chip bad" }, "Vulnerable ", v.vuln.join(", ")));
  if (v.critReduce) def.push(h("span", { class: "chip" }, `Crits −${Math.round(v.critReduce * 100)}%`));
  if (s.init !== undefined) def.push(h("span", { class: "chip" }, "Init ", h("b", {}, (s.init >= 0 ? "+" : "") + s.init)));
  if (s.attacksPerAction) def.push(h("span", { class: "chip warn" }, `${s.attacksPerAction} attacks per Attack action`));
  head.append(h("div", { class: "row" }, def));
  if (s.speed) head.append(h("div", { class: "muted" }, "Speed: " + s.speed));
  // conditions
  const conds = c.conds || [];
  const condRow = h("div", { class: "row" }, ...conds.map((x) => h("span", { class: "chip vio" }, `${x.name}${x.count ? " ×" + x.count : ""}${x.rounds ? ` (${x.rounds}r)` : ""}`,
    h("button", { class: "sm", style: "padding:0 4px", "aria-label": "Remove " + x.name, onclick: () => writeCbt(id, (cc) => { cc.conds = (cc.conds || []).filter((q) => q !== cc.conds.find((z) => z.name === x.name)); }).then(render) }, "×"))));
  const condIn = h("input", { type: "text", "data-k": "cond-" + id, placeholder: "Add condition (e.g. Restrained 2)", style: "flex:1;min-width:120px" });
  condIn.onkeydown = (e) => { if (e.key === "Enter") { const m = condIn.value.trim().match(/^(.*?)(?:\s+(\d+))?$/); if (m && m[1]) applyOp(id, { op: "condition", name: m[1], rounds: m[2] ? +m[2] : null }, {}).then(render); } };
  condRow.append(condIn);
  head.append(condRow);
  // action economy (this turn)
  if (activeSlot()?.ids.includes(id)) {
    const ec = c.econ || {};
    const tog = (k, label) => h("button", { class: "sm" + (ec[k] ? " used" : ""), onclick: () => writeCbt(id, (cc) => { cc.econ = { ...(cc.econ || {}), [k]: !ec[k] }; }).then(render) }, label);
    head.append(h("div", { class: "row econ" }, tog("action", "Action"), tog("bonus", "Bonus"), tog("reaction", "Reaction"), tog("move", "Move"),
      s.attacksPerAction ? h("span", { class: "chip" }, `Attacks ${ec.attacks || 0}/${s.attacksPerAction}`) : null));
  }
  out.push(head);

  // pools
  if ((v.pools || []).length) {
    const pc = h("div", { class: "card" }, h("h2", {}, "Resources"));
    for (const p of v.pools) {
      const inp = h("input", { type: "number", "data-k": `pd-${id}-${p.id}`, placeholder: "±", "aria-label": `Change ${p.name} by` });
      const timer = (c.timers || []).find((t) => t.pool === p.id);
      pc.append(h("div", { class: "pool" }, h("span", { class: "nm", title: p.note || "" }, p.name, p.regen ? h("span", { class: "muted" }, ` +${p.regen.amount}/${p.regen.per}`) : null, timer ? h("span", { class: "muted" }, ` · ${timer.rounds}r left`) : null),
        bar(p.cur, p.max, p.absorb ? "abs" : "pool"),
        h("span", { class: "row", style: "gap:3px;flex-wrap:nowrap" }, inp, h("button", { class: "sm", onclick: () => changePool(id, p.id, -Math.abs(+inp.value || 0)) }, "−"), h("button", { class: "sm", onclick: () => changePool(id, p.id, Math.abs(+inp.value || 0)) }, "+"),
          h("button", { class: "sm", title: "Set exactly", onclick: () => changePool(id, p.id, null, inp.value) }, "="))));
    }
    out.push(pc);
  }
  // modes
  if ((s.modes || []).length) {
    const mc = h("div", { class: "card" }, h("h2", {}, "Modes and sustained systems"));
    for (const md of s.modes) {
      const on = !!(c.modes || {})[md.id];
      mc.append(h("div", { class: "row" }, h("button", { class: "sm" + (on ? " on" : ""), "aria-pressed": String(on), onclick: () => writeCbt(id, (cc) => { cc.modes = { ...(cc.modes || {}), [md.id]: !on }; }).then(render) }, on ? "ON" : "off"),
        h("span", {}, h("b", {}, md.name), md.armor ? ` · ${md.armor > 0 ? "+" : ""}${md.armor} Armor` : "", (md.upkeep || []).length ? h("span", { class: "muted" }, ` · upkeep ${md.upkeep.map((u) => `${u.amount}/${u.per} ${u.pool}`).join(", ")}`) : null),
        md.text ? h("div", { class: "note", style: "flex-basis:100%" }, md.text) : null));
    }
    out.push(mc);
  }
  // actions and reactions
  const actCard = (title, list, reaction) => {
    const cc = h("div", { class: "card" }, h("h2", {}, title));
    for (const a of list) cc.append(actionRow(id, a, reaction));
    return cc;
  };
  if ((s.actions || []).length) out.push(actCard("Actions", s.actions, false));
  out.push(actCard("Reactions", s.reactions || [], true));
  if (!(s.reactions || []).length) out[out.length - 1].append(h("span", { class: "muted" }, "No written reactions. Use a manual adjustment in the Attack tab's reaction window."));
  // effects
  out.push(effectsCard(id));
  // passives, equipment, sources, assumptions
  const pas = h("div", { class: "card" }, h("h2", {}, "Passives and traits"), ...(s.passives || []).map((p) => h("div", { class: "small" }, h("b", {}, p.name), p.text ? " — " + p.text : "")));
  if ((s.equipment || []).length) pas.append(h("div", { class: "small" }, h("b", {}, "Equipment: "), s.equipment.join(" · ")));
  if ((s.source || []).length) pas.append(h("div", { class: "muted" }, "From the vault: ", s.source.map((x) => `[[${x}]]`).join(" · ")));
  if ((s.assumptions || []).length) pas.append(h("div", { class: "warnbox" }, "Not in the vault yet (assumed): ", s.assumptions.join(" ")));
  out.push(pas);
  return out;
}

function actionRow(id, a, reaction) {
  const bits = actionBits(a);
  const row = h("div", { class: "col", style: "border-top:1px solid var(--line);padding-top:5px" },
    h("div", { class: "row", style: "justify-content:space-between" }, h("span", {}, h("b", {}, a.name), " ", h("span", { class: "tag" }, a.cost)),
      h("span", { class: "row" },
        (a.attack || a.save || a.area) && !reaction ? h("button", { class: "go sm", onclick: () => startAttack(id, a.id) }, a.area ? (a.area.rounds ? "Throw / place" : "Area attack") : "Attack") : null,
        !(a.attack || a.save || a.area) || reaction ? h("button", { class: "sm", onclick: () => useAction(id, a) }, "Use") : null)),
    h("div", { class: "small mono" }, bits.join(" · ")),
    a.text ? h("div", { class: "note" }, a.text) : null);
  return row;
}
function actionBits(a) {
  const bits = [];
  if (a.attack) bits.push(`+${a.attack.bonus} to hit`);
  if (a.save) bits.push(`${a.save.attr} DC ${a.save.dc}${a.save.half ? " half" : ""}`);
  if (a.damage) bits.push(a.damage.map((d) => `${d.dice} ${d.type}`).join(" + "));
  if (a.pen?.flat) bits.push(`ignores ${a.pen.flat} Armor`);
  if (a.pen?.pct) bits.push(`ignores ${a.pen.pct}% Armor`);
  if (a.pen?.stack) bits.push(`Armor Breaker +${a.pen.stack.per}/hit (max ${a.pen.stack.max})`);
  if (a.area) bits.push(`${areaText(a.area)}${a.area.rounds ? `, ${a.area.rounds} rounds` : ""}`);
  if (a.uses) bits.push(a.uses.map((u) => `${u.amount} ${u.pool}`).join(", "));
  if (a.attacks) bits.push(`up to ${a.attacks}/turn`);
  if (a.chain) bits.push(`chains up to ${a.chain.max}`);
  return bits;
}

function effectsCard(id) {
  const c = cbtOf(id) || {}, s = sheetOf(id) || {};
  const card = h("div", { class: "card" }, h("h2", {}, "Turn effects"));
  for (const e of s.turnEffects || []) card.append(h("div", { class: "small" }, h("span", { class: "tag" }, e.when), " ", h("b", {}, e.name), e.auto ? " (automatic)" : " (asks each turn)", e.text ? " — " + e.text : ""));
  for (const e of c.effects || []) card.append(h("div", { class: "row small" }, h("span", { class: "tag" }, e.when), h("b", {}, e.name), e.rounds ? h("span", { class: "muted" }, `${e.rounds} rounds left`) : null, e.auto ? "automatic" : "asks",
    h("span", { class: "mono" }, (e.ops || []).map(opText).join("; ")),
    h("button", { class: "sm danger", onclick: () => writeCbt(id, (cc) => { cc.effects = (cc.effects || []).filter((x) => x.key !== e.key); }).then(render) }, "Remove")));
  // add an effect
  const f = { when: "start", kind: "damage", value: "", type: "fire", rounds: "", auto: true, name: "" };
  const nm = h("input", { type: "text", placeholder: "Name (e.g. Burning)", "data-k": "fxn-" + id, style: "flex:1;min-width:110px" });
  const when = h("select", { "aria-label": "When" }, h("option", { value: "start" }, "Start of turn"), h("option", { value: "end" }, "End of turn"));
  const kind = h("select", { "aria-label": "Effect" }, ...[["damage", "Take damage"], ["heal", "Regain HP"], ["pool", "Change a pool"], ["note", "Reminder only"]].map(([k, t]) => h("option", { value: k }, t)));
  const val = h("input", { class: "dice", "data-k": "fxv-" + id, placeholder: "20, 2d6, or pool:amount" });
  const typ = h("input", { type: "text", placeholder: "fire", style: "width:80px", "data-k": "fxt-" + id });
  const rnd = h("input", { type: "number", placeholder: "rounds", "data-k": "fxr-" + id });
  const auto = h("input", { type: "checkbox", checked: true });
  card.append(h("details", {}, h("summary", {}, "Add an effect"), h("div", { class: "col", style: "margin-top:6px" },
    h("div", { class: "row" }, nm, when), h("div", { class: "row" }, kind, val, typ), h("div", { class: "row" }, rnd, h("label", { class: "small" }, auto, " apply automatically"),
      h("button", { class: "go sm", onclick: async () => {
        const ops = [];
        const k = kind.value, raw = val.value.trim();
        if (k === "damage") ops.push({ op: "damage", dice: raw || "0", type: typ.value.trim() || "force", name: nm.value.trim() });
        if (k === "heal") ops.push(/d/.test(raw) ? { op: "heal", dice: raw } : { op: "heal", amount: +raw || 0 });
        if (k === "pool") { const [p, amt] = raw.split(":"); ops.push({ op: "pool", pool: p.trim(), delta: +amt || 0 }); }
        if (k === "note") ops.push({ op: "note", text: raw || nm.value });
        const e = { key: uid(), name: nm.value.trim() || "Effect", when: when.value, ops, rounds: +rnd.value || null, auto: auto.checked };
        await writeCbt(id, (cc) => { cc.effects = [...(cc.effects || []), e]; }); render();
      } }, "Add")))));
  return card;
}
const opText = (o) => o.op === "damage" ? `${o.dice} ${o.type}` : o.op === "heal" ? `heal ${o.dice || o.amount}` : o.op === "pool" ? `${o.pool} ${o.delta > 0 ? "+" : ""}${o.delta}` : o.text || o.op;

async function changeHp(id, delta) {
  if (!delta) return; const v = view(id);
  snapshot([id], "HP change");
  const hp = Math.min(v.maxHp, v.hp + delta);
  await setPiece(id, { hp }); patchLocal(id, { hp }); logLine(`${v.name}: HP ${v.hp} → ${hp} (manual)`); render();
}
async function setHpExact(id, val) { if (val === "") return; const v = view(id); snapshot([id], "HP set"); await setPiece(id, { hp: +val }); patchLocal(id, { hp: +val }); logLine(`${v.name}: HP set to ${val}`); render(); }
async function changePool(id, poolId, delta, exact) {
  const v = view(id), p = v.pools.find((x) => x.id === poolId); if (!p) return;
  const next = exact !== undefined && exact !== "" ? +exact : p.cur + (delta || 0);
  if (next === p.cur) return;
  snapshot([id], `${p.name} change`);
  if ((v.sheet.pools || []).some((q) => q.id === poolId)) await writeCbt(id, (c) => setPoolIn(c, poolId, next, v.sheet));
  else await writeCbt(id, (c) => { c.tempPools = (c.tempPools || []).map((t) => (t.id === poolId ? { ...t, cur: Math.max(0, next) } : t)).filter((t) => t.cur > 0); });
  logLine(`${v.name}: ${p.name} ${p.cur} → ${next}`); render();
}
// Pay an action's costs from the combatant's own pools. Returns false (and says why) if a pool is short.
async function payCosts(id, a, times = 1) {
  const v = view(id);
  for (const u of a.uses || []) { const p = v.pools.find((x) => x.id === u.pool); if (p && p.cur < u.amount * times) { say(`${v.name}: not enough ${p.name} (${p.cur} < ${u.amount * times}).`, "WARNING"); return false; } }
  await writeCbt(id, (c) => {
    for (const u of a.uses || []) { const p = v.pools.find((x) => x.id === u.pool); if (p) setPoolIn(c, u.pool, p.cur - u.amount * times, v.sheet); }
    c.econ = c.econ || {};
    if (a.cost === "action") c.econ.action = true; if (a.cost === "bonus") c.econ.bonus = true; if (a.cost === "reaction") c.econ.reaction = true;
    if (a.cost === "attack") { c.econ.attacks = (c.econ.attacks || 0) + times; if (!c.econ.action) c.econ.action = true; }
  });
  return true;
}
async function useAction(id, a) {
  snapshot([id], a.name);
  if (!(await payCosts(id, a))) return;
  const log = [];
  for (const op of a.ops || []) {
    if (op.op === "adjust") { log.push(`${nameOf(id)}: ${a.name} — add it in the Attack tab's reaction window (${op.kind}${op.value ? " " + op.value : ""})`); continue; }
    await applyOp(id, op, { log });
  }
  log.unshift(`${nameOf(id)} used ${a.name}`); log.forEach(logLine); say(log.join(" · ")); render();
}

/* ======================= Attack tab ======================= */
function startAttack(attackerId, actionId) {
  draft = { key: uid(), attackerId, actionId: actionId || "custom", custom: { name: "Custom attack", bonus: 0, dice: "1d8", type: "bludgeoning", penFlat: 0, penPct: 0 },
    adv: "normal", cover: 0, accExtra: 0, ignoreShield: false, payCosts: true, paidOnce: false, targets: [], consecutive: {}, shared: null, sharedExprs: null, areaPlaced: false };
  tab = "attack"; render();
  const a = actionOf(draft);
  if (!(a && a.area)) addSelectedTargets(true);
}
function actionOf(d) {
  if (!d) return null;
  if (d.actionId === "custom") {
    const c = d.custom;
    return { id: "custom", name: c.name || "Custom attack", cost: "action", attack: { bonus: +c.bonus || 0 }, damage: [{ dice: c.dice || "0", type: c.type || "force" }], pen: { flat: +c.penFlat || 0, pct: +c.penPct || 0 }, tags: [] };
  }
  const s = sheetOf(d.attackerId) || {};
  return [...(s.actions || [])].find((a) => a.id === d.actionId) || null;
}
const perShot = (a) => a && (a.cost === "attack" || a.attacks);
function combatantIds() { return [...items.keys()].filter((id) => cbtOf(id)); }
async function addSelectedTargets(silent) {
  if (!draft) return;
  const sel = (await OBR.player.getSelection()) || [];
  let added = 0;
  for (const raw of sel) {
    let id = raw;
    if (!items.has(id)) { const [it] = await OBR.scene.items.getItems([raw]); id = it?.metadata?.[CHILD] || null; }
    if (!id || !items.has(id) || id === draft.attackerId) continue;
    addTarget(id); added++;
  }
  if (!silent && !added) say("Select target tokens on the map first (or pick one from the list).");
  render();
}
function addTarget(id, chain = 0) {
  const a = actionOf(draft);
  const te = { key: uid(), id, chain, adjs: [], extra: [], dmgExprs: (a?.damage || []).map((d) => d.dice), roll: null, res: null, dmg: null, preview: null, applied: false, saveExpr: null, save: null, redirectTo: "" };
  te.rollExpr = defaultRollExpr(te);
  draft.targets.push(te);
  return te;
}
function accuracyFor(te) {
  const a = actionOf(draft), tv = view(te.id);
  return { base: a?.attack?.bonus || 0, size: E.sizeAccuracy(tv.size), extra: +draft.accExtra || 0 };
}
function defaultRollExpr(te) {
  const acc = accuracyFor(te), b = acc.base + acc.size + acc.extra;
  const d = draft.adv === "adv" ? "2d20kh1" : draft.adv === "dis" ? "2d20kl1" : "1d20";
  return `${d}${b >= 0 ? "+" : ""}${b}`;
}
function penFor(te) {
  const a = actionOf(draft) || {};
  const pen = E.stackedPen({ ...(a.pen || {}) }, draft.consecutive[te.id] || 0);
  if (draft.ignoreShield) pen.ignoreTags = [...(pen.ignoreTags || []), "shield"];
  return pen;
}
function armorFor(te) {
  const f = E.foldAdjustments(te.adjs);
  return E.effectiveArmor(view(te.id), penFor(te), (+draft.cover || 0) + f.armor);
}
function shieldBypass() { const a = actionOf(draft) || {}; return (a.tags || []).includes("anti-mana") ? rules().bloomIgnores : []; }

async function rollAttackFor(te) {
  const a = actionOf(draft);
  try {
    if (draft.payCosts && a && (perShot(a) ? !te.paid : !draft.paidOnce)) {
      if (!(await payCosts(draft.attackerId, a))) return;
      if (perShot(a)) te.paid = true; else draft.paidOnce = true;
    }
    const r = E.roll(te.rollExpr);
    if (r.natural === null) say("This roll has no single d20, so natural 20/1 can't be read from it.", "WARNING");
    te.roll = r;
    const ai = armorFor(te);
    te.armorInfo = ai;
    te.res = E.resolveAttack(r, ai, { nat1: rules().nat1 });
    const f = E.foldAdjustments(te.adjs);
    if (f.miss) te.res = { ...te.res, hit: false, degree: "Dodged" };
    // consecutive hits (Armor Breaker)
    draft.consecutive[te.id] = te.res.hit ? (draft.consecutive[te.id] || 0) + 1 : 0;
    te.dmg = null; te.preview = null;
    logLine(`${nameOf(draft.attackerId)} → ${nameOf(te.id)}: ${a ? a.name : "attack"} ${r.text} vs Armor ${ai.armor}: ${te.res.hit ? (te.res.crit ? "CRITICAL HIT" : "hit") : "miss"}${te.res.nat1 ? " (natural 1)" : ""}`);
  } catch (e) { say(e.message); }
  render();
}
// Re-check the hit after a reaction changed Armor (the roll itself stays).
function recheck(te) {
  if (!te.roll) return;
  const ai = armorFor(te);
  te.armorInfo = ai;
  te.res = E.resolveAttack(te.roll, ai, { nat1: rules().nat1 });
  const f = E.foldAdjustments(te.adjs);
  if (f.miss) te.res = { ...te.res, hit: false, degree: "Dodged" };
  te.preview = te.dmg ? previewFor(te) : null;
}
function rollDamageFor(te) {
  const a = actionOf(draft) || {};
  try {
    const tv = view(te.id);
    const base = (a.damage || []).map((d, i) => ({ ...d, dice: te.dmgExprs[i] || d.dice }));
    const parts = [...base, ...te.extra.filter((x) => x.dice)];
    te.dmg = E.rollDamageParts(parts, { crit: !!te.res?.crit, critReduce: tv.critReduce });
    te.preview = previewFor(te);
  } catch (e) { say(e.message); }
  render();
}
function saveMult(te) {
  const a = actionOf(draft) || {};
  if (!a.save) return 1;
  if (!te.save) return null;
  return te.save.ok ? (a.save.half ? 0.5 : 0) : 1;
}
function packetFor(te) {
  const src = te.dmg || draft.shared;
  if (!src) return null;
  const m = saveMult(te) ?? 1;
  return src.map((d) => ({ amount: Math.floor(d.amount * m), type: d.type, magical: d.magical }));
}
function previewFor(te) {
  const packet = packetFor(te); if (!packet) return null;
  const f = E.foldAdjustments(te.adjs);
  const tid = f.redirect || te.redirectTo || te.id;
  const v = view(tid);
  if (f.absorb) v.pools = [...v.pools, { id: "tmp-" + te.key, name: "Reaction absorb", cur: f.absorb, max: f.absorb, absorb: { order: 0 } }];
  return E.applyDamage(v, packet, f, { order: rules().order, ignoreShieldTags: shieldBypass() });
}
async function applyFor(te) {
  const a = actionOf(draft) || {};
  const packet = packetFor(te); if (!packet) return;
  const f = E.foldAdjustments(te.adjs);
  const tid = f.redirect || te.redirectTo || te.id;
  snapshot([tid, te.id, draft.attackerId], `${a.name || "Attack"} on ${nameOf(tid)}`);
  if (f.absorb) await writeCbt(tid, (c) => { c.tempPools = [...(c.tempPools || []), { id: "tmp-" + te.key, name: "Reaction absorb", cur: f.absorb, max: f.absorb, absorb: { order: 0 } }]; });
  const log = [];
  const res = await dealDamage(tid, packet, f, { ignoreShieldTags: shieldBypass(), log, label: `${nameOf(draft.attackerId)}'s ${a.name || "attack"}${te.res?.crit ? " (critical)" : ""}` });
  for (const op of a.onHit || []) await applyOp(op.op === "selfPool" ? draft.attackerId : tid, op, { attackerId: draft.attackerId, damageDealt: res.totalAfterDefenses, log });
  if (f.notes.length) log.push("Reaction: " + f.notes.join(", "));
  te.applied = true; te.appliedLog = log;
  log.forEach(logLine); say(log[0] || "Applied.");
  render();
}
async function useReaction(te, r) {
  // the target's written reaction: pay it from the target's pools, then fold its effect into this attack
  if (!(await payCosts(te.id, r))) return;
  const log = [];
  for (const op of r.ops || []) {
    if (op.op === "adjust") te.adjs.push({ kind: op.kind, value: op.value, from: r.name });
    else await applyOp(te.id, op, { log });
  }
  log.unshift(`${nameOf(te.id)} reacts: ${r.name}`); log.forEach(logLine);
  recheck(te); say(log.join(" · ")); render();
}

function attackTab() {
  const out = [];
  const ids = combatantIds();
  if (!ids.length) { out.push(h("p", { class: "muted" }, "Add combatants in the Order tab first.")); return out; }
  if (!draft) {
    const slot = activeSlot();
    out.push(h("div", { class: "card" }, h("p", { class: "note", style: "margin:0" }, "Pick an attack from a combatant's sheet (Turn tab → Attack), or start one here."),
      h("button", { class: "go", onclick: () => startAttack(slot ? slot.ids[0] : ids[0], null) }, "New attack")));
    out.push(logCard());
    return out;
  }
  const d = draft, a = actionOf(d), s = sheetOf(d.attackerId) || {};
  const acts = (s.actions || []).filter((x) => x.attack || x.save || x.area);
  const card = h("div", { class: "card act" }, h("h2", {}, "Attack"));
  card.append(h("div", { class: "row" }, h("label", { class: "small" }, "Attacker "),
    h("select", { onchange: (e) => { startAttack(e.target.value, null); } }, ...ids.map((id) => h("option", { value: id, selected: id === d.attackerId }, nameOf(id))))));
  card.append(h("div", { class: "row" }, h("label", { class: "small" }, "Using "),
    h("select", { style: "flex:1", onchange: (e) => { const t = d.targets.map((x) => x.id); startAttack(d.attackerId, e.target.value); t.forEach((id) => addTarget(id)); render(); } },
      ...acts.map((x) => h("option", { value: x.id, selected: x.id === d.actionId }, `${x.name} (${x.cost})`)), h("option", { value: "custom", selected: d.actionId === "custom" }, "Custom attack…"))));
  if (d.actionId === "custom") {
    const c = d.custom;
    const inp = (k, ph, w = "90px", cls = "") => h("input", { class: cls, "data-k": "cu-" + k, value: c[k], placeholder: ph, style: `width:${w}`, oninput: (e) => { c[k] = e.target.value; d.targets.forEach((t) => { if (!t.roll) t.rollExpr = defaultRollExpr(t); t.dmgExprs = [c.dice]; }); } });
    card.append(h("div", { class: "row" }, inp("name", "Name", "140px"), h("span", { class: "small" }, "to hit"), inp("bonus", "+0", "54px")));
    card.append(h("div", { class: "row" }, h("span", { class: "small" }, "damage"), inp("dice", "2d8+4", "110px", "dice"), inp("type", "type", "90px"), h("span", { class: "small" }, "ignores"), inp("penFlat", "0", "46px"), h("span", { class: "small" }, "Armor +"), inp("penPct", "0", "46px"), h("span", { class: "small" }, "%")));
  } else if (a) {
    card.append(h("div", { class: "small mono" }, actionBits(a).join(" · ")));
    if (a.text) card.append(h("div", { class: "note" }, a.text));
    if (a.attack?.build) card.append(h("div", { class: "muted" }, "To hit: " + a.attack.build));
  }
  const reflow = () => { d.targets.forEach((t) => { if (!t.roll) t.rollExpr = defaultRollExpr(t); else recheck(t); }); render(); };
  card.append(h("div", { class: "row" },
    h("select", { "aria-label": "Advantage", onchange: (e) => { d.adv = e.target.value; reflow(); } }, ...[["normal", "Normal roll"], ["adv", "Advantage"], ["dis", "Disadvantage"]].map(([k, t]) => h("option", { value: k, selected: d.adv === k }, t))),
    h("select", { "aria-label": "Cover", onchange: (e) => { d.cover = +e.target.value; reflow(); } }, ...[[0, "No cover"], [2, "Half cover +2"], [5, "¾ cover +5"]].map(([k, t]) => h("option", { value: k, selected: d.cover === k }, t))),
    h("label", { class: "small" }, "Extra accuracy ", h("input", { type: "number", "data-k": "accx", value: d.accExtra, style: "width:54px", oninput: (e) => { d.accExtra = +e.target.value || 0; d.targets.forEach((t) => { if (!t.roll) t.rollExpr = defaultRollExpr(t); }); } }))));
  card.append(h("div", { class: "row small" },
    h("label", {}, h("input", { type: "checkbox", checked: d.ignoreShield, onchange: (e) => { d.ignoreShield = e.target.checked; reflow(); } }), " Ignore shield Armor (attack from behind or the side)"),
    h("label", {}, h("input", { type: "checkbox", checked: d.payCosts, onchange: (e) => { d.payCosts = e.target.checked; } }), " Pay costs")));
  if (a?.area) card.append(areaControls(a));
  out.push(card);

  // shared damage for save-based actions
  if (a?.save && !a.attack) {
    const sc = h("div", { class: "card" }, h("h2", {}, "Damage (rolled once for every target)"));
    d.sharedExprs = d.sharedExprs || (a.damage || []).map((x) => x.dice);
    sc.append(...(a.damage || []).map((x, i) => h("div", { class: "row" }, h("input", { class: "dice", "data-k": "sd-" + i, value: d.sharedExprs[i], oninput: (e) => (d.sharedExprs[i] = e.target.value) }), h("span", { class: "small" }, x.type))));
    sc.append(h("button", { class: "go sm", onclick: async () => {
      try {
        if (d.payCosts && !d.paidOnce) { if (!(await payCosts(d.attackerId, a))) return; d.paidOnce = true; }
        d.shared = E.rollDamageParts((a.damage || []).map((x, i) => ({ ...x, dice: d.sharedExprs[i] || x.dice })));
        d.targets.forEach((t) => (t.preview = previewFor(t))); render();
      } catch (e) { say(e.message); }
    } }, "Roll damage"));
    if (d.shared) sc.append(h("div", { class: "res mono" }, d.shared.map((p) => `${p.roll.text} ${p.type}`).join("\n")));
    out.push(sc);
  }

  // targets
  const tc = h("div", { class: "card" }, h("h2", {}, "Targets"));
  const pick = h("select", { "aria-label": "Add a target" }, h("option", { value: "" }, "Add a target…"), ...ids.filter((id) => id !== d.attackerId).map((id) => h("option", { value: id }, nameOf(id))));
  pick.onchange = () => { if (pick.value) { addTarget(pick.value); render(); } };
  tc.append(h("div", { class: "row" }, h("button", { class: "sm", onclick: () => addSelectedTargets(false) }, "Add selected tokens"), pick,
    h("button", { class: "sm", onclick: async () => { if (draft.tplId && !draft.areaPlaced) await removeTemplate(draft.tplId); draft = null; render(); } }, "Done / clear")));
  out.push(tc);
  for (const te of d.targets) out.push(targetCard(te, a));
  out.push(logCard());
  return out;
}

function areaControls(a) {
  const ar = a.area, d = areaDims(ar);
  const persistent = !!ar.rounds;
  const what = persistent
    ? `${areaText(ar)} for ${ar.rounds} rounds: ${(ar.damage || a.damage || []).map((x) => x.dice + " " + x.type).join(" + ")} to anything starting its turn inside${ar.save ? ` (${ar.save.attr} DC ${ar.save.dc}${ar.save.half ? " half" : ""})` : ""}`
    : `${areaText(ar)}: everything in it makes the save`;
  const box = h("div", { class: "prompt" }, h("b", {}, `Area — ${what}`));
  if (!draft.tplId) {
    box.append(h("div", { class: "note" }, d.shape === "line" ? "The line starts at the caster. Select a token first to aim it at that token, or aim it afterwards." : "The template appears on the caster. Drag it on the map to where it should be."));
    box.append(h("div", { class: "row" }, h("button", { class: "go sm", onclick: async () => {
      try {
        if (draft.payCosts && !draft.paidOnce) { if (!(await payCosts(draft.attackerId, a))) return; draft.paidOnce = true; }
        const sel = ((await OBR.player.getSelection()) || []).filter((x) => x !== draft.attackerId);
        draft.tplId = await placeTemplate(ar, draft.attackerId, d.shape === "line" ? sel[0] : null, a.name);
        logLine(`${nameOf(draft.attackerId)}: ${a.name} template placed (${areaText(ar)})`);
        render();
      } catch (e) { say("Couldn't place the template: " + e.message, "ERROR"); }
    } }, "Place template")));
    return box;
  }
  const rot = h("input", { type: "number", "data-k": "tplrot", placeholder: "°", style: "width:64px", "aria-label": "Rotation in degrees" });
  const row = h("div", { class: "row" });
  if (d.shape !== "circle") row.append(
    h("button", { class: "sm", onclick: async () => { const sel = ((await OBR.player.getSelection()) || []).filter((x) => x !== draft.tplId && x !== draft.attackerId); if (!sel.length) { say("Select the token to aim at first."); return; } await aimTemplate(draft.tplId, draft.attackerId, sel[0]); say("Aimed."); } }, "Aim at selected token"),
    rot, h("button", { class: "sm", onclick: async () => { if (rot.value !== "") { await rotateTemplate(draft.tplId, +rot.value); } } }, "Rotate to °"));
  box.append(h("div", { class: "note" }, "Drag or rotate the orange template on the map, then:"), row);
  const act = h("div", { class: "row" });
  if (persistent) {
    act.append(h("button", { class: "primary sm", disabled: draft.areaPlaced, onclick: async () => {
      combat.areas = [...(combat.areas || []), { id: uid(), name: ar.name || a.name, templateId: draft.tplId, anchorId: draft.tplId, radius: d.radius, rounds: ar.rounds, trigger: ar.trigger || "start", damage: ar.damage || a.damage, save: ar.save || a.save, ownerId: draft.attackerId }];
      await saveCombat(); draft.areaPlaced = true; logLine(`${ar.name || a.name} is active (${areaText(ar)}, ${ar.rounds} rounds)`); say("Area confirmed. Anything starting its turn inside gets a prompt."); render();
    } }, draft.areaPlaced ? "Area active" : `Confirm area (${ar.rounds} rounds)`));
  } else {
    const allies = h("input", { type: "checkbox", checked: true });
    act.append(h("button", { class: "go sm", onclick: async () => {
      let n = 0;
      for (const id of combatantIds()) {
        if (id === draft.attackerId || draft.targets.some((t) => t.id === id)) continue;
        if (draft.noAllies && !!sheetOf(id)?.pc === !!sheetOf(draft.attackerId)?.pc) continue;
        if (await inTemplate(draft.tplId, id)) { addTarget(id); n++; }
      }
      say(n ? `${n} target${n === 1 ? "" : "s"} in the area.` : "Nobody new is inside the template."); render();
    } }, "Find targets in template"), h("label", { class: "small" }, allies, " friendly fire (allies count too)"));
    allies.onchange = () => { draft.noAllies = !allies.checked; };
  }
  act.append(h("button", { class: "sm danger", onclick: async () => { const tid = draft.tplId; draft.tplId = null; draft.areaPlaced = false; combat.areas = (combat.areas || []).filter((x) => x.templateId !== tid); await saveCombat(); await removeTemplate(tid); render(); } }, "Remove template"));
  box.append(act);
  return box;
}

function targetCard(te, a) {
  const v = view(te.id);
  const card = h("div", { class: "card tgt" });
  card.append(h("div", { class: "row", style: "justify-content:space-between" }, h("h3", {}, nameOf(te.id), te.chain ? h("span", { class: "tag" }, ` chain ${te.chain + 1}`) : null),
    h("span", { class: "row" }, h("span", { class: "chip" }, "HP ", h("b", {}, `${v.hp}/${v.maxHp}`)),
      h("button", { class: "sm", onclick: () => { view_.id = te.id; tab = "turn"; render(); } }, "Open sheet"),
      h("button", { class: "sm", "aria-label": "Remove target", onclick: () => { draft.targets = draft.targets.filter((x) => x !== te); render(); } }, "✕"))));
  const acc = accuracyFor(te);
  const ai = armorFor(te);
  const info = [`Armor ${ai.before}${ai.cut ? ` − ${ai.cut} penetration = ${ai.armor}` : ""}${ai.ignoredParts.length ? ` (ignoring ${ai.ignoredParts.join(", ")})` : ""}`];
  if (acc.size) info.push(`${v.size} target: ${acc.size > 0 ? "+" : ""}${acc.size} Accuracy (in the roll)`);
  if (a?.attack) card.append(h("div", { class: "muted" }, info.join(" · ")));

  // 1) attack roll or save
  if (a?.attack) {
    const inp = h("input", { class: "dice", "data-k": "roll-" + te.key, value: te.rollExpr, "aria-label": "Attack roll", oninput: (e) => (te.rollExpr = e.target.value) });
    inp.onkeydown = (e) => { if (e.key === "Enter") rollAttackFor(te); };
    card.append(h("div", { class: "row" }, h("label", { class: "small" }, "Attack roll"), inp, h("button", { class: "go sm", onclick: () => rollAttackFor(te) }, te.roll ? "Re-roll" : "Roll"),
      h("span", { class: "muted" }, "Type 1d20(15)+17 for a die rolled at the table.")));
    if (te.res) {
      const r = te.res;
      const cls = r.crit ? "crit" : r.hit ? "hit" : "miss";
      card.append(h("div", { class: "res " + cls },
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", { class: "big " + cls }, r.crit ? "CRITICAL HIT" : r.hit ? "HIT" : (r.degree === "Dodged" ? "DODGED" : "MISS")),
          h("span", { class: "small" }, `${r.degree}${r.nat20 ? " · NATURAL 20" : ""}${r.nat1 ? " · NATURAL 1" : ""}`)),
        h("div", { class: "mono small" }, `Die ${r.natural ?? "?"}${te.roll.allManual ? " (entered)" : te.roll.manual ? " (partly entered)" : " (rolled)"} · modifiers ${te.roll.total - (r.natural ?? 0) >= 0 ? "+" : ""}${te.roll.total - (r.natural ?? 0)} · total ${r.total} vs Armor ${r.armor} (margin ${r.margin >= 0 ? "+" : ""}${r.margin})`),
        h("div", { class: "mono small muted" }, te.roll.text + (te.roll.manual ? "   (* = entered at the table)" : "")),
        r.nat1 ? h("div", { class: "small" }, rules().nat1 === "degree" ? "Natural 1: result lowered one degree. Add a complication if you want." : "Natural 1 flagged.") : null,
        r.nat20 ? h("div", { class: "small" }, "Natural 20: hits whatever the Armor, and damage dice are rolled twice (flat bonuses once).") : null));
    }
  } else if (a?.save) {
    const noSave = (a.save.noSaveTags || []).some((t) => v.tags.includes(t));
    te.saveExpr = te.saveExpr ?? `1d20+${saveBonus(v, a.save.attr)}`;
    if (noSave) { te.save = te.save || { ok: false, text: "no save" }; card.append(h("div", { class: "small" }, "This target gets no save.")); }
    else {
      const inp = h("input", { class: "dice", "data-k": "save-" + te.key, value: te.saveExpr, oninput: (e) => (te.saveExpr = e.target.value) });
      card.append(h("div", { class: "row" }, h("label", { class: "small" }, `${a.save.attr} save vs DC ${a.save.dc}`), inp, h("button", { class: "go sm", onclick: () => { try { const r = E.roll(te.saveExpr); te.save = { ok: r.total >= a.save.dc, text: r.text, nat: r.natural }; te.preview = previewFor(te); render(); } catch (e) { say(e.message); } } }, "Roll save")));
      if (te.save) card.append(h("div", { class: "res " + (te.save.ok ? "miss" : "hit") }, h("b", {}, te.save.ok ? `SAVED${a.save.half ? " (half damage)" : " (no damage)"}` : "FAILED"), h("div", { class: "mono small" }, te.save.text)));
    }
  }

  const hit = a?.attack ? (te.res?.hit || (te.res && te.adjs.length > 0)) : (a?.save ? !!te.save : false);
  if (!hit) {
    if (te.res && !te.res.hit && a?.chain && te.chain > 0) card.append(h("div", { class: "muted" }, "The chain ends on a miss."));
    return card;
  }

  // 2) reaction window
  const rw = h("div", { class: "prompt" }, h("b", {}, `Reaction window — ${nameOf(te.id)}`));
  const ec = (cbtOf(te.id) || {}).econ || {};
  if (ec.reaction) rw.append(h("div", { class: "small", style: "color:var(--orange)" }, "Reaction already used this round (you can still apply one)."));
  const reacts = (v.sheet.reactions || []);
  if (reacts.length) rw.append(h("div", { class: "row" }, ...reacts.map((r) => h("button", { class: "sm", title: r.text || "", onclick: () => useReaction(te, r) }, `${r.name}${r.uses ? ` (${r.uses.map((u) => u.amount + " " + u.pool).join(", ")})` : ""}`))));
  else rw.append(h("div", { class: "muted" }, "No written reactions on this sheet."));
  const kind = h("select", { "aria-label": "Adjustment" }, ...E.ADJUST_KINDS.map((k) => h("option", { value: k.id }, k.label)));
  const val = h("input", { type: "number", placeholder: "X", "data-k": "adjv-" + te.key, style: "width:60px" });
  const quick = h("input", { type: "text", placeholder: "or type: +10 Armor · Negate 50% Damage · Reduce Damage by 25", "data-k": "adjq-" + te.key, style: "flex:1;min-width:180px" });
  const redirect = h("select", { "aria-label": "Redirect to" }, h("option", { value: "" }, "to…"), ...combatantIds().filter((x) => x !== te.id).map((x) => h("option", { value: x }, nameOf(x))));
  const addAdj = (adj) => { if (!adj) return; te.adjs.push(adj); recheck(te); logLine(`${nameOf(te.id)} reaction: ${adjText(adj)}`); render(); };
  quick.onkeydown = (e) => { if (e.key === "Enter") addAdj(E.parseAdjustment(quick.value)); };
  rw.append(h("div", { class: "row" }, kind, val, redirect, h("button", { class: "sm", onclick: () => {
    const k = kind.value;
    if (k === "redirect") { if (!redirect.value) { say("Pick who takes the damage."); return; } addAdj({ kind: "redirect", to: redirect.value }); return; }
    if (k === "block") { addAdj({ kind: "reduceFlat", value: +val.value || 0, label: "Block" }); return; }
    if (k === "custom") { addAdj({ kind: "custom", text: quick.value || "Custom reaction" }); return; }
    addAdj({ kind: k, value: +val.value || 0 });
  } }, "Add")));
  rw.append(h("div", { class: "row" }, quick, h("button", { class: "sm", onclick: () => addAdj(E.parseAdjustment(quick.value)) }, "Add")));
  if (te.adjs.length) rw.append(h("div", { class: "row" }, ...te.adjs.map((x, i) => h("span", { class: "chip warn" }, adjText(x), h("button", { class: "sm", style: "padding:0 4px", "aria-label": "Remove adjustment", onclick: () => { te.adjs.splice(i, 1); recheck(te); render(); } }, "×")))));
  if (E.foldAdjustments(te.adjs).rerollDis) rw.append(h("div", { class: "small" }, "Re-roll the attack with disadvantage: set the roll to 2d20kl1… and press Re-roll."));
  card.append(rw);
  if (a?.attack && !te.res.hit) return card;

  // 3) damage
  const dm = h("div", { class: "col" }, h("h2", {}, te.res?.crit ? "Damage — critical: dice rolled twice" : "Damage"));
  if (!(a?.save && !a.attack)) {
    (a?.damage || []).forEach((dd, i) => dm.append(h("div", { class: "row" }, h("input", { class: "dice", "data-k": `dx-${te.key}-${i}`, value: te.dmgExprs[i] ?? dd.dice, oninput: (e) => (te.dmgExprs[i] = e.target.value) }), h("span", { class: "small" }, dd.type))));
    te.extra.forEach((x, i) => dm.append(h("div", { class: "row" }, h("input", { class: "dice", "data-k": `ex-${te.key}-${i}`, value: x.dice, placeholder: "2d12", oninput: (e) => (x.dice = e.target.value) }),
      h("input", { type: "text", value: x.type, style: "width:90px", "data-k": `et-${te.key}-${i}`, oninput: (e) => (x.type = e.target.value) }), h("button", { class: "sm", onclick: () => { te.extra.splice(i, 1); render(); } }, "✕"))));
    dm.append(h("div", { class: "row" }, h("button", { class: "sm", onclick: () => { te.extra.push({ dice: "", type: "fire" }); render(); } }, "+ extra damage (e.g. Heat Charges +2d12 fire)"),
      h("button", { class: "go sm", onclick: () => rollDamageFor(te) }, te.dmg ? "Re-roll damage" : "Roll damage")));
    if (te.res?.crit) dm.append(h("div", { class: "muted" }, `Entering dice by hand on a crit: give the normal number of results (the extra set is rolled) or twice as many.${v.critReduce ? ` ${v.name} reduces critical bonus damage by ${Math.round(v.critReduce * 100)}%.` : ""}`));
    if (te.dmg) dm.append(h("div", { class: "res mono small" }, te.dmg.map((p) => `${p.roll.text} ${p.type}`).join("\n")));
  }
  if (te.preview) {
    const p = te.preview;
    dm.append(h("div", { class: "res" }, h("b", {}, `After defences: ${p.totalAfterDefenses} (${p.toHp} to HP)`), h("div", { class: "log" }, p.log.join("\n") || "No reductions.")));
    dm.append(h("div", { class: "row" }, h("button", { class: "primary", disabled: te.applied, onclick: () => applyFor(te) }, te.applied ? "Applied" : "Apply damage"),
      te.applied && a?.chain && te.chain + 1 < a.chain.max ? h("button", { class: "go sm", onclick: () => { const n = addTarget(te.id, te.chain + 1); render(); } }, `Chain: attack again (${te.chain + 2}/${a.chain.max})`) : null));
    if (te.applied && te.appliedLog) dm.append(h("div", { class: "log" }, te.appliedLog.join("\n")));
  }
  card.append(dm);
  return card;
}
function adjText(x) {
  switch (x.kind) {
    case "armor": return `${x.value >= 0 ? "+" : ""}${x.value} Armor${x.from ? " (" + x.from + ")" : ""}`;
    case "reduceFlat": return `${x.label || "Reduce"} ${x.value}`;
    case "reducePct": return `Reduce ${x.value}%`;
    case "negate": return "Negate all";
    case "negatePct": return `Negate ${x.value}%`;
    case "absorb": return `Absorb ${x.value}`;
    case "redirect": return `Redirect to ${nameOf(x.to)}`;
    case "dodge": return "Dodge"; case "escape": return "Escape";
    case "disadvantage": return "Disadvantage re-roll";
    default: return x.text || x.kind;
  }
}
function logCard() {
  return h("div", { class: "card" }, h("div", { class: "row", style: "justify-content:space-between" }, h("h2", {}, "Combat log"),
    h("button", { class: "sm", disabled: !undoStack.length, onclick: async () => { await undo(); await readScene(); render(); } }, `Undo${undoStack.length ? ": " + undoStack[undoStack.length - 1].label : ""}`)),
    h("div", { class: "log" }, turnLog.slice(-40).reverse().join("\n") || "Nothing yet."));
}

/* ======================= Order tab ======================= */
let pending = [];   // tokens being added: [{id, name, sheet}]
function slotInit(slot) { return slot.init ?? null; }
function sortSlots() {
  if (combat.mode !== "init") return;
  const cur = activeSlot();
  const sorted = E.sortInitiative(combat.slots.map((s) => ({ ...s, init: s.init, dex: (sheetOf(s.ids[0])?.attrs || {}).DEX ?? 0, pc: !!sheetOf(s.ids[0])?.pc })));
  combat.slots = sorted.map(({ dex, pc, ...s }) => s);
  if (cur) combat.turn = Math.max(0, combat.slots.findIndex((s) => s.key === cur.key));
}
function orderTab() {
  const out = [];
  // controls
  const ctl = h("div", { class: "card act" }, h("h2", {}, "Combat"));
  ctl.append(h("div", { class: "row" },
    !combat.active ? h("button", { class: "primary", disabled: !combat.slots.length, onclick: startCombat }, "Start combat") : h("button", { class: "danger", onclick: endCombat }, "End combat"),
    h("span", { class: "small" }, "Turn order:"),
    h("button", { class: "sm" + (combat.mode === "manual" ? " on" : ""), onclick: async () => { combat.mode = "manual"; await saveCombat(); render(); } }, "Manual"),
    h("button", { class: "sm" + (combat.mode === "init" ? " on" : ""), onclick: async () => { combat.mode = "init"; sortSlots(); await saveCombat(); render(); } }, "Initiative")));
  if (combat.mode === "init") ctl.append(h("div", { class: "row" }, h("button", { class: "go sm", onclick: rollAllInit }, "Roll initiative for everyone without a result"),
    h("span", { class: "muted" }, "Or type a result per row: 18, or 1d20(14)+8 for a die rolled at the table.")));
  else ctl.append(h("div", { class: "muted" }, "Manual order: use ▲▼ to arrange. Switch to Initiative to sort by results."));
  out.push(ctl);
  // order list
  const oc = h("div", { class: "card" }, h("h2", {}, `Order (${combat.slots.length})`));
  const ul = h("ul", { class: "order" });
  combat.slots.forEach((s, i) => {
    const cur = combat.active && i === combat.turn;
    const initIn = h("input", { class: "dice", style: "width:90px", "data-k": "init-" + s.key, value: s.initText ?? (s.init ?? ""), placeholder: combat.mode === "init" ? "roll" : "", "aria-label": `Initiative for ${s.name}` });
    initIn.onchange = async () => { await setInit(s, initIn.value); };
    ul.append(h("li", { class: cur ? "cur" : "" }, h("span", { class: "small" }, cur ? "▶" : String(i + 1)),
      h("button", { class: "sm", style: "text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", onclick: () => { view_.id = s.ids[0]; tab = "turn"; render(); } }, s.name + (s.ids.length > 1 ? ` (${s.ids.length})` : "")),
      initIn,
      h("span", { class: "row", style: "gap:2px;flex-wrap:nowrap" },
        combat.mode === "manual" ? h("button", { class: "sm", "aria-label": "Move up", disabled: i === 0, onclick: () => moveSlot(i, -1) }, "▲") : null,
        combat.mode === "manual" ? h("button", { class: "sm", "aria-label": "Move down", disabled: i === combat.slots.length - 1, onclick: () => moveSlot(i, 1) }, "▼") : null,
        h("button", { class: "sm danger", "aria-label": "Remove from combat", onclick: () => removeSlot(i) }, "✕"))));
  });
  oc.append(ul);
  if (!combat.slots.length) oc.append(h("p", { class: "muted" }, "Nobody yet. Select tokens on the map and press Add selected tokens."));
  out.push(oc);
  // adding
  const ac = h("div", { class: "card" }, h("h2", {}, "Add combatants"));
  ac.append(h("div", { class: "row" }, h("button", { class: "go sm", onclick: pickPending }, "Add selected tokens"), h("span", { class: "muted" }, "Any token works; pieces the loader built keep their HP labels and conditions.")));
  for (const p of pending) {
    const sel = h("select", { "aria-label": `Sheet for ${p.name}`, onchange: (e) => (p.sheet = e.target.value) }, h("option", { value: "" }, "No sheet (HP only)"), ...Object.values(sheets).map((s) => h("option", { value: s.id, selected: p.sheet === s.id }, s.name)));
    ac.append(h("div", { class: "row" }, h("b", { style: "min-width:90px" }, p.name), sel, h("button", { class: "sm", onclick: () => { pending = pending.filter((x) => x !== p); render(); } }, "✕")));
  }
  if (pending.length) ac.append(h("div", { class: "row" }, h("label", { class: "small" }, h("input", { type: "checkbox", id: "grp", checked: true }), " Sheets with a group (the Bloom, the drones) share one turn"),
    h("button", { class: "primary", onclick: commitPending }, `Add ${pending.length}`)));
  out.push(ac);
  // areas
  const arc = h("div", { class: "card" }, h("h2", {}, "Areas on the map"));
  if (!(combat.areas || []).length) arc.append(h("span", { class: "muted" }, "None. Throwing a grenade (Attack tab) places one."));
  for (const a of combat.areas || []) arc.append(h("div", { class: "row small" }, h("b", {}, a.name), `${a.rounds} rounds left`,
    h("button", { class: "sm", onclick: async () => { a.rounds += 1; await saveCombat(); render(); } }, "+1"), h("button", { class: "sm danger", onclick: async () => { combat.areas = combat.areas.filter((x) => x !== a); await saveCombat(); await removeTemplate(a.templateId); render(); } }, "Remove")));
  out.push(arc);
  return out;
}
async function pickPending() {
  const sel = (await OBR.player.getSelection()) || [];
  if (!sel.length) { say("Select one or more tokens on the map first."); return; }
  const its = await OBR.scene.items.getItems(sel);
  for (const it of its) {
    let id = it.id;
    if (!it.metadata?.[OBJ] && it.metadata?.[CHILD]) id = it.metadata[CHILD];
    if (pending.some((p) => p.id === id) || combat.slots.some((s) => s.ids.includes(id))) continue;
    if (!items.has(id)) id = await adopt(it);
    if (!id) continue;
    pending.push({ id, name: nameOf(id), sheet: guessSheet(id) });
  }
  render();
}
// Give a token that the loader didn't build the metadata the combat system uses (its image stays as it is).
async function adopt(it) {
  try {
    const b = await OBR.scene.items.getItemBounds([it.id]);
    const w = Math.max(0.5, Math.round(((b.max.x - b.min.x) / dpi) * 2) / 2), hgt = Math.max(0.5, Math.round(((b.max.y - b.min.y) / dpi) * 2) / 2);
    const m = { id: "t-" + it.id.slice(0, 6), type: "token", label: it.name || "Token", w, h: hgt, hp: null, maxHp: null, dead: false, notes: "", hpVis: "gm", hpPlayers: [], shown: "", img: null, noImg: true, imgData: null, adopted: true,
      ibs: it.type === "IMAGE" ? { x: Math.abs(it.scale?.x || 1), y: Math.abs(it.scale?.y || 1) } : null };
    await OBR.scene.items.updateItems([it.id], (ds) => { for (const d of ds) d.metadata[OBJ] = m; });
    await readScene();
    return it.id;
  } catch (e) { say("Couldn't add that token: " + e.message); return null; }
}
async function commitPending() {
  const group = document.getElementById("grp")?.checked;
  const list = pending; pending = [];
  for (const p of list) await addCombatant(p.id, p.sheet || null);
  // re-read the saved order, then change it and save straight away (no waiting in between)
  await readScene();
  for (const p of list) {
    if (combat.slots.some((x) => x.ids.includes(p.id))) continue;
    const s = sheets[p.sheet];
    const gname = group && s && s.group ? s.group : null;
    const existing = gname ? combat.slots.find((x) => x.group === gname) : null;
    if (existing) existing.ids.push(p.id);
    else combat.slots.push({ key: uid(), name: gname || p.name, group: gname, ids: [p.id], init: null });
  }
  sortSlots(); await saveCombat(); say(`Added ${list.length}.`); render();
}
async function setInit(slot, text) {
  const t = String(text).trim();
  if (!t) { slot.init = null; slot.initText = ""; }
  else if (/^-?\d+$/.test(t)) { slot.init = +t; slot.initText = t; }
  else { try { const r = E.roll(t); slot.init = r.total; slot.initText = String(r.total); logLine(`${slot.name} initiative: ${r.text}`); } catch (e) { say(e.message); return; } }
  sortSlots(); await saveCombat(); render();
}
async function rollAllInit() {
  for (const s of combat.slots) {
    if (s.init !== null && s.init !== undefined) continue;
    const b = sheetOf(s.ids[0])?.init ?? 0;
    const r = E.roll(`1d20${b >= 0 ? "+" : ""}${b}`);
    s.init = r.total; s.initText = String(r.total); logLine(`${s.name} initiative: ${r.text}`);
  }
  sortSlots(); await saveCombat(); render();
}
async function moveSlot(i, d) {
  const j = i + d; if (j < 0 || j >= combat.slots.length) return;
  const cur = activeSlot();
  [combat.slots[i], combat.slots[j]] = [combat.slots[j], combat.slots[i]];
  if (cur) combat.turn = combat.slots.indexOf(cur);
  await saveCombat(); render();
}
async function removeSlot(i) {
  const cur = activeSlot();
  combat.slots.splice(i, 1);
  combat.turn = cur ? Math.max(0, combat.slots.indexOf(cur)) : 0;
  if (!combat.slots.length) combat.active = false;
  await saveCombat(); render();
}
async function startCombat() {
  if (!combat.slots.length) return;
  if (combat.mode === "init" && combat.slots.some((s) => s.init === null || s.init === undefined)) { say("Some combatants have no initiative yet. Roll or type them, or switch to Manual."); return; }
  sortSlots();
  combat.active = true; combat.round = 1; combat.turn = 0; turnLog.length = 0;
  await saveCombat(); logLine("— Combat starts: Round 1 —");
  await beginTurn(); render();
}
async function endCombat() {
  combat.active = false; prompts = []; endPending = false; await saveCombat(); logLine("— Combat ends —"); say("Combat ended. The order is kept; Start again resets to round 1."); render();
}

/* ======================= Library tab ======================= */
function libraryTab() {
  const out = [];
  const pc = h("div", { class: "card" }, h("h2", {}, "Combat pack"));
  if (pack) pc.append(h("div", { class: "small" }, `Loaded: ${pack.sheets.length} sheets, generated ${pack.generated || "?"}. Stored in this browser only.`));
  const ta = h("textarea", { rows: 5, placeholder: "Paste the combat pack JSON from your vault (Combat Sheets → Combat Pack)", "data-k": "packin" });
  pc.append(ta, h("div", { class: "row" }, h("button", { class: "go sm", onclick: () => {
    try {
      const p = JSON.parse(ta.value);
      if (p.format !== "workshop-combat-pack" || !Array.isArray(p.sheets)) throw new Error("That isn't a Workshop combat pack.");
      savePack(p); say(`Loaded ${p.sheets.length} sheets.`, "SUCCESS"); render();
    } catch (e) { say("Couldn't load it: " + e.message, "ERROR"); }
  } }, "Load pack"), pack ? h("button", { class: "sm", onclick: () => { navigator.clipboard?.writeText(JSON.stringify(pack)); say("Pack copied."); } }, "Copy current pack") : null));
  out.push(pc);
  if (pack) out.push(h("div", { class: "card" }, h("h2", {}, "Sheets"), ...pack.sheets.map((s) => h("div", { class: "small" }, h("b", {}, s.name), ` — HP ${s.hp} · Armor ${s.armor} · ${(s.pools || []).length} pools · ${(s.actions || []).length} actions`, (s.assumptions || []).length ? h("span", { class: "chip warn" }, `${s.assumptions.length} assumed`) : null))));
  // rules
  const r = rules();
  const rc = h("div", { class: "card" }, h("h2", {}, "Rules"));
  rc.append(h("div", { class: "row" }, h("span", { class: "small" }, "Natural 1 on an attack:"),
    h("select", { onchange: (e) => { saveRules({ nat1: e.target.value }); render(); } }, ...[["degree", "Lowers the result one degree (vault rule)"], ["miss", "Always misses"], ["flag", "Flag only"]].map(([k, t]) => h("option", { value: k, selected: r.nat1 === k }, t)))));
  rc.append(h("div", { class: "small" }, "Natural 20 always hits and is a critical: damage dice rolled twice, flat bonuses once (vault rule)."));
  const names = { dr: "Damage Reduction (physical categories)", resist: "Resistance / Immunity / Vulnerability", reduce: "Reaction reductions and negation", absorb: "Shields and absorbing pools (mana shields, structural pools)", hp: "Remaining damage to HP (or a routed pool)" };
  const ol = h("ul", {});
  r.order.forEach((k, i) => ol.append(h("li", { class: "row" }, h("span", { class: "small", style: "width:18px" }, String(i + 1)), h("span", { class: "small", style: "flex:1" }, names[k] || k),
    h("button", { class: "sm", disabled: i === 0 || k === "hp", onclick: () => { const o = [...r.order]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; saveRules({ order: o }); render(); } }, "▲"),
    h("button", { class: "sm", disabled: i >= r.order.length - 2, onclick: () => { const o = [...r.order]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; saveRules({ order: o }); render(); } }, "▼"))));
  rc.append(h("div", { class: "small" }, "Damage order (after hit, reaction and the damage roll):"), ol,
    h("button", { class: "sm", onclick: () => { saveRules({ order: E.DEFAULT_ORDER }); render(); } }, "Reset order"));
  out.push(rc);
  out.push(logCard());
  return out;
}

/* ======================= Wiring ======================= */
OBR.onReady(async () => {
  if ((await OBR.player.getRole()) !== "GM") { $("main").textContent = "The combat window is for the GM."; return; }
  loadPack();
  const refresh = async () => { try { await readScene(); } catch (e) {} scheduleRender(); };
  if (await OBR.scene.isReady()) await readScene();
  OBR.scene.onReadyChange(refresh);
  OBR.scene.items.onChange(refresh);
  OBR.scene.onMetadataChange(refresh);
  OBR.broadcast.onMessage(KEY + "/combat-focus", async (ev) => {
    const id = ev.data && ev.data.id; if (!id) return;
    await readScene();
    if (ev.data.add && !cbtOf(id)) { tab = "order"; pending.push({ id, name: nameOf(id), sheet: guessSheet(id) }); }
    else { view_.id = id; tab = "turn"; }
    render();
  });
  $("endBtn").onclick = () => endTurn().catch((e) => say(e.message));
  $("prevBtn").onclick = () => prevTurnFn().catch((e) => say(e.message));
  $("closeBtn").onclick = () => OBR.popover.close(COMBAT_POPOVER);
  if (!combat.slots.length) tab = pack ? "order" : "library";
  render();
});
