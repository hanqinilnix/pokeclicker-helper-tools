# PokeClicker Helper

A Tampermonkey / Violentmonkey userscript for [PokeClicker](https://www.pokeclicker.com). Automates the grindy parts by calling the game's own classes rather than clicking the DOM.

## Install

Open the raw bundle and the userscript manager will offer to install it:

```
https://raw.githubusercontent.com/hanqinilnix/pokeclicker-helper-tools/main/pokeclicker-helper.user.js
```

`@grant none` is required and already set — the game's classes are global lexical bindings, unreachable from a sandboxed script.

## What it does

**Dungeon crawler** — a card between the battle view and the town map, shown when you are at or in a dungeon. Three modes:

| Mode | Behaviour |
|---|---|
| Boss rush | straight to the boss, opens nothing |
| All chests | every wanted chest, then the boss |
| All enemies | every enemy, then the boss, opens nothing |

Per-rarity chest table decides which chests are worth collecting and how hard to prioritise each — chests are not free, since every one opened adds 20% of base health to every later enemy and the boss. Runs a set number of attempts; Stop is graceful, finishing the attempt already paid for. Plays a sound when it finishes on its own: all attempts done, a graceful stop landing, or no tokens left to enter. Pathing is a weighted Dijkstra that routes around enemies, and jumps straight to the furthest legally reachable tile instead of retracing explored ground.

**Safari crawler** — controls in the Safari Zone modal, next to Leave. Set how many runs you want and press start, either on the entrance screen or partway through a run you entered by hand. A run already under way is taken over and counts as the first run. It pays each entrance fee itself. When a run ends it reopens the Safari and pays for the next one. It stops when all the runs are done or you run out of Quest Points, and plays a sound either way. While it runs, the same button stops it. If you press Leave partway through a run, it pauses and lets go of the keys. When you go back in, it carries on with the same run.

It walks by holding a direction and turning as it goes, the same way a held arrow key does. It goes for items first, then Pokemon spawned on the map. Grass and water count as 8 ordinary tiles when it plans a route, so it goes around a patch unless the detour is longer than that. With nothing else to go for, it wanders the nearest grass or water, where each step has a 5% chance of an encounter. In a battle it follows the wiki's catch rate table: Razz or Nanab, then a Rock, depending on the Pokemon's catch rate, your Safari level and Magic Ball. After that it throws balls until the Pokemon is caught, flees, or the balls run out. Berries come from the farm inventory. If the berry it needs is not there, it just throws balls.

**Auto Clicker** — click attacks on routes, gyms, dungeons and temporary battles, at the 50ms floor the engine enforces. Battle Frontier is excluded; it has no click attack.

**Battle Frontier auto restart** — starts a fresh run when one ends in a loss. Quitting deliberately is never a restart.

**Hatchery filling** — a button in the breeding modal that queues exactly as many Pokémon as the hatchery and queue will hold, respecting your filters and sort order. Auto-fill tops it up as eggs hatch and Pokémon reach level 100.

**Auto mining** — digs the Underground layer at the tools' own durability and click rate. Anything already showing is dug out first: each hit uses whichever of hammer, chisel or bomb takes the most layers off the exposed treasures themselves, so a two-tile item under one hammer beats the chisel's two layers on one tile. Only once nothing is exposed does it look for more, surveying when it can and otherwise bombing, which clears twenty layers a throw against the hammer's nine. The bomb is barred whenever every still-covered tile of some treasure is within its two layers, so the hit that finishes a treasure is always a hammer or chisel and its 7-in-8 destroy chance never applies. Discharges the Cell Battery whenever it is full, and never switches your selected tool. Runs whether the Underground window is open or not; turn the game's own restart arrow on to keep going after a layer is cleared.

**Underground bulk selling** — sell every unlocked item of a value type from the Treasures tab. Sell-locked items are left alone. Diamonds report what actually landed in the wallet, bonuses included.

The auto clicker, frontier restart and auto mining sit side by side in the Helper card, with a line between them. They work like the Poke Balls filters: right click one (or long press on mobile) to turn it on or off, and one that is off is greyed out. Hover the `?` button on the card to see the hotkeys.

Hotkeys: `J` crawler, `V` safari crawler (only with the Safari Zone open; on the entrance screen it pays and starts), `N` auto clicker, `X` auto mining, `G` fill hatchery.

Your settings are remembered after a reload: the auto clicker, frontier restart, auto mining and hatchery auto-fill toggles, the crawler mode, attempt count and chest table, and the number of safari runs. They are kept in your browser's localStorage, not in your game save. A crawler or safari run that was in progress when you reloaded does not start again.

## Development

```bash
node build.js                                         # rebuild the bundle
node build.js --check                                 # fail if stale
node panel-render.test.js pokeclicker-helper.user.js  # test
```

Edit `src/`, never the bundle. Bump `@version` in `src/header.txt` or managers will not update.

## Planned

- **Auto quest completion**
- **Auto farm setups** — plant a saved berry plot layout in one click, for mutations and harvests
