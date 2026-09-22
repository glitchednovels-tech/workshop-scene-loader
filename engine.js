// Workshop combat engine: pure rules logic (no Owlbear calls), so it can be tested on its own.
// Follows the vault's Core TTRPG Rules: Armor (not AC), DR by physical category (min 1),
// Resistance/Immunity/Vulnerability for energy types, penetration to a minimum of Armor 10,
// natural 20 = critical (damage dice rolled twice, flat bonuses once), degrees of result.

/* ======================= Dice ======================= */
// Grammar: term (('+'|'-') term)*
//   term  := [N]dS[kh|klK][(r1, r2, ...)]  |  integer
// "(...)" holds results already rolled at the table; those dice are never re-rolled.
// Examples: 1d20+10 · 1d20(15)+10 · 2d8(6,3)+5 · 2d20kh1(4,17)+8 · d20 · 3d12+6-2

export function parseDice(expr) {
  const src = String(expr || "").replace(/\s+/g, "").toLowerCase();
  if (!src) throw new Error("Empty dice expression.");
  const terms = [];
  const re = /([+-]?)(?:(\d*)d(\d+)(?:(kh|kl)(\d+))?(?:\(([^)]*)\))?|(\d+))/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m || m.index !== i || m[0] === "" || (i > 0 && !m[1])) throw new Error(`Can't read "${expr}" near "${src.slice(i)}".`);
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3]) {
      const n = m[2] === "" ? 1 : +m[2], s = +m[3];
      if (n < 1 || n > 500) throw new Error(`Too many dice in "${m[0]}".`);
      if (s < 2) throw new Error(`A die needs at least 2 sides ("${m[0]}").`);
      const keep = m[4] ? { mode: m[4], count: +m[5] } : null;
      if (keep && (keep.count < 1 || keep.count > n)) throw new Error(`Can't keep ${keep.count} of ${n} dice.`);
      let manual = null;
      if (m[6] !== undefined) {
        manual = m[6].split(/[,;|]/).filter((x) => x !== "").map((x) => {
          const v = +x;
          if (!Number.isInteger(v)) throw new Error(`"${x}" isn't a die result.`);
          if (v < 1 || v > s) throw new Error(`${v} can't be rolled on a d${s}.`);
          return v;
        });
        if (!manual.length) throw new Error(`No results inside the brackets of "${m[0]}".`);
      }
      terms.push({ kind: "dice", sign, n, s, keep, manual });
    } else {
      terms.push({ kind: "flat", sign, value: +m[7] });
    }
    i = re.lastIndex;
  }
  return terms;
}

const defaultRng = (s) => 1 + Math.floor(Math.random() * s);

function keepIdx(vals, keep) {
  const idx = vals.map((v, i) => i);
  if (!keep) return idx;
  idx.sort((a, b) => (keep.mode === "kh" ? vals[b] - vals[a] : vals[a] - vals[b]));
  return idx.slice(0, keep.count).sort((a, b) => a - b);
}

// Roll an expression. opts.crit doubles every dice term (flat bonuses once); opts.critReduce (0..1)
// cuts only the extra (critical bonus) dice. Manual results: give n values for a normal roll; on a
// crit give n values (the extra n are rolled) or 2n values (all entered by hand).
export function roll(expr, opts = {}) {
  const rng = opts.rng || defaultRng;
  const terms = parseDice(expr);
  const out = { expr: String(expr), terms: [], total: 0, flat: 0, diceSum: 0, critBonus: 0, critBonusRaw: 0, natural: null, manual: false, allManual: true };
  let firstD20 = true;
  for (const t of terms) {
    if (t.kind === "flat") { out.flat += t.sign * t.value; out.total += t.sign * t.value; out.terms.push({ ...t }); continue; }
    const count = opts.crit ? t.n * 2 : t.n;
    if (t.manual && t.manual.length !== t.n && !(opts.crit && t.manual.length === count))
      throw new Error(`${t.n}d${t.s} needs ${t.n} result${t.n === 1 ? "" : "s"} in the brackets, got ${t.manual.length}.`);
    const vals = [], manualFlags = [];
    for (let k = 0; k < count; k++) {
      if (t.manual && k < t.manual.length) { vals.push(t.manual[k]); manualFlags.push(true); }
      else { vals.push(rng(t.s)); manualFlags.push(false); }
    }
    if (manualFlags.some(Boolean)) out.manual = true;
    if (manualFlags.some((f) => !f)) out.allManual = false;
    const base = vals.slice(0, t.n), extra = vals.slice(t.n);
    const kept = keepIdx(base, t.keep).map((i) => base[i]);
    const keptExtra = extra.length ? keepIdx(extra, t.keep).map((i) => extra[i]) : [];
    const baseSum = kept.reduce((a, b) => a + b, 0);
    const extraSum = keptExtra.reduce((a, b) => a + b, 0);
    const reduced = Math.floor(extraSum * (1 - (opts.critReduce || 0)));
    const term = { ...t, rolls: base, kept, extra, keptExtra, manualFlags, sum: t.sign * baseSum, extraSum: t.sign * reduced, extraRaw: t.sign * extraSum };
    if (t.s === 20 && firstD20 && t.sign > 0) { out.natural = kept.length === 1 ? kept[0] : (t.keep ? kept[0] : null); firstD20 = false; term.naturalTerm = true; }
    out.terms.push(term);
    out.diceSum += t.sign * baseSum;
    out.critBonus += t.sign * reduced;
    out.critBonusRaw += t.sign * extraSum;
    out.total += t.sign * (baseSum + reduced);
  }
  if (!out.terms.some((t) => t.kind === "dice")) out.allManual = false;
  out.text = describe(out);
  return out;
}

export function describe(r) {
  const parts = [];
  for (const t of r.terms) {
    const sg = t.sign < 0 ? "−" : "+";
    if (t.kind === "flat") { parts.push(`${sg} ${t.value}`); continue; }
    const ki = new Set(keepIdx(t.rolls, t.keep));
    const shown = t.rolls.map((v, i) => (ki.has(i) ? String(v) : `${v} dropped`) + (t.manualFlags[i] ? "*" : "")).join(", ");
    let s = `${sg} ${t.n}d${t.s}${t.keep ? t.keep.mode + t.keep.count : ""} [${shown}]`;
    if (t.extra && t.extra.length) s += ` + crit [${t.extra.map((v, i) => v + (t.manualFlags[t.n + i] ? "*" : "")).join(", ")}]`;
    parts.push(s);
  }
  let txt = parts.join(" ").replace(/^\+ /, "");
  if (r.critBonusRaw !== r.critBonus) txt += ` (crit bonus ${r.critBonusRaw} → ${r.critBonus} after reduction)`;
  return `${txt} = ${r.total}`;
}

/* ======================= Attack rolls ======================= */
export const DEGREES = ["Disaster", "Failure", "Setback", "Success", "Strong", "Exceptional"];
export function degreeOf(margin) {
  if (margin >= 10) return 5; if (margin >= 5) return 4; if (margin >= 0) return 3;
  if (margin >= -4) return 2; if (margin >= -9) return 1; return 0;
}

// Effective Armor for one attack. armor: number or {base, parts:[{name,value,tags}]} with temp mods.
// pen: {flat, pct, ignoreTags:[...]}  — percentage is taken of the (remaining) Armor, then flat;
// penetration can't take Armor below 10 (or below its own value if it was already under 10).
// Size → Accuracy bonus for the attacker (Health, Damage and Defense: "Size").
export const SIZE_ACC = { tiny: -4, small: -1, medium: 0, large: 2, huge: 4, gargantuan: 6 };
export const sizeAccuracy = (size) => SIZE_ACC[norm(size)] || 0;

// Armor Breaker-style penetration: {stack:{per, max}} ignores `per` more Armor for each previous consecutive hit.
export function stackedPen(pen = {}, consecutive = 0) {
  if (!pen.stack) return pen;
  const extra = Math.min(pen.stack.max || Infinity, (pen.stack.per || 0) * Math.max(0, consecutive));
  return { ...pen, flat: (+pen.flat || 0) + extra, stackExtra: extra };
}

export function effectiveArmor(target, pen = {}, extraMods = 0) {
  const parts = target.armorParts || [];
  let armor = +target.armor || 0;
  const ignored = [];
  for (const p of parts) if ((pen.ignoreTags || []).some((t) => (p.tags || []).includes(t))) { armor -= p.value; ignored.push(p.name); }
  armor += (+target.armorMod || 0) + (+extraMods || 0);
  const before = armor;
  const pctCut = pen.pct ? Math.floor(armor * pen.pct / 100) : 0;
  const cut = pctCut + (+pen.flat || 0);
  const floor = Math.min(before, 10);
  const eff = Math.max(floor, before - cut);
  return { armor: eff, before, cut: before - eff, pctCut, flat: +pen.flat || 0, ignoredParts: ignored };
}

// Decide hit/miss from the natural die, not only the total.
// Natural 20: always hits and is a critical (raises the degree one step).
// Natural 1 (rule "degree"): lowers the degree one step, so a hit by 0–4 becomes a miss. Flagged either way.
export function resolveAttack(rollResult, armorInfo, rules = {}) {
  const nat = rollResult.natural;
  const total = rollResult.total;
  const margin = total - armorInfo.armor;
  let deg = degreeOf(margin);
  const nat20 = nat === 20, nat1 = nat === 1;
  if (nat20) deg = Math.min(5, Math.max(3, deg + 1));
  if (nat1) {
    const mode = rules.nat1 || "degree";
    if (mode === "degree") deg = Math.max(0, deg - 1);
    else if (mode === "miss") deg = Math.min(deg, 2);
  }
  const hit = nat20 ? true : deg >= 3;
  return { natural: nat, total, armor: armorInfo.armor, margin, degree: DEGREES[deg], degreeIndex: deg, hit, crit: nat20, nat20, nat1 };
}

/* ======================= Damage ======================= */
export const PHYSICAL = ["small arms", "piercing", "slashing", "bludgeoning"];
export const ENERGY = ["fire", "cold", "lightning", "force", "acid", "necrotic", "radiant", "psychic", "poison", "mana", "neural", "blast"];
const norm = (s) => String(s || "").trim().toLowerCase();

// Does a list like ["fire", "blast:nonmagical", "lightning:magical"] cover this damage part?
function listCovers(list, type, magical) {
  for (const raw of list || []) {
    const [t, q] = norm(raw).split(":");
    if (t !== type && t !== "all") continue;
    if (!q) return true;
    if (q === "nonmagical" && !magical) return true;
    if (q === "magical" && magical) return true;
  }
  return false;
}

export const DEFAULT_ORDER = ["dr", "resist", "reduce", "absorb", "hp"];

// Apply one hit's damage to a target.
// parts: [{amount, type, magical?, to?}]  (to = "hp" (default) or a pool id to hit that pool directly)
// target: {hp, maxHp, dr:{cat:n}, resist, immune, vuln, pools:[{id,name,cur,absorb:{order,tags}, tags}], kind}
// adj: reaction adjustments {reduceFlat, reducePct, negate, negatePct}
// opts: {ignoreDR, ignoreShieldTags:[...], order:[...]}
// Returns {parts:[...steps], absorbed:[{pool,amount}], toHp, poolsAfter, hpAfter, log:[text]}
export function applyDamage(target, parts, adj = {}, opts = {}) {
  const order = (opts.order && opts.order.length ? opts.order : DEFAULT_ORDER).filter((s) => DEFAULT_ORDER.includes(s));
  for (const s of DEFAULT_ORDER) if (!order.includes(s)) order.push(s);
  const log = [];
  let cur = parts.map((p) => ({ type: norm(p.type), magical: !!p.magical, to: p.to || "hp", amount: Math.max(0, Math.floor(+p.amount || 0)), start: Math.max(0, Math.floor(+p.amount || 0)), notes: [] }));
  const pools = (target.pools || []).map((p) => ({ ...p }));
  let hp = target.hp;
  const absorbed = [];
  let toHp = 0;
  const directToPools = [];

  const stepDR = () => {
    if (opts.ignoreDR) { log.push("DR: ignored by the attack."); return; }
    for (const p of cur) {
      if (!PHYSICAL.includes(p.type)) continue;
      const dr = +((target.dr || {})[p.type] || 0);
      if (!dr || !p.amount) continue;
      if (listCovers(target.immune, p.type, p.magical)) continue;
      const after = Math.max(1, p.amount - dr);
      p.notes.push(`DR −${dr}`); log.push(`DR (${p.type}) −${dr}: ${p.amount} → ${after}`); p.amount = after;
    }
  };
  const stepResist = () => {
    for (const p of cur) {
      if (!p.amount) continue;
      if (listCovers(target.immune, p.type, p.magical)) { log.push(`Immune to ${p.type}: ${p.amount} → 0`); p.notes.push("immune"); p.amount = 0; continue; }
      const res = listCovers(target.resist, p.type, p.magical), vul = listCovers(target.vuln, p.type, p.magical);
      if (res && vul) { log.push(`${p.type}: resistant and vulnerable cancel out`); continue; }
      if (res) { const a = Math.floor(p.amount / 2); log.push(`Resistant to ${p.type}: ${p.amount} → ${a}`); p.notes.push("resisted"); p.amount = a; }
      if (vul) { const a = p.amount * 2; log.push(`Vulnerable to ${p.type}: ${p.amount} → ${a}`); p.notes.push("vulnerable"); p.amount = a; }
    }
  };
  const stepReduce = () => {
    let total = cur.reduce((a, p) => a + p.amount, 0);
    if (!total) return;
    const scale = (f) => { for (const p of cur) p.amount = Math.floor(p.amount * f); };
    if (adj.negate) { log.push(`Reaction: all damage negated (${total} → 0)`); scale(0); return; }
    if (adj.negatePct) { const f = Math.max(0, 1 - adj.negatePct / 100); scale(f); const t2 = cur.reduce((a, p) => a + p.amount, 0); log.push(`Reaction: ${adj.negatePct}% negated (${total} → ${t2})`); total = t2; }
    if (adj.reducePct) { const f = Math.max(0, 1 - adj.reducePct / 100); scale(f); const t2 = cur.reduce((a, p) => a + p.amount, 0); log.push(`Reaction: reduced by ${adj.reducePct}% (${total} → ${t2})`); total = t2; }
    if (adj.reduceFlat) {
      let left = Math.floor(adj.reduceFlat);
      const before = total;
      for (const p of cur) { const d = Math.min(p.amount, left); p.amount -= d; left -= d; if (!left) break; }
      total = cur.reduce((a, p) => a + p.amount, 0);
      log.push(`Reaction: reduced by ${adj.reduceFlat} (${before} → ${total})`);
    }
  };
  const stepAbsorb = () => {
    const bypass = opts.ignoreShieldTags || [];
    const layers = pools.filter((p) => p.absorb && (p.cur || 0) > 0).sort((a, b) => (a.absorb.order || 0) - (b.absorb.order || 0));
    for (const p of cur) {
      if (p.to !== "hp" || !p.amount) continue;
      for (const L of layers) {
        if (!p.amount) break;
        const tags = [...(L.tags || []), ...(L.absorb.tags || [])];
        if (tags.some((t) => bypass.includes(t))) continue;
        if (L.absorb.types && L.absorb.types !== "all" && !L.absorb.types.includes(p.type)) continue;
        if (!L.cur) continue;
        const take = Math.min(L.cur, p.amount);
        L.cur -= take; p.amount -= take;
        const a = absorbed.find((x) => x.pool === L.id); if (a) a.amount += take; else absorbed.push({ pool: L.id, name: L.name, amount: take });
      }
    }
    const skipped = layers.filter((L) => [...(L.tags || []), ...(L.absorb.tags || [])].some((t) => bypass.includes(t)) && L.cur > 0);
    for (const L of skipped) log.push(`${L.name}: bypassed (${bypass.join(", ")})`);
    for (const a of absorbed) log.push(`${a.name} absorbed ${a.amount}`);
  };
  const stepHp = () => {
    for (const p of cur) {
      if (!p.amount) continue;
      if (p.to && p.to !== "hp") {
        const pool = pools.find((x) => x.id === p.to);
        if (pool) { const d = Math.min(pool.cur || 0, p.amount); pool.cur = (pool.cur || 0) - d; directToPools.push({ pool: pool.id, name: pool.name, amount: d }); log.push(`${p.amount} ${p.type} → ${pool.name} (−${d})`); continue; }
      }
      toHp += p.amount;
    }
    if (toHp) { const before = hp; hp = hp - toHp; log.push(`HP ${before} → ${hp} (−${toHp})`); }
  };
  const steps = { dr: stepDR, resist: stepResist, reduce: stepReduce, absorb: stepAbsorb, hp: stepHp };
  for (const s of order) steps[s]();
  const total = cur.reduce((a, p) => a + p.amount, 0) + absorbed.reduce((a, b) => a + b.amount, 0);
  return { parts: cur, absorbed, directToPools, toHp, hpAfter: hp, poolsAfter: pools, totalAfterDefenses: total, log };
}

// Split rolled damage over the listed damage parts. Each part rolls separately; on a crit each part's dice double.
export function rollDamageParts(damage, opts = {}) {
  return (damage || []).map((d) => {
    const r = roll(d.dice, { crit: opts.crit, critReduce: opts.critReduce, rng: opts.rng });
    return { ...d, amount: Math.max(0, r.total), roll: r };
  });
}

/* ======================= Turn order ======================= */
// entries: [{key, name, init, dex, pc}] → sorted by initiative, ties: higher DEX, then players.
export function sortInitiative(entries) {
  return [...entries].sort((a, b) =>
    (b.init ?? -Infinity) - (a.init ?? -Infinity) || (b.dex ?? 0) - (a.dex ?? 0) || (b.pc ? 1 : 0) - (a.pc ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
}

// Advance to the next turn. state: {round, turn (0-based), order:[...]} → {round, turn, newRound}
export function nextTurn(state) {
  const n = (state.order || []).length;
  if (!n) return { round: state.round || 1, turn: 0, newRound: false };
  let turn = (state.turn || 0) + 1, round = state.round || 1, newRound = false;
  if (turn >= n) { turn = 0; round += 1; newRound = true; }
  return { round, turn, newRound };
}
export function prevTurn(state) {
  const n = (state.order || []).length;
  if (!n) return { round: state.round || 1, turn: 0 };
  let turn = (state.turn || 0) - 1, round = state.round || 1;
  if (turn < 0) { if (round <= 1) return { round: 1, turn: 0 }; turn = n - 1; round -= 1; }
  return { round, turn };
}

/* ======================= Pools and regeneration ======================= */
// A pool's regen {amount, per: "turn"|"round"|"minute"|"hour", when: "start"|"end"} applied on its owner's turn.
// 1 round = 6 seconds, so "per minute" gives amount/10 each turn (fractions carried over).
export function regenFor(pool, when) {
  const r = pool.regen;
  if (!r || !r.amount) return 0;
  if ((r.when || "start") !== when) return 0;
  const per = r.per || "turn";
  const f = per === "minute" ? 1 / 10 : per === "hour" ? 1 / 600 : 1;
  return r.amount * f;
}
export function applyRegen(pool, when) {
  const add = regenFor(pool, when);
  if (!add) return { pool, gained: 0 };
  const carry = (pool.carry || 0) + add;
  const whole = carry >= 0 ? Math.floor(carry) : Math.ceil(carry);
  const max = pool.max ?? Infinity;
  const before = pool.cur ?? 0;
  const after = Math.max(0, Math.min(max, before + whole));
  return { pool: { ...pool, cur: after, carry: carry - whole }, gained: after - before };
}

/* ======================= Reaction adjustments ======================= */
// Parse quick text like "+10 Armor", "Negate 50% Damage", "Reduce Damage by 25", "Reduce by 30%", "Negate", "Dodge".
export const ADJUST_KINDS = [
  { id: "armor", label: "+X Armor", needs: true },
  { id: "reduceFlat", label: "Reduce damage by X", needs: true },
  { id: "reducePct", label: "Reduce damage by X%", needs: true },
  { id: "negate", label: "Negate damage", needs: false },
  { id: "negatePct", label: "Negate X% damage", needs: true },
  { id: "absorb", label: "Absorb X (temporary shield)", needs: true },
  { id: "redirect", label: "Redirect damage to…", needs: false },
  { id: "disadvantage", label: "Attacker re-rolls with disadvantage", needs: false },
  { id: "dodge", label: "Dodge (attack misses)", needs: false },
  { id: "escape", label: "Escape (attack misses, target moves)", needs: false },
  { id: "block", label: "Block (reduce by X)", needs: true },
  { id: "custom", label: "Custom (note only)", needs: false },
];
export function parseAdjustment(text) {
  const t = norm(text);
  if (!t) return null;
  let m;
  if ((m = t.match(/^([+-]?\d+)\s*(armor|ac)$/)) || (m = t.match(/^(armor|ac)\s*([+-]?\d+)$/))) return { kind: "armor", value: +(m[1].match(/\d/) ? m[1] : m[2]) };
  if ((m = t.match(/negate\s*(\d+)\s*%/))) return { kind: "negatePct", value: +m[1] };
  if (/^negate(\s+(all\s+)?damage)?$/.test(t)) return { kind: "negate" };
  if ((m = t.match(/(reduce|block)[a-z\s]*?(\d+)\s*%/))) return { kind: "reducePct", value: +m[2] };
  if ((m = t.match(/(reduce|block)[a-z\s]*?(\d+)/))) return { kind: "reduceFlat", value: +m[2] };
  if ((m = t.match(/absorb\s*(\d+)/))) return { kind: "absorb", value: +m[1] };
  if (/^(dodge|evade|miss)/.test(t)) return { kind: "dodge" };
  if (/^(escape|teleport)/.test(t)) return { kind: "escape" };
  if (/^redirect/.test(t)) return { kind: "redirect" };
  if ((m = t.match(/^(\d+)\s*%$/))) return { kind: "reducePct", value: +m[1] };
  return { kind: "custom", text };
}
// Fold a list of adjustments into what the attack and damage steps use.
export function foldAdjustments(list) {
  const out = { armor: 0, reduceFlat: 0, reducePct: 0, negate: false, negatePct: 0, absorb: 0, miss: false, redirect: null, notes: [] };
  for (const a of list || []) {
    if (!a) continue;
    switch (a.kind) {
      case "armor": out.armor += +a.value || 0; break;
      case "reduceFlat": case "block": out.reduceFlat += +a.value || 0; break;
      case "reducePct": out.reducePct = 100 - (100 - out.reducePct) * (100 - (+a.value || 0)) / 100; break;
      case "negate": out.negate = true; break;
      case "negatePct": out.negatePct = 100 - (100 - out.negatePct) * (100 - (+a.value || 0)) / 100; break;
      case "absorb": out.absorb += +a.value || 0; break;
      case "dodge": case "escape": out.miss = true; out.notes.push(a.kind === "dodge" ? "Dodged" : "Escaped"); break;
      case "redirect": out.redirect = a.to || null; break;
      case "disadvantage": out.notes.push("Attacker re-rolls with disadvantage"); out.rerollDis = true; break;
      default: if (a.text) out.notes.push(a.text);
    }
  }
  return out;
}
