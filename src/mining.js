// Underground auto mining: surveys, digs and discharges the battery.

    // ---------------------------------------------------------------------
    // Auto mining
    // ---------------------------------------------------------------------

    const activeMine = () => App.game.underground?.mine;
    const miningTools = () => App.game.underground?.tools;

    // Durability, not a cooldown flag; the getter is a computed.
    const canUseMiningTool = (toolType) => !!miningTools()?.getTool(toolType)?.canUseTool();

    // useTool directly rather than clickModalMineSquare: the selected tool is
    // saved with the game, and switching it would write to the player's save.
    const digWith = (toolType, target) => miningTools().useTool(toolType, target.x, target.y);

    const MINING_NEIGHBOURS = [-1, 0, 1]
        .flatMap((x) => [-1, 0, 1].map((y) => ({ x, y })))
        .filter((offset) => offset.x || offset.y);
    const MINING_HAMMER_AREA = [{ x: 0, y: 0 }, ...MINING_NEIGHBOURS];

    const mineCoordinate = (mine, index) => ({ x: index % mine.width, y: Math.floor(index / mine.width) });

    const mineTile = (mine, x, y) => (x < 0 || y < 0 || x >= mine.width || y >= mine.height
        ? null
        : mine.grid[y * mine.width + x]);

    // Exposed: at least one tile of the item is dug out, and it is uncollected.
    const exposedItemIds = (mine) => new Set(mine.grid
        .filter((tile) => tile.layerDepth === 0 && tile.reward && !tile.reward.rewarded)
        .map((tile) => tile.reward.rewardID));

    const coveredTilesOfItems = (mine, rewardIds) => mine.grid
        .map((tile, index) => ({ tile, index }))
        .filter(({ tile }) => tile.layerDepth > 0 && tile.reward && rewardIds.has(tile.reward.rewardID))
        .map(({ tile, index }) => ({ ...mineCoordinate(mine, index), layerDepth: tile.layerDepth }));

    // A survey marks its centre tile with the box size.
    const surveyedBox = (mine) => {
        const index = mine.grid.findIndex((tile) => tile.survey > 0);
        if (index === -1) {
            return null;
        }
        const { x, y } = mineCoordinate(mine, index);
        return { x, y, half: Math.floor(mine.grid[index].survey / 2) };
    };

    const isInsideBox = (box, x, y) => !box
        || (Math.abs(x - box.x) <= box.half && Math.abs(y - box.y) <= box.half);

    // The 3x3 breaking the most rock, inside the surveyed box when there is one.
    const bestHammerCentre = (mine, box) => {
        let best = null;
        for (let y = 0; y < mine.height; y++) {
            for (let x = 0; x < mine.width; x++) {
                if (!isInsideBox(box, x, y)) {
                    continue;
                }
                const covered = MINING_HAMMER_AREA
                    .filter((offset) => mineTile(mine, x + offset.x, y + offset.y)?.layerDepth > 0).length;
                if (covered > 0 && (!best || covered > best.covered)) {
                    best = { x, y, covered };
                }
            }
        }
        return best;
    };

    // The 3x3 over the most tiles of the items being uncovered.
    const bestHammerCentreForTiles = (tiles) => {
        let best = null;
        tiles.forEach((tile) => {
            const covered = tiles.filter((other) => Math.abs(other.x - tile.x) <= 1
                && Math.abs(other.y - tile.y) <= 1).length;
            if (!best || covered > best.covered) {
                best = { x: tile.x, y: tile.y, covered };
            }
        });
        return best;
    };

    // The bomb destroys seven of every eight items it digs up, so it never gets
    // to be the hit that finishes one; its two layers are what decides that.
    const BOMB_LAYERS = 2;
    const BOMB_TILES = 10;

    const canBombFinishAnItem = (mine) => {
        const coveredDepthsByReward = new Map();
        mine.grid.forEach((tile) => {
            if (!tile.reward || tile.reward.rewarded || tile.layerDepth === 0) {
                return;
            }
            const depths = coveredDepthsByReward.get(tile.reward.rewardID) ?? [];
            depths.push(tile.layerDepth);
            coveredDepthsByReward.set(tile.reward.rewardID, depths);
        });
        return [...coveredDepthsByReward.values()]
            .some((depths) => depths.every((depth) => depth <= BOMB_LAYERS));
    };

    const hasUnseenItems = (mine) => {
        const seenIds = new Set(mine.grid
            .filter((tile) => tile.reward && tile.layerDepth === 0)
            .map((tile) => tile.reward.rewardID));
        return mine.grid.some((tile) => tile.reward && !seenIds.has(tile.reward.rewardID));
    };

    // Layers taken off the exposed items themselves, per action. The bomb lands
    // on ten random tiles, so on one item it is nearly always the worst of the
    // three, but it is still allowed to compete while it cannot finish one.
    const uncoverExposedItems = (mine, canBomb) => {
        const tiles = coveredTilesOfItems(mine, exposedItemIds(mine));
        if (!tiles.length) {
            return false;
        }

        const hammer = bestHammerCentreForTiles(tiles);
        const deepest = tiles.reduce((best, tile) => (tile.layerDepth > best.layerDepth ? tile : best));
        const candidates = [
            { toolType: UndergroundToolType.Hammer, target: hammer, layers: hammer.covered },
            { toolType: UndergroundToolType.Chisel, target: deepest, layers: Math.min(deepest.layerDepth, 2) },
        ];
        if (canBomb) {
            candidates.push({
                toolType: UndergroundToolType.Bomb,
                target: { x: 0, y: 0 },
                layers: BOMB_TILES * BOMB_LAYERS * tiles.length / (mine.width * mine.height),
            });
        }

        const choice = candidates
            .filter((candidate) => canUseMiningTool(candidate.toolType))
            .sort((left, right) => right.layers - left.layers)[0];
        if (!choice) {
            return false;
        }
        digWith(choice.toolType, choice.target);
        return true;
    };

    const miningTick = () => {
        if (!isMiningRunning || !App.game?.underground?.canAccess()) {
            return;
        }

        const mine = activeMine();
        // useTool refuses all three of these anyway.
        if (!mine || mine.completed || mine.timeUntilDiscovery > 0 || mine.itemsFound >= mine.itemsBuried) {
            return;
        }

        // Free tiles, and it charges again from the digging below.
        const battery = App.game.underground.battery;
        if (battery?.canDischarge()) {
            battery.discharge();
            return;
        }

        const canBomb = !canBombFinishAnItem(mine) && canUseMiningTool(UndergroundToolType.Bomb);

        // Collect what is already showing before turning over more ground.
        if (uncoverExposedItems(mine, canBomb)) {
            return;
        }

        const box = surveyedBox(mine);
        // One box at a time: a second survey would only mark what is already dug.
        if (!box && hasUnseenItems(mine) && canUseMiningTool(UndergroundToolType.Survey)) {
            miningTools().useTool(UndergroundToolType.Survey, 0, 0);
            return;
        }

        // Twenty layers a throw against the hammer's nine.
        if (canBomb) {
            miningTools().useTool(UndergroundToolType.Bomb, 0, 0);
            return;
        }

        const centre = bestHammerCentre(mine, box);
        const attempts = [
            [UndergroundToolType.Hammer, centre],
            [UndergroundToolType.Chisel, centre],
        ];
        const choice = attempts.find(([toolType, target]) => target && canUseMiningTool(toolType));
        if (choice) {
            digWith(choice[0], choice[1]);
        }
    };

    contributeToggle('helperMiningToggle', 'Auto Mining [X]',
        'Uncovers exposed treasures first, then surveys and bombs for more.',
        () => isMiningRunning,
        (isOn) => { isMiningRunning = isOn; });
