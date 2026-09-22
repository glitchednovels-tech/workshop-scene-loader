# Workshop Scene Loader 2.0 (Owlbear Rodeo extension)

Builds Claude's battle maps straight into your Owlbear room as normal, movable pieces, and gives the GM control over what players can see.

Manifest address: `https://glitchednovels-tech.github.io/workshop-scene-loader/manifest.json`

## What's new in 2.0
- **Hidden pieces.** Any piece can start hidden (`"hidden": true` in the scene text) or be hidden and revealed from its card. Hidden pieces are invisible to players; the GM sees them faded, with a purple **Hidden** tag in the list. This uses Owlbear's own hide feature, so its right-click Hide/Show works too.
- **Who sees the exact HP.** Per piece: **GM only**, **GM + chosen players** (tick names), or **Everyone**. The HP line under a piece is drawn separately on each screen, so a player never receives HP they aren't allowed to see. On your screen, `[GM]` or `[+2]` after the HP shows who else can see it. The default for newly built pieces is in **Settings**.
- **Conditions.** Each piece with HP shows a row of condition buttons. The one that matches the current HP **glows**. Nothing reaches players until you click a condition (or type your own description and press **Show**). Then it appears under the piece's name for everyone. Click it again to hide it. The list and thresholds can be edited in **Settings**.
- **Images on pieces.** Drag an image onto the map, right-click it, and choose **What should use this image?** Tick every piece that should use it: walls, props, characters, anything. Each ticked piece becomes the image and keeps its layer, size, lock and hidden state. Walls and floors stretch the image to fill their area; everything else fits inside its square. Untick a piece to put its drawing back. With "Also use it in future scenes" on, the piece's name is remembered, so scenes built later use the image too. A piece's card also has **Use selected image** and **Remove**.
- **Click a piece on the map** and its card opens in the panel.

## Combat (3.0)
Press **Open combat window** in the panel (or right-click a token → **Combat: open or add**). A window docks on the right:
- **Order:** add selected tokens (any token), pick their sheet, then use Manual order (▲▼) or Initiative (type `18` or `1d20(14)+8`, or roll for everyone). Groups like the Bloom share one turn. **Start combat.**
- **Header:** ROUND n · TURN n — NAME, and **END TURN**. A turn only ends when you press it. End-of-turn effects run first, then the next creature's start-of-turn effects (regeneration, upkeep, shields expiring, areas they start inside). Its sheet opens and its token is selected.
- **Turn:** the active creature's HP, every resource pool (edit with − + =), modes (turret, laser walls…), actions, reactions, turn effects, passives and conditions.
- **Attack:** pick the action and targets. Type `1d20(15)+17` for a die rolled at the table. The natural die decides crits: a natural 20 always hits and doubles the dice. Penetration and shield-ignoring go against the target's real Armor. On a hit, the **reaction window** opens: the target's reactions, or a quick adjustment (`+10 Armor`, `Negate 50% Damage`, `Reduce Damage by 25`, redirect, dodge…). Then roll damage, preview it through DR, resistances, shields and pools, and **Apply**. Chains, drains and stacks follow the sheet. **Undo** is in the log.
- **Area attacks** (grenades, cannon lines, suppressive fire): **Place template** puts an orange circle, square or line on the map. Lines start at the caster; select a token first to aim at it, or use **Aim at selected token** / **Rotate to °**. Drag it where you want. For instant areas, **Find targets in template** adds everything touching it to the saves (friendly fire on by default). For lasting areas like the grenade, **Confirm area**: anything starting its turn inside gets a prompt until it runs out, and the template is removed then.
- **Library:** paste the combat pack from the vault (Combat Sheets → Combat Pack). It's kept in your browser only, never in this public repo. Set the natural 1 rule and the damage order here.

## Scene text additions
`"hidden": true` · `"hpVis": "gm" | "some" | "all"` · `"shown": "Bloodied"` · `"image": "mei"` (use a linked image under a different name)

## Updating
Upload changed files to the repo with the same names. After a change to `manifest.json`, remove and re-add the extension in Owlbear.
