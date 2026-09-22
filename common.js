// Shared constants and helpers for the Workshop Scene Loader panel and background script.
export const KEY = "com.workshop.scene-loader";
export const OBJ = KEY + "/obj";     // metadata on a main piece
export const CHILD = KEY + "/child"; // metadata on decoration attached to a piece
export const ROLE = KEY + "/role";   // "label" | "dead" on a child
export const SCENE = KEY + "/scene"; // scene metadata (name, round, status, origin)
export const ROOM = KEY + "/room";   // room metadata (settings, condition list, image library)
export const HPL = KEY + "/hp";      // local (per-screen) HP label
export const AOE = KEY + "/aoe";     // area template (circle, square, line) placed by the combat window

export const HP_VIS = { gm: "GM only", some: "GM + chosen players", all: "Everyone" };

// Each condition applies from its "min" percentage of max HP upward.
// A condition with min 0 applies only at 0 HP or below.
export const DEFAULT_CONDITIONS = [
  { name: "Healthy", min: 100 },
  { name: "Barely scratched", min: 90 },
  { name: "Lightly injured", min: 75 },
  { name: "Injured", min: 50 },
  { name: "Bloodied", min: 30 },
  { name: "Heavily injured", min: 15 },
  { name: "Near death", min: 1 },
  { name: "Dead", min: 0 },
];

export const normKey = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

export function sortConditions(list) {
  return [...(list && list.length ? list : DEFAULT_CONDITIONS)]
    .map((c) => ({ name: String(c.name), min: Math.max(0, Math.min(100, +c.min || 0)) }))
    .sort((a, b) => b.min - a.min);
}

// Which condition the piece's HP currently falls into (or null if it has no HP).
export function detectCondition(m, list) {
  if (!m || !m.maxHp) return null;
  const hp = m.hp ?? m.maxHp;
  const conds = sortConditions(list);
  if (hp <= 0) return conds.find((c) => c.min === 0) || conds[conds.length - 1];
  const pct = (hp / m.maxHp) * 100;
  const living = conds.filter((c) => c.min > 0);
  return living.find((c) => pct >= c.min) || living[living.length - 1] || null;
}

export function hpVisibleTo(m, me) {
  if (!m || !m.maxHp) return false;
  if (me.role === "GM") return true;
  const v = m.hpVis || "gm";
  if (v === "all") return true;
  if (v === "some") return (m.hpPlayers || []).some((p) => (p.id && p.id === me.id) || (p.name && p.name === me.name));
  return false;
}

export function hpColour(m) {
  if (m.dead) return "#8c90a0";
  const hp = m.hp ?? m.maxHp, pct = m.maxHp ? hp / m.maxHp : 1;
  if (pct >= 0.75) return "#7fd46a";
  if (pct >= 0.5) return "#f0c83c";
  if (pct >= 0.25) return "#f09040";
  return "#f05050";
}

// Text everyone can see under a piece: its name plus whatever condition the GM revealed.
export function sharedLabel(m) {
  return [m.label || "", m.shown || ""].filter(Boolean).join(" — ");
}

// The piece's footprint on the map (top-left x/y, width, height) in scene pixels.
export function pieceBox(it, dpi) {
  const m = (it.metadata && it.metadata[OBJ]) || {};
  const sx = Math.abs(it.scale?.x || 1), sy = Math.abs(it.scale?.y || 1);
  if (it.type === "IMAGE") {
    const bs = m.ibs || { x: 1, y: 1 };   // the scale it was built with; any extra is the GM resizing it
    const w = (m.w || 1) * dpi * sx / Math.abs(bs.x || 1), h = (m.h || 1) * dpi * sy / Math.abs(bs.y || 1);
    return { x: it.position.x - w / 2, y: it.position.y - h / 2, w, h, centred: true };
  }
  if (it.type === "SHAPE") {
    const w = it.width * sx, h = it.height * sy;
    if (it.shapeType === "RECTANGLE") return { x: it.position.x, y: it.position.y, w, h, centred: false };
    return { x: it.position.x - w / 2, y: it.position.y - h / 2, w, h, centred: true };
  }
  return { x: it.position.x, y: it.position.y, w: (m.w || 1) * dpi, h: (m.h || 1) * dpi, centred: false };
}

export const LABEL_GAP = 0.05;   // cells between the piece and its name label
export const LABEL_SIZE = 0.22;  // label font size in cells
