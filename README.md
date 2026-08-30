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

Per-rarity chest table decides which chests are worth collecting and how hard to prioritise each — chests are not free, since every one opened adds 20% of base health to every later enemy and the boss. Runs a set number of attempts; Stop is graceful, finishing the attempt already paid for. Pathing is a weighted Dijkstra that routes around enemies, and jumps straight to the furthest legally reachable tile instead of retracing explored ground.

**Auto clicker** — click attacks on routes, gyms, dungeons and temporary battles, at the 50ms floor the engine enforces. Battle Frontier is excluded; it has no click attack.

**Battle Frontier auto restart** — starts a fresh run when one ends in a loss. Quitting deliberately is never a restart.

**Hatchery filling** — a button in the breeding modal that queues exactly as many Pokémon as the hatchery and queue will hold, respecting your filters and sort order. Auto-fill tops it up as eggs hatch and Pokémon reach level 100.

**Underground bulk selling** — sell every unlocked item of a value type from the Treasures tab. Sell-locked items are left alone. Diamonds report what actually landed in the wallet, bonuses included.

Hotkeys: `J` crawler, `N` auto clicker, `G` fill hatchery.

## Development

```bash
node build.js                                         # rebuild the bundle
node build.js --check                                 # fail if stale
node panel-render.test.js pokeclicker-helper.user.js  # test
```

Edit `src/`, never the bundle. Bump `@version` in `src/header.txt` or managers will not update.

## Planned

- **Auto Friend Safari crawler**
- **Auto quest completion**
