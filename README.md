# Workshop Scene Loader (Owlbear Rodeo extension)

This add-on builds Claude's battle maps straight into your Owlbear room as normal, movable pieces: walls, zones, Bloom sections, creatures, grenades and the shield. It can also copy the board back out as text for Claude.

## One-time setup (about 5 minutes)

### 1. Put the files on GitHub
1. On github.com, click **New** (new repository).
2. Name it `workshop-scene-loader`, set it to **Public**, and click **Create repository**.
3. On the empty repo page, click **uploading an existing file**.
4. Drag in **all six files**: `manifest.json`, `index.html`, `loader.js`, `obr-sdk.js`, `icon.svg`, `example-return-ledge.json`. Drag the files themselves, not the folder.
5. Click **Commit changes**.

### 2. Turn on GitHub Pages
1. In the repo, go to **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, Branch to **main** and folder to **/ (root)**, then click **Save**.
3. Wait 1–2 minutes. The page shows your site address: `https://YOUR-USERNAME.github.io/workshop-scene-loader/`.
4. Check it works: open `https://YOUR-USERNAME.github.io/workshop-scene-loader/manifest.json`. You should see a short block of text starting with `"name": "Workshop Scene Loader"`.

### 3. Add it to Owlbear Rodeo
1. Sign in at owlbear.rodeo and open your **profile → Extensions**.
2. Choose **Add Custom Extension** and paste the manifest address from step 2.4.
3. Open your room and turn the extension on for that room in the room's extension settings.
4. A small blue-square icon appears in the room's top-left toolbar. That's the loader.

*(If Owlbear's menus are worded differently, look for "custom extension" and "manifest URL".)*

## Using it
- **Build a scene (GM only):** open the loader, paste the scene text Claude gives you, and press **Build on map**. **Start at square** shifts the whole scene if you want it somewhere else on your map.
- **Try it first:** press **Load example**, then **Build on map**. This builds the Return Ledge fight.
- **Move things:** everything is a normal Owlbear piece. Walls, zones and wall growth come in locked so they don't get dragged by accident; unlock them in Owlbear if you need to.
- **HP and dead:** the **Pieces on the board** list lets the GM set HP and mark a piece dead. The label under the piece updates, and a dead piece gets the black square.
- **Send the board to Claude:** press **Export board**, then **Copy**, and paste it into the chat. Claude then knows exactly where everything is.
- **Remove loaded pieces:** deletes everything the loader built, and nothing else.

## Updating
When Claude sends a new version of a file, upload it to the same repo with the same name. Owlbear picks it up on the next page reload.
