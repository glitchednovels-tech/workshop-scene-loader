// Runs on every screen in the room (GM and players).
// Draws the exact-HP line under each piece, only on screens allowed to see it.
// These labels are "local" items: they exist on this screen alone and are never shared.
import OBR, { buildText } from "./obr-sdk.js?v=22";
import { KEY, OBJ, HPL, LABEL_GAP, LABEL_SIZE, hpVisibleTo, hpColour, pieceBox, sharedLabel } from "./common.js?v=22";

let me = { id: "", name: "", role: "PLAYER" };
let timer = null, running = false, again = false;
const schedule = () => { clearTimeout(timer); timer = setTimeout(reconcile, 120); };

function hpText(m) {
  let t = `${m.hp ?? m.maxHp}/${m.maxHp}`;
  if (me.role === "GM") {
    if ((m.hpVis || "gm") === "gm") t += " [GM]";
    else if (m.hpVis === "some") t += ` [+${(m.hpPlayers || []).length}]`;
  }
  return t;
}

async function reconcile() {
  if (running) { again = true; return; }
  running = true;
  try {
    if (!(await OBR.scene.isReady())) return;
    const dpi = await OBR.scene.grid.getDpi();
    const mains = await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && i.metadata[OBJ].maxHp);
    const locals = await OBR.scene.local.getItems((i) => i.metadata && i.metadata[HPL]);
    const byParent = new Map(locals.map((l) => [l.metadata[HPL], l]));
    const want = new Map();
    for (const it of mains) {
      const m = it.metadata[OBJ];
      if (!hpVisibleTo(m, me)) continue;
      if (!it.visible && me.role !== "GM") continue;
      const b = pieceBox(it, dpi);
      const below = sharedLabel(m) ? LABEL_GAP + LABEL_SIZE * 1.35 : LABEL_GAP;
      want.set(it.id, { text: hpText(m), colour: hpColour(m), pos: { x: b.x, y: b.y + b.h + below * dpi }, size: Math.max(11, dpi * LABEL_SIZE * 0.9) });
    }
    const add = [], del = [];
    const upd = [];
    for (const [pid, w] of want) {
      const l = byParent.get(pid);
      if (!l) {
        add.push(buildText().plainText(w.text).textType("PLAIN").width("AUTO").height("AUTO").fontSize(w.size).fontWeight(700)
          .fillColor(w.colour).strokeColor("#0c0c10").strokeWidth(Math.max(1, w.size * 0.12)).position(w.pos)
          .attachedTo(pid).locked(true).disableHit(true).layer("TEXT").metadata({ [HPL]: pid }).build());
      } else if (l.text.plainText !== w.text || l.text.style.fillColor !== w.colour || Math.abs(l.position.x - w.pos.x) > 0.5 || Math.abs(l.position.y - w.pos.y) > 0.5) {
        upd.push([l.id, w]);
      }
    }
    for (const [pid, l] of byParent) if (!want.has(pid)) del.push(l.id);
    if (del.length) await OBR.scene.local.deleteItems(del);
    if (add.length) await OBR.scene.local.addItems(add);
    if (upd.length) {
      const map = new Map(upd);
      await OBR.scene.local.updateItems(upd.map((u) => u[0]), (ds) => {
        for (const d of ds) { const w = map.get(d.id); d.text.plainText = w.text; d.text.style.fillColor = w.colour; d.position = w.pos; }
      });
    }
  } catch (e) {
    console.warn("[Workshop] HP labels:", e);
  } finally {
    running = false;
    if (again) { again = false; schedule(); }
  }
}

const BASE = new URL(".", import.meta.url).href;

OBR.onReady(async () => {
  // Right-click an image → "What should use this image?" (GM only). Opens a list of the loaded pieces to tick.
  OBR.contextMenu.create({
    id: KEY + "/use-image",
    icons: [{ icon: BASE + "icon-image.svg", label: "What should use this image?", filter: { roles: ["GM"], max: 1, every: [{ key: "type", value: "IMAGE" }] } }],
    embed: { url: BASE + "use-image.html?v=22", height: 440 },
  }).catch((e) => console.warn("[Workshop] context menu:", e));
  me = { id: await OBR.player.getId(), name: await OBR.player.getName(), role: await OBR.player.getRole() };
  OBR.player.onChange((p) => {
    if (p.role !== me.role || p.name !== me.name || p.id !== me.id) { me = { id: p.id, name: p.name, role: p.role }; schedule(); }
  });
  OBR.scene.onReadyChange((ready) => { if (ready) schedule(); });
  OBR.scene.items.onChange(schedule);
  OBR.scene.grid.onChange?.(schedule);
  schedule();
});
