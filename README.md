# Workshop Scene Loader 2.0 (Owlbear Rodeo extension)

Builds Claude's battle maps straight into your Owlbear room as normal, movable pieces, and gives the GM control over what players can see.

Manifest address: `https://glitchednovels-tech.github.io/workshop-scene-loader/manifest.json`

## What's new in 2.0
- **Hidden pieces.** Any piece can start hidden (`"hidden": true` in the scene text) or be hidden and revealed from its card. Hidden pieces are invisible to players; the GM sees them faded, with a purple **Hidden** tag in the list. This uses Owlbear's own hide feature, so its right-click Hide/Show works too.
- **Who sees the exact HP.** Per piece: **GM only**, **GM + chosen players** (tick names), or **Everyone**. The HP line under a piece is drawn separately on each screen, so a player never receives HP they aren't allowed to see. On your screen, `[GM]` or `[+2]` after the HP shows who else can see it. The default for newly built pieces is in **Settings**.
- **Conditions.** Each piece with HP shows a row of condition buttons. The one that matches the current HP **glows**. Nothing reaches players until you click a condition (or type your own description and press **Show**). Then it appears under the piece's name for everyone. Click it again to hide it. The list and thresholds can be edited in **Settings**.
- **Linked images.** Link an image to a name (for example "Mei"), either from your Owlbear images or from an image already on the map. Every piece with that name then uses the image, including in every scene built later. Remove it from a single piece, or unlink it in **Linked images**.
- **Click a piece on the map** and its card opens in the panel.

## Scene text additions
`"hidden": true` · `"hpVis": "gm" | "some" | "all"` · `"shown": "Bloodied"` · `"image": "mei"` (use a linked image under a different name)

## Updating
Upload changed files to the repo with the same names. After a change to `manifest.json`, remove and re-add the extension in Owlbear.
