// Dungeon crawling: targets, pathfinding, run accounting, and its card.

    // ---------------------------------------------------------------------
    // Dungeon crawler
    // ---------------------------------------------------------------------

    const currentFloor = () => DungeonRunner.map.playerPosition().floor;
    const currentFloorSize = () => DungeonRunner.map.floorSizes[currentFloor()];
    const currentFloorBoard = () => DungeonRunner.map.board()[currentFloor()];
    const currentFloorTiles = () => currentFloorBoard().flat();

    const tileIndex = (position, floorSize) => position.y * floorSize + position.x;

    // Port of DungeonCrawler._getEdges. Weight belongs to the destination tile.
    const buildAdjacency = (floorSize, shouldAvoidEnemies) => {
        const board = currentFloorBoard();
        const enemyPenalty = floorSize * floorSize;
        const adjacency = new Map();

        for (let row = 0; row < floorSize; row++) {
            for (let column = 0; column < floorSize; column++) {
                const neighbourPositions = [];
                if (column - 1 >= 0) {
                    neighbourPositions.push({ x: column - 1, y: row });
                }
                if (column + 1 < floorSize) {
                    neighbourPositions.push({ x: column + 1, y: row });
                }
                if (row - 1 >= 0) {
                    neighbourPositions.push({ x: column, y: row - 1 });
                }
                if (row + 1 < floorSize) {
                    neighbourPositions.push({ x: column, y: row + 1 });
                }

                const weightedNeighbours = neighbourPositions.map((neighbourPosition) => {
                    const neighbourTile = board[neighbourPosition.y][neighbourPosition.x];
                    let weight;
                    if (neighbourTile.isVisited || neighbourTile.type() === tileTypes().empty) {
                        weight = 0;
                    } else if (neighbourTile.type() === tileTypes().enemy) {
                        // Hunting enemies makes crossing one progress, not a detour.
                        weight = shouldAvoidEnemies ? enemyPenalty : 1;
                    } else {
                        weight = 1;
                    }
                    return { weight, position: neighbourPosition };
                });

                adjacency.set(tileIndex({ x: column, y: row }, floorSize), weightedNeighbours);
            }
        }

        return adjacency;
    };

    // Port of DungeonCrawler._shortestPath, minus the start tile. Linear scan
    // not a heap: the board caps at 10x10.
    const findCheapestPath = (startPosition, goalPosition, shouldAvoidEnemies = true) => {
        const floorSize = currentFloorSize();
        const tileCount = floorSize * floorSize;
        const adjacency = buildAdjacency(floorSize, shouldAvoidEnemies);
        const goalIndex = tileIndex(goalPosition, floorSize);

        const distances = new Array(tileCount).fill(Infinity);
        const previous = new Array(tileCount).fill(null);
        const isSettled = new Array(tileCount).fill(false);
        distances[tileIndex(startPosition, floorSize)] = 0;

        for (let visited = 0; visited < tileCount; visited++) {
            let nearestIndex = -1;
            for (let candidateIndex = 0; candidateIndex < tileCount; candidateIndex++) {
                if (isSettled[candidateIndex]) {
                    continue;
                }
                if (nearestIndex === -1 || distances[candidateIndex] < distances[nearestIndex]) {
                    nearestIndex = candidateIndex;
                }
            }

            if (nearestIndex === -1 || distances[nearestIndex] === Infinity) {
                break;
            }
            if (nearestIndex === goalIndex) {
                break;
            }
            isSettled[nearestIndex] = true;

            const nearestPosition = {
                x: nearestIndex % floorSize,
                y: Math.floor(nearestIndex / floorSize),
            };

            adjacency.get(nearestIndex).forEach((neighbour) => {
                const neighbourIndex = tileIndex(neighbour.position, floorSize);
                const candidateDistance = distances[nearestIndex] + neighbour.weight;
                if (candidateDistance < distances[neighbourIndex]) {
                    distances[neighbourIndex] = candidateDistance;
                    previous[neighbourIndex] = nearestPosition;
                }
            });
        }

        const path = [];
        let cursor = goalPosition;
        while (cursor && !(cursor.x === startPosition.x && cursor.y === startPosition.y)) {
            path.unshift(cursor);
            cursor = previous[tileIndex(cursor, floorSize)];
        }

        return { distance: distances[goalIndex], path };
    };

    // generateMap only places a boss on the final floor; elsewhere it is a ladder.
    const findFloorExit = (tiles) => tiles.find((tile) => tile.type() === tileTypes().boss)
        ?? tiles.find((tile) => tile.type() === tileTypes().ladder)
        ?? null;

    // Ports of findAllChests and findBoss, minus their exploration phases.
    const chestSettingFor = (tile) => chestSettings[tile.metadata?.tier] ?? UNKNOWN_CHEST_SETTING;

    // One rule for both targeting and the tile underfoot.
    const wantsChest = (tile) => crawlerMode === CrawlerMode.allChests && chestSettingFor(tile).isEnabled;

    const pickTarget = (playerPosition) => {
        const tiles = currentFloorTiles();

        if (crawlerMode === CrawlerMode.bossRush) {
            return findFloorExit(tiles);
        }

        // DungeonBattle rewrites a defeated enemy tile to empty.
        if (crawlerMode === CrawlerMode.clearEnemies) {
            const enemyTiles = tiles.filter((tile) => tile.type() === tileTypes().enemy);
            if (enemyTiles.length) {
                const rankedEnemies = enemyTiles.map((enemyTile) => ({
                    distance: findCheapestPath(playerPosition, enemyTile.position, false).distance,
                    tile: enemyTile,
                }));
                rankedEnemies.sort((left, right) => left.distance - right.distance);
                return rankedEnemies[0].tile;
            }
            return findFloorExit(tiles);
        }

        // Rarities switched off in the panel are not targets, and are left shut
        // even when a step lands on one, so they never inflate enemy health.
        const chestTiles = tiles.filter((tile) => tile.type() === tileTypes().chest && wantsChest(tile));

        if (chestTiles.length) {
            const rankedChests = chestTiles.map((chestTile) => {
                const { distance } = findCheapestPath(playerPosition, chestTile.position);
                const priority = Math.max(MINIMUM_CHEST_PRIORITY, chestSettingFor(chestTile).priority);
                return { heuristic: distance / priority, tile: chestTile };
            });
            rankedChests.sort((left, right) => left.heuristic - right.heuristic);
            return rankedChests[0].tile;
        }

        // Every wanted chest is collected, so head for the exit.
        return findFloorExit(tiles);
    };

    // "On a dungeon" means either already inside one, or standing in a town that
    // has one to enter.
    const isAtDungeon = () => {
        if (!App.game) {
            return false;
        }
        if (App.game.gameState === gameStates().dungeon) {
            return true;
        }
        return App.game.gameState === gameStates().town && !!player?.town?.dungeon;
    };

    // A stop the player asked for, there and then, gets no sound.
    const stopCrawler = (message, isFinished = false) => {
        isCrawlerRunning = false;
        shouldStopAfterCurrentRun = false;
        if (message) {
            notify(message);
        }
        if (isFinished) {
            playDoneSound();
        }
        refreshPanel();
    };

    // Re-enters the dungeon the player is standing on top of, the way
    // DungeonGuide.end does when it has clears left to spend.
    const startNextDungeonRun = () => {
        const dungeon = player.town?.dungeon;
        if (!dungeon) {
            stopCrawler('Stopped — not standing on a dungeon', true);
            return;
        }
        if (!DungeonRunner.canStartDungeon(dungeon)) {
            stopCrawler(`Stopped after ${dungeonRunsAttempted} — cannot enter (tokens or requirements)`, true);
            return;
        }

        DungeonRunner.map?.board([]);
        DungeonRunner.initializeDungeon(dungeon);
    };

    // hasAccessToTile allows any visited tile or its neighbours, so explored
    // stretches collapse into one move.
    const furthestReachableStep = (path, floor) => {
        for (let index = path.length - 1; index >= 0; index--) {
            const step = path[index];
            if (DungeonRunner.map.hasAccessToTile(new Point(step.x, step.y, floor))) {
                return step;
            }
        }
        return null;
    };

    // Returns false when there is nothing more to do this tick.
    const takeDungeonStep = () => {
        // Moves are rejected outright while a battle is up (hasAccessToTile), so
        // let the auto clicker and the passive attack tick resolve it first.
        if (DungeonRunner.fighting() || DungeonBattle.catching()) {
            return false;
        }

        const standingTile = DungeonRunner.map.currentTile();
        const standingType = standingTile.type();

        // Each chest opened adds 20% of base health to every later enemy and the
        // boss, so only wanted ones are opened. Crossing the tile is still free.
        const isInteractive = standingType === tileTypes().boss
            || standingType === tileTypes().ladder
            || (standingType === tileTypes().chest && wantsChest(standingTile));

        if (isInteractive) {
            // Safe from the dungeonLeave branch: entrance is never interactive here.
            DungeonRunner.handleInteraction(GameConstants.DungeonInteractionSource.Click);
            return false;
        }

        const playerPosition = DungeonRunner.map.playerPosition();
        const targetTile = pickTarget(playerPosition);
        if (!targetTile) {
            return false;
        }

        // Enemy hunting walks into fights on purpose, so the avoid-enemies
        // weighting would fight the target it was given.
        const { path } = findCheapestPath(playerPosition, targetTile.position,
            crawlerMode !== CrawlerMode.clearEnemies);
        if (!path.length) {
            return false;
        }

        const nextStep = furthestReachableStep(path, playerPosition.floor) ?? path[0];
        DungeonRunner.map.moveToCoordinates(nextStep.x, nextStep.y);

        // A refused move would otherwise spin the loop below doing nothing.
        const movedTo = DungeonRunner.map.playerPosition();
        return movedTo.x === nextStep.x && movedTo.y === nextStep.y;
    };

    const walkDungeon = () => {
        for (let move = 0; move < MAX_MOVES_PER_TICK; move++) {
            if (!takeDungeonStep()) {
                return;
            }
        }
    };

    // Walking only. Ending a run is an event now, not something sampled here.
    const crawlerTick = () => {
        if (!App.game) {
            return;
        }
        if (App.game.gameState !== gameStates().dungeon || DungeonRunner.dungeonFinished()) {
            return;
        }
        if (!isCrawlerRunning) {
            return;
        }
        walkDungeon();
    };

    // dungeonFinished is the one observable every ending funnels through. Any
    // ending is an attempt, so an unwinnable dungeon still terminates.
    const handleDungeonFinished = (isFinished) => {
        if (!isFinished) {
            return;
        }

        if (!isCrawlerRunning) {
            return;
        }

        dungeonRunsAttempted++;
        if (DungeonRunner.defeatedBoss()) {
            dungeonRunsCleared++;
        }

        if (dungeonRunsAttempted >= dungeonRunsRequested) {
            stopCrawler(`Ran ${dungeonRunsAttempted} dungeon${dungeonRunsAttempted === 1 ? '' : 's'} — ${dungeonRunsCleared} cleared`, true);
            return;
        }

        // The graceful stop lands here rather than mid-run, so the dungeon tokens
        // already spent on this attempt are not thrown away.
        if (shouldStopAfterCurrentRun) {
            stopCrawler(`Stopped after ${dungeonRunsAttempted} of ${dungeonRunsRequested} — ${dungeonRunsCleared} cleared`, true);
            return;
        }

        // returnToTown() has not run yet, so yield before opening the next run.
        setTimeout(() => {
            if (isCrawlerRunning) {
                startNextDungeonRun();
            }
        }, 0);
    };

    // A timeout and a deliberate exit both leave defeatedBoss null, so without
    // this the crawler would walk the player straight back in.
    const patchDungeonLeave = () => {
        const originalDungeonLeave = DungeonRunner.dungeonLeave.bind(DungeonRunner);
        DungeonRunner.dungeonLeave = (...leaveArguments) => {
            if (isCrawlerRunning) {
                stopCrawler('Crawler stopped — you left the dungeon');
            }
            return originalDungeonLeave(...leaveArguments);
        };
    };

    const startCrawler = () => {
        // Starting anywhere else would just idle: the tick only acts inside a
        // dungeon or on a town that can enter one.
        if (!isAtDungeon()) {
            notify('Stand on a dungeon to start the crawler');
            return;
        }

        dungeonRunsAttempted = 0;
        dungeonRunsCleared = 0;
        shouldStopAfterCurrentRun = false;
        isCrawlerRunning = true;
        notify(`Crawling ${dungeonRunsRequested} dungeon${dungeonRunsRequested === 1 ? '' : 's'} — ${CRAWLER_MODE_LABELS[crawlerMode].toLowerCase()}`);

        // Standing in the town, so nothing would happen until the first run is
        // opened. Inside a dungeon already, the walking tick takes it from here.
        if (App.game.gameState !== gameStates().dungeon) {
            startNextDungeonRun();
        }
        refreshPanel();
    };

    const toggleCrawler = () => {
        if (!isCrawlerRunning) {
            startCrawler();
            return;
        }

        // Already winding down, so this press is a change of mind.
        if (shouldStopAfterCurrentRun) {
            shouldStopAfterCurrentRun = false;
            notify('Resuming attempts');
            refreshPanel();
            return;
        }

        // Between attempts there is nothing to finish, and arming would buy one
        // more dungeon nobody asked for. Stop outright instead.
        if (App.game.gameState !== gameStates().dungeon) {
            stopCrawler(`Stopped at ${dungeonRunsAttempted} of ${dungeonRunsRequested} — ${dungeonRunsCleared} cleared`);
            return;
        }

        shouldStopAfterCurrentRun = true;
        notify(`Finishing attempt ${dungeonRunsAttempted + 1}, then stopping`);
        refreshPanel();
    };

    // ---------------------------------------------------------------------
    // Crawler panel
    // ---------------------------------------------------------------------

    const buildCrawlerPanel = () => {
        // display:none rather than detaching, so it keeps its place in the
        // saved order while hidden.
        const { panel, body } = buildCard(CRAWLER_PANEL_ID, CRAWLER_PANEL_BODY_ID, 'Dungeon Crawler', 'sortable');

        const modeRow = buildRow();
        const modeGroup = buildElement('div', 'btn-group btn-block');
        const modeButtons = {};
        Object.keys(CRAWLER_MODE_LABELS).forEach((mode) => {
            const button = buildElement('button', 'btn', CRAWLER_MODE_LABELS[mode]);
            button.addEventListener('click', () => {
                crawlerMode = mode;
                refreshPanel();
            });
            modeGroup.appendChild(button);
            modeButtons[mode] = button;
        });
        modeRow.appendChild(modeGroup);
        body.appendChild(modeRow);

        // Hidden outside allChests, where nothing is collected.
        const chestBlock = buildElement('div', 'mb-2');
        // Five columns of inputs outrun a narrow card before the panel itself
        // wraps, so the table scrolls inside the block rather than the card.
        chestBlock.style.overflowX = 'auto';

        const chestTable = buildElement('table', 'table table-sm table-borderless text-center mb-0');
        const headerRow = buildElement('tr');
        const enabledRow = buildElement('tr');
        const priorityRow = buildElement('tr');

        const chestControls = {};
        CHEST_RARITIES.forEach((rarity) => {
            const header = buildElement('th', 'text-capitalize align-middle p-1', rarity);
            headerRow.appendChild(header);

            const enabledCell = buildElement('td', 'align-middle p-1');
            const enabledInput = buildElement('input');
            enabledInput.type = 'checkbox';
            enabledInput.checked = chestSettings[rarity].isEnabled;
            enabledInput.addEventListener('change', () => {
                chestSettings[rarity].isEnabled = enabledInput.checked;
                refreshPanel();
            });
            enabledCell.appendChild(enabledInput);
            enabledRow.appendChild(enabledCell);

            const priorityCell = buildElement('td', 'align-middle p-1');
            const priorityInput = buildNumberInput(chestSettings[rarity].priority, MINIMUM_CHEST_PRIORITY);
            priorityInput.classList.add('mx-auto');
            priorityInput.step = '0.05';
            priorityInput.style.width = '4.5rem';
            priorityInput.addEventListener('change', () => {
                const parsed = parseFloat(priorityInput.value);
                chestSettings[rarity].priority = Number.isFinite(parsed) && parsed >= MINIMUM_CHEST_PRIORITY
                    ? parsed
                    : DEFAULT_CHEST_PRIORITIES[rarity];
                priorityInput.value = String(chestSettings[rarity].priority);
                refreshPanel();
            });
            priorityCell.appendChild(priorityInput);
            priorityRow.appendChild(priorityCell);

            // `label` is the header cell now - it is what dims for a rarity that
            // has been switched off.
            chestControls[rarity] = { enabledInput, priorityInput, label: header };
        });

        const tableHead = buildElement('thead');
        tableHead.appendChild(headerRow);
        const tableBody = buildElement('tbody');
        tableBody.appendChild(enabledRow);
        tableBody.appendChild(priorityRow);
        chestTable.appendChild(tableHead);
        chestTable.appendChild(tableBody);
        chestBlock.appendChild(chestTable);
        body.appendChild(chestBlock);

        // Attempt count and the start/stop button share a row.
        const runsRow = buildRow();
        runsRow.appendChild(buildElement('span', 'text-nowrap', 'Attempts'));
        const runsInput = buildNumberInput(dungeonRunsRequested, 1);
        runsInput.addEventListener('change', () => {
            const parsed = parseInt(runsInput.value, 10);
            dungeonRunsRequested = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DUNGEON_RUNS;
            runsInput.value = String(dungeonRunsRequested);
            refreshPanel();
        });
        runsRow.appendChild(runsInput);

        // flex-fill rather than btn-block: btn-block forces its own line.
        const crawlerButton = buildElement('button', 'btn flex-fill text-nowrap');
        crawlerButton.addEventListener('click', toggleCrawler);
        runsRow.appendChild(crawlerButton);
        body.appendChild(runsRow);

        controlElements.modeButtons = modeButtons;
        controlElements.chestBlock = chestBlock;
        controlElements.chestControls = chestControls;
        controlElements.runsInput = runsInput;
        controlElements.crawlerButton = crawlerButton;
        controlElements.crawlerPanel = panel;
        return panel;
    };

    function refreshCrawlerControls() {
        if (!controlElements.crawlerButton) {
            return;
        }

        // Stays up while running even if the player wanders off, or there would
        // be no way to stop.
        const shouldShow = isAtDungeon() || isCrawlerRunning;
        controlElements.crawlerPanel.style.display = shouldShow ? '' : 'none';

        Object.keys(CRAWLER_MODE_LABELS).forEach((mode) => {
            setButtonState(controlElements.modeButtons[mode], crawlerMode === mode, CRAWLER_MODE_LABELS[mode]);
        });

        const chestsMatter = crawlerMode === CrawlerMode.allChests;
        controlElements.chestBlock.style.display = chestsMatter ? '' : 'none';
        CHEST_RARITIES.forEach((rarity) => {
            const controls = controlElements.chestControls[rarity];
            // A rarity that is switched off has nothing to prioritise.
            controls.priorityInput.disabled = !chestSettings[rarity].isEnabled;
            controls.label.style.opacity = chestSettings[rarity].isEnabled ? '1' : '0.5';
        });

        controlElements.runsInput.disabled = isCrawlerRunning;
        const canStartCrawler = isCrawlerRunning || isAtDungeon();
        controlElements.crawlerButton.disabled = !canStartCrawler;

        // Green to go, red to stop, amber while winding down. Grey only when the
        // button cannot do anything, so it reads as unavailable rather than idle.
        const progress = `${dungeonRunsAttempted}/${dungeonRunsRequested}, ${dungeonRunsCleared} cleared`;
        if (!isCrawlerRunning) {
            setButtonVariant(controlElements.crawlerButton, canStartCrawler ? 'success' : 'secondary',
                canStartCrawler ? 'Start crawler' : 'Start crawler — not on a dungeon');
        } else if (shouldStopAfterCurrentRun) {
            setButtonVariant(controlElements.crawlerButton, 'warning', `Stopping after this attempt (${progress})`);
        } else {
            setButtonVariant(controlElements.crawlerButton, 'danger', `Stop (${progress})`);
        }

    }
