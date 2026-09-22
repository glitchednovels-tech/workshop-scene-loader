// "What should use this image?" — opened from the right-click menu of an image on the map (GM only).
// Lists every loaded piece; the ticked ones are rebuilt to use the image, keeping their layer, size, lock and visibility.
import OBR from "./obr-sdk.js?v=30";
import { OBJ } from "./common.js?v=30";
import { loadRoom, applyImage, rebuildPiece, imageOf } from "./pieces.js?v=30";

const $ = (id) => document.getElementById(id);
const TYPE_NAME = { token: "Character", bloom: "Bloom", rect: "Wall", zone: "Zone", mat: "Floor", grenade: "Grenade", shield: "Shield", prop: "Prop", item: "Item" };
const GROUPS = [["all", "All"], ["creature", "Characters"], ["wall", "Walls & floors"], ["prop", "Props"]];
const groupOf = (m) => (["token", "bloom"].includes(m.type) || m.maxHp ? "creature" : ["rect", "zone", "mat"].includes(m.type) ? "wall" : "prop");
const say = (t) => { $("msg").textContent = t; };

let src = null, img = null, pieces = [], using = new Set(), ticked = new Set(), group = "all";

function nameOf(it) {
  const m = it.metadata[OBJ];
  return m.label || `${TYPE_NAME[m.type] || m.type} ${m.id ? "(" + m.id + ")" : ""}`.trim();
}

function renderTypes() {
  const box = $("types"); box.textContent = "";
  for (const [k, t] of GROUPS) {
    const n = k === "all" ? pieces.length : pieces.filter((p) => groupOf(p.metadata[OBJ]) === k).length;
    const b = document.createElement("button");
    b.textContent = `${t} ${n}`; b.className = group === k ? "on" : ""; b.setAttribute("aria-pressed", String(group === k));
    b.onclick = () => { group = k; renderTypes(); renderList(); };
    box.append(b);
  }
  // Tick or untick everything currently shown.
  const all = document.createElement("button");
  all.textContent = "Tick shown";
  all.onclick = () => { const shown = visible(); const every = shown.every((p) => ticked.has(p.id)); for (const p of shown) every ? ticked.delete(p.id) : ticked.add(p.id); all.textContent = every ? "Tick shown" : "Untick shown"; renderList(); };
  box.append(all);
}

function visible() {
  const q = $("q").value.trim().toLowerCase();
  return pieces.filter((p) => (group === "all" || groupOf(p.metadata[OBJ]) === group) && (!q || nameOf(p).toLowerCase().includes(q)));
}

function renderList() {
  const ul = $("list"); ul.textContent = "";
  const shown = visible();
  if (!shown.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = pieces.length ? "Nothing matches." : "No loaded pieces on this map yet."; ul.append(li); }
  for (const p of shown) {
    const m = p.metadata[OBJ];
    const li = document.createElement("li"), lab = document.createElement("label");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = ticked.has(p.id);
    cb.onchange = () => { cb.checked ? ticked.add(p.id) : ticked.delete(p.id); updateApply(); };
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = nameOf(p);
    const tags = document.createElement("span");
    const tag = (t, cls) => { const s = document.createElement("span"); s.className = "tag" + (cls ? " " + cls : ""); s.textContent = t; tags.append(s); };
    tag(TYPE_NAME[m.type] || m.type);
    if (using.has(p.id)) tag("Using", "using");
    else if (m.imgData || m.img) tag("Other image");
    if (!p.visible) tag("Hidden", "hid");
    lab.append(cb, nm, tags); li.append(lab); ul.append(li);
  }
  updateApply();
}

function changes() {
  const add = [...ticked].filter((id) => !using.has(id));
  const remove = [...using].filter((id) => !ticked.has(id));
  return { add, remove };
}
function updateApply() {
  const { add, remove } = changes();
  const n = add.length + remove.length;
  $("apply").disabled = !img || n === 0;
  $("apply").textContent = n ? `Apply (${n})` : "Apply";
}

async function load() {
  const sel = await OBR.player.getSelection();
  const [it] = sel && sel.length ? await OBR.scene.items.getItems([sel[0]]) : [];
  src = it || null; img = imageOf(src);
  if (!img) { say("Right-click a single image on the map to use this."); $("apply").disabled = true; return; }
  $("thumb").src = img.url;
  $("sub").textContent = (src.name ? `“${src.name}”. ` : "") + "Tick the pieces, then press Apply.";
  await loadRoom();
  pieces = (await OBR.scene.items.getItems((i) => i.metadata && i.metadata[OBJ] && i.metadata[OBJ].type !== "text" && !i.metadata[OBJ].adopted && i.id !== src.id))
    .sort((a, b) => GROUPS.findIndex((g) => g[0] === groupOf(a.metadata[OBJ])) - GROUPS.findIndex((g) => g[0] === groupOf(b.metadata[OBJ])) || nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true }));
  using = new Set(pieces.filter((p) => (p.metadata[OBJ].imgData || {}).url === img.url).map((p) => p.id));
  ticked = new Set(using);
  // The image itself is one of the loaded pieces: removing it afterwards would delete that piece, so don't offer it.
  if (src.metadata && src.metadata[OBJ]) { $("removeSrc").checked = false; $("removeSrc").disabled = true; }
  renderTypes(); renderList();
}

OBR.onReady(async () => {
  if ((await OBR.player.getRole()) !== "GM") { say("Only the GM can change pieces."); return; }
  $("q").oninput = () => renderList();
  $("apply").onclick = async () => {
    const { add, remove } = changes();
    $("apply").disabled = true; say("Working…");
    try {
      if (add.length) await applyImage(add, img, $("remember").checked);
      for (const id of remove) await rebuildPiece(id, { img: null, imgData: null, noImg: true });
      if ($("removeSrc").checked && src && !(src.metadata && src.metadata[OBJ])) await OBR.scene.items.deleteItems([src.id]);
      const parts = [];
      if (add.length) parts.push(`${add.length} piece${add.length === 1 ? "" : "s"} now use the image`);
      if (remove.length) parts.push(`${remove.length} went back to ${remove.length === 1 ? "its" : "their"} drawing`);
      OBR.notification.show(parts.join(", ") + ".", "SUCCESS");
      await OBR.player.deselect();
    } catch (e) {
      console.error("[Workshop] use image:", e);
      say("Couldn't apply: " + (e && e.message ? e.message : "unknown error"));
      OBR.notification.show("Couldn't apply the image: " + (e && e.message ? e.message : "unknown error"), "ERROR");
      $("apply").disabled = false;
    }
  };
  try { await load(); } catch (e) { console.error("[Workshop]", e); say("Couldn't read the map."); }
});
