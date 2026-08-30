// ==UserScript==
// @name         PokeClicker Helper
// @namespace    https://github.com/hanqinilnix/pokeclicker-helper-tools
// @version      1.0.0
// @description  Dungeon crawler, auto clicker and hatchery filler for PokeClicker
// @match        https://www.pokeclicker.com/*
// @match        https://pokeclicker.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/hanqinilnix/pokeclicker-helper-tools/main/pokeclicker-helper.user.js
// @updateURL    https://raw.githubusercontent.com/hanqinilnix/pokeclicker-helper-tools/main/pokeclicker-helper.user.js
// ==/UserScript==
// Updates are detected by comparing @version, so bump it on every push or the
// manager will keep the copy it already has.

// The game compiles to a single classic script, so its classes (DungeonRunner,
// DungeonMap, Battle, ...) live in the global lexical scope rather than on
// `window`. Bare identifiers resolve; `window.DungeonRunner` does not. This is
// why `@grant none` is required: any GM_* grant moves the script into a sandbox
// where those bare lookups fail, and `unsafeWindow` cannot reach them either.

(function () {
    'use strict';

    /* ===================== core           ===================== */
// Shared constants, state and helpers. Loaded first.

    // Battle.clickAttack drops anything inside 50ms.
    const CLICK_INTERVAL_MS = 50;
    // Movement is not rate-limited; this only keeps a run watchable.
    const CRAWLER_INTERVAL_MS = 100;
    // A runaway guard, not a throttle.
    const MAX_MOVES_PER_TICK = 6;
    const PANEL_REFRESH_INTERVAL_MS = 500;
    // Timed: "reached level 100" has no observable to subscribe to.
    const HATCHERY_AUTO_FILL_INTERVAL_MS = 2000;

    // Only G J N V X Y Z are unbound by the game; see its HotkeySetting block.
    const CRAWLER_TOGGLE_KEY = 'j';
    const CLICKER_TOGGLE_KEY = 'n';
    const FILL_HATCHERY_KEY = 'g';

    const DEFAULT_DUNGEON_RUNS = 1;

    // Three intents, kept apart rather than blended.
    const CrawlerMode = {
        bossRush: 'bossRush',
        allChests: 'allChests',
        clearEnemies: 'clearEnemies',
    };

    const CRAWLER_MODE_LABELS = {
        bossRush: 'Boss rush',
        allChests: 'All chests',
        clearEnemies: 'All enemies',
    };

    // Distance is divided by priority, so higher pulls a rarity forward.
    const DEFAULT_CHEST_PRIORITIES = {
        common: 1,
        rare: 1.25,
        epic: 1.5,
        legendary: 1.75,
        mythic: 2,
    };
    // A zero would divide by zero, a negative would invert the ordering.
    const MINIMUM_CHEST_PRIORITY = 0.1;

    const CHEST_RARITIES = Object.keys(DEFAULT_CHEST_PRIORITIES);

    let isCrawlerRunning = false;
    let isClickerRunning = false;
    let isFrontierRestartRunning = false;
    let isHatcheryAutoFillRunning = false;
    let crawlerMode = CrawlerMode.allChests;
    let dungeonRunsRequested = DEFAULT_DUNGEON_RUNS;
    // Attempts drive the stop condition; clears are only reported.
    let dungeonRunsAttempted = 0;
    let dungeonRunsCleared = 0;
    // Stop is graceful: the attempt already paid for plays out first.
    let shouldStopAfterCurrentRun = false;

    // Per rarity: whether to collect it, and how hard to prioritise it.
    const chestSettings = {};
    CHEST_RARITIES.forEach((rarity) => {
        chestSettings[rarity] = { isEnabled: true, priority: DEFAULT_CHEST_PRIORITIES[rarity] };
    });
    // An unreported tier is collected rather than silently skipped.
    const UNKNOWN_CHEST_SETTING = { isEnabled: true, priority: 1 };


    const tileTypes = () => GameConstants.DungeonTileType;
    const gameStates = () => GameConstants.GameState;

    const notify = (message) => {
        Notifier.notify({
            title: '[HELPER]',
            message,
            type: NotificationConstants.NotificationOption.info,
            timeout: 5000,
        });
    };

    // ---------------------------------------------------------------------
    // Shared DOM helpers
    // ---------------------------------------------------------------------

    const buildElement = (tagName, className, textContent) => {
        const element = document.createElement(tagName);
        if (className) {
            element.className = className;
        }
        if (textContent !== undefined) {
            element.textContent = textContent;
        }
        return element;
    };

    const buildNumberInput = (value, minimum) => {
        const input = buildElement('input', 'form-control');
        input.type = 'number';
        input.min = String(minimum);
        input.value = String(value);
        input.style.width = '5.5rem';
        return input;
    };

    // Bootstrap draws the track on the label, so a mismatched `for` breaks it.
    const buildSwitch = (elementId, labelText) => {
        const row = buildElement('div', 'custom-control custom-switch');
        const input = buildElement('input', 'custom-control-input');
        input.type = 'checkbox';
        input.id = elementId;
        const label = buildElement('label', 'custom-control-label', labelText);
        label.setAttribute('for', elementId);
        // The theme sizes this below the card's 15px.
        label.style.fontSize = 'inherit';
        row.appendChild(input);
        row.appendChild(label);
        return { row, input, label };
    };

    const buildRow = () => {
        const row = buildElement('div', 'd-flex align-items-center mb-2');
        row.style.gap = '0.375rem';
        return row;
    };

    const setButtonVariant = (button, variant, label) => {
        button.className = button.className.replace(/\bbtn-(success|secondary|danger|primary|warning)\b/g, '').trim();
        button.classList.add(`btn-${variant}`);
        button.textContent = label;
    };

    const setButtonState = (button, isActive, label) => {
        setButtonVariant(button, isActive ? 'success' : 'secondary', label);
    };

    // Forwards arguments so the same wrapper can guard the keydown listener.
    const guardedTick = (label, tick) => (...tickArguments) => {
        try {
            tick(...tickArguments);
        } catch (error) {
            console.error(`[helper] ${label} failed:`, error);
        }
    };

    /* ===================== panel          ===================== */
// The Helper card, and the row modules register their toggles into.

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------

    // One registry across four hosts, populated one at a time during boot,
    // so each refresh guards its own group.
    const controlElements = {};

    const PANEL_ID = 'helperPanel';
    const PANEL_BODY_ID = 'helperPanelBody';
    const CRAWLER_PANEL_ID = 'helperCrawlerPanel';
    const CRAWLER_PANEL_BODY_ID = 'helperCrawlerPanelBody';
    const COLLAPSED_STORAGE_PREFIX = 'pokeclicker-helper.collapsed.';

    const readPanelCollapsed = (bodyId) => {
        try {
            return localStorage.getItem(COLLAPSED_STORAGE_PREFIX + bodyId) === 'true';
        } catch (error) {
            return false;
        }
    };

    const writePanelCollapsed = (bodyId, isCollapsed) => {
        try {
            localStorage.setItem(COLLAPSED_STORAGE_PREFIX + bodyId, String(isCollapsed));
        } catch (error) {
            // Private windows: it just opens expanded next time.
        }
    };

    // Plain DOM: ko.applyBindings already ran. Collapse copies the game's cards.
    // State in localStorage - Settings would leave keys in the save.
    const buildCard = (panelId, bodyId, title, extraPanelClasses) => {
        const panel = buildElement('div', `card ${extraPanelClasses} border-secondary mb-3`);
        panel.id = panelId;

        const header = buildElement('div', 'card-header p-0');
        header.setAttribute('data-toggle', 'collapse');
        header.setAttribute('href', `#${bodyId}`);
        header.style.textAlign = 'center';
        header.style.cursor = 'pointer';
        header.appendChild(buildElement('span', null, title));
        panel.appendChild(header);

        const body = buildElement('div', `card-body p-2 collapse${readPanelCollapsed(bodyId) ? '' : ' show'}`);
        body.id = bodyId;
        panel.appendChild(body);

        if (typeof $ !== 'undefined') {
            $(body).on('show.bs.collapse', () => writePanelCollapsed(bodyId, false));
            $(body).on('hide.bs.collapse', () => writePanelCollapsed(bodyId, true));
        }

        return { panel, body };
    };

    // Modules register their own switch; registration order is display order.
    const panelToggles = [];

    const contributeToggle = (elementId, labelText, isOn, setOn) => {
        panelToggles.push({ elementId, labelText, isOn, setOn, input: null });
    };

    const buildPanel = () => {
        const { panel, body } = buildCard(PANEL_ID, PANEL_BODY_ID, 'Helper', 'sortable');

        // A pair needs ~320px; flex-wrap covers a narrower host.
        const togglesRow = buildRow();
        togglesRow.classList.add('flex-wrap');
        togglesRow.style.gap = '0.75rem';

        panelToggles.forEach((toggle) => {
            const builtSwitch = buildSwitch(toggle.elementId, toggle.labelText);
            builtSwitch.input.addEventListener('change', () => {
                toggle.setOn(builtSwitch.input.checked);
                refreshPanel();
            });
            builtSwitch.row.classList.add('flex-fill', 'text-nowrap');
            togglesRow.appendChild(builtSwitch.row);
            toggle.input = builtSwitch.input;
        });
        body.appendChild(togglesRow);

        controlElements.panel = panel;
        return panel;
    };

    // Mirrors each flag onto its switch, keeping hotkeys and panel in agreement.
    const refreshPanelButtons = () => {
        panelToggles.forEach((toggle) => {
            if (toggle.input) {
                toggle.input.checked = toggle.isOn();
            }
        });
    };

    function refreshPanel() {
        refreshPanelButtons();
        refreshCrawlerControls();
        refreshHatcheryButton();
    }

    // Each column keeps its own order setting, and the cards are in different ones.
    const savedColumnOrder = (columnId) => {
        try {
            return String(Settings.getSetting(`modules.${columnId}`).observableValue() ?? '')
                .split('|').filter(Boolean);
        } catch (error) {
            return [];
        }
    };

    // The game's reorder pass skips these cards, so replay it here.
    const applySavedPanelPosition = (panel) => {
        const column = panel.parentNode;
        const order = savedColumnOrder(column.id);
        const panelIndex = order.indexOf(panel.id);
        if (panelIndex === -1) {
            return;
        }

        // Nearest saved neighbour still here; cards move columns or disappear.
        for (let index = panelIndex - 1; index >= 0; index--) {
            const previous = document.getElementById(order[index]);
            if (previous && previous.parentNode === column) {
                const reference = previous.nextSibling;
                // insertBefore(panel, panel) only works by spec special case.
                if (reference !== panel) {
                    column.insertBefore(panel, reference);
                }
                return;
            }
        }
        // When already first, firstChild IS the panel.
        if (column.firstChild !== panel) {
            column.insertBefore(panel, column.firstChild);
        }
    };

    // The game's own id is misspelled ("achivement"), so both are tried.
    const findTrackerContainer = () => document.getElementById('achivementTrackerContainer')
        ?? document.getElementById('achievementTrackerContainer');

    // Defaults first, then any dragged position overrides.
    const placeAllPanels = () => {
        const panel = controlElements.panel;
        const crawlerPanel = controlElements.crawlerPanel;
        if (!panel) {
            return false;
        }

        // Under the currency container; the tracker only covers a rename.
        const topAnchor = document.getElementById('currencyContainer') ?? findTrackerContainer();
        if (!topAnchor?.parentNode) {
            return false;
        }
        topAnchor.parentNode.insertBefore(panel, topAnchor.nextSibling);

        // Above the town map, which puts it between the battle view and the map.
        if (crawlerPanel) {
            const townMap = document.getElementById('townMap');
            const bottomColumn = document.getElementById('middle-bottom-sort-column');
            if (townMap?.parentNode) {
                townMap.parentNode.insertBefore(crawlerPanel, townMap);
            } else if (bottomColumn) {
                bottomColumn.appendChild(crawlerPanel);
            } else {
                panel.parentNode.insertBefore(crawlerPanel, panel.nextSibling);
            }
        }

        // Saved order, not build order, or a card anchors to an unmoved neighbour.
        [panel, crawlerPanel]
            .filter((card) => card && savedColumnOrder(card.parentNode.id).includes(card.id))
            .sort((left, right) => savedColumnOrder(left.parentNode.id).indexOf(left.id)
                - savedColumnOrder(right.parentNode.id).indexOf(right.id))
            .forEach(applySavedPanelPosition);
        return true;
    };

    const insertPanel = () => {
        if (document.getElementById(PANEL_ID)) {
            return true;
        }
        if (!document.getElementById('currencyContainer') && !findTrackerContainer()) {
            return false;
        }
        buildPanel();
        buildCrawlerPanel();
        placeAllPanels();
        refreshPanel();
        return true;
    };

    // SortModules runs from Save.load, long after document-idle, and strands
    // anything inserted earlier.
    const patchSortModules = () => {
        if (typeof window === 'undefined' || typeof SortModules !== 'function') {
            return;
        }
        const originalSortModules = SortModules;
        window.SortModules = (...sortArguments) => {
            const result = originalSortModules(...sortArguments);
            placeAllPanels();
            return result;
        };
    };

    /* ===================== auto-clicker   ===================== */
// Click attacks wherever the game exposes one.

    // ---------------------------------------------------------------------
    // Auto clicker
    // ---------------------------------------------------------------------

    // Only states whose view exposes a click attack; Battle Frontier has none.
    // Dungeons go direct: handleInteraction would leave from the entrance.
    const clickAttack = () => {
        switch (App.game.gameState) {
            case gameStates().fighting:
                Battle.clickAttack();
                break;
            case gameStates().gym:
                GymBattle.clickAttack();
                break;
            case gameStates().dungeon:
                if (DungeonRunner.fighting() && !DungeonBattle.catching()) {
                    DungeonBattle.clickAttack();
                }
                break;
            case gameStates().temporaryBattle:
                TemporaryBattleBattle.clickAttack();
                break;
            default:
                break;
        }
    };

    const clickerTick = () => {
        if (!isClickerRunning || !App.game) {
            return;
        }
        clickAttack();
    };

    contributeToggle('helperClickerSwitch', 'Auto clicker',
        () => isClickerRunning,
        (isOn) => { isClickerRunning = isOn; });

    /* ===================== frontier-restart ===================== */
// Restarts a Battle Frontier run after a loss.

    // ---------------------------------------------------------------------
    // Battle Frontier auto restart
    // ---------------------------------------------------------------------

    // battleLost is the game's own loss signal; battleQuit never reaches it.
    // start(true) skips the confirm start(false) would block on.
    const patchBattleLost = () => {
        const originalBattleLost = BattleFrontierRunner.battleLost.bind(BattleFrontierRunner);
        BattleFrontierRunner.battleLost = (...lostArguments) => {
            const result = originalBattleLost(...lostArguments);
            if (isFrontierRestartRunning) {
                // tick() carries on and subtracts one GYM_TICK from the timer
                // start() just reset. One tick of drift, not worth deferring for.
                BattleFrontierRunner.start(true);
            }
            return result;
        };
    };

    contributeToggle('helperFrontierSwitch', 'Frontier restart',
        () => isFrontierRestartRunning,
        (isOn) => { isFrontierRestartRunning = isOn; });

    /* ===================== crawler        ===================== */
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

    const stopCrawler = (message) => {
        isCrawlerRunning = false;
        shouldStopAfterCurrentRun = false;
        if (message) {
            notify(message);
        }
        refreshPanel();
    };

    // Re-enters the dungeon the player is standing on top of, the way
    // DungeonGuide.end does when it has clears left to spend.
    const startNextDungeonRun = () => {
        const dungeon = player.town?.dungeon;
        if (!dungeon) {
            stopCrawler('Stopped — not standing on a dungeon');
            return;
        }
        if (!DungeonRunner.canStartDungeon(dungeon)) {
            stopCrawler(`Stopped after ${dungeonRunsAttempted} — cannot enter (tokens or requirements)`);
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
            stopCrawler(`Ran ${dungeonRunsAttempted} dungeon${dungeonRunsAttempted === 1 ? '' : 's'} — ${dungeonRunsCleared} cleared`);
            return;
        }

        // The graceful stop lands here rather than mid-run, so the dungeon tokens
        // already spent on this attempt are not thrown away.
        if (shouldStopAfterCurrentRun) {
            stopCrawler(`Stopped after ${dungeonRunsAttempted} of ${dungeonRunsRequested} — ${dungeonRunsCleared} cleared`);
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

    /* ===================== hatchery       ===================== */
// Filling the hatchery and queue, and its controls in the breeding modal.

    // ---------------------------------------------------------------------
    // Hatchery fill
    // ---------------------------------------------------------------------

    // Rebuilds the modal's order from public pieces: BreedingController's own
    // computed is private and pauses while the modal is closed.
    const hatcheryCandidates = () => {
        const regionalDebuff = App.game.challenges.list.regionalAttackDebuff.active()
            ? Settings.getSetting('breedingRegionalAttackDebuffSetting').observableValue()
            : -1;

        const candidates = App.game.party.caughtPokemon.filter((pokemon) => pokemon.isHatchableFiltered());
        candidates.sort(PartyController.compareBy(
            Settings.getSetting('hatcherySort').observableValue(),
            Settings.getSetting('hatcherySortDirection').observableValue(),
            regionalDebuff,
        ));
        return candidates;
    };

    // How many Pokemon can still be accepted right now, counting egg slots first
    // and then the queue, the same order addPokemonToHatchery fills them.
    const hatcheryCapacity = () => {
        const breeding = App.game.breeding;

        // Mirrors hasFreeEggSlot: a slot is taken when it holds an egg, or when a
        // hired hatchery helper occupies it.
        const occupiedEggSlots = breeding.eggList
            .filter((eggObservable, slotIndex) => !eggObservable().isNone() || breeding.hatcheryHelpers.hired()[slotIndex])
            .length;
        const freeEggSlots = Math.max(0, breeding.eggSlots - occupiedEggSlots);

        // usableQueueSlots already folds in breedingQueueSizeSetting, which can
        // cap the queue below the queueSlots the save actually owns.
        const freeQueueSlots = Math.max(0, breeding.usableQueueSlots() - breeding.queueList().length);

        return freeEggSlots + freeQueueSlots;
    };

    // Bounded by capacity and by matches, so it cannot overshoot or trip
    // addPokemonToHatchery's "full" warning.
    const runHatcheryFillPass = (wantedCount) => {
        const breeding = App.game.breeding;

        // Never cached, so a Pokemon that just reached level 100 is picked up.
        const candidates = hatcheryCandidates();
        const capacity = hatcheryCapacity();
        const targetCount = Math.min(wantedCount, capacity, candidates.length);

        let addedCount = 0;
        for (const pokemon of candidates) {
            if (addedCount >= targetCount) {
                break;
            }
            // Should not reject; without the stop a rejection would notify per item.
            if (!breeding.addPokemonToHatchery(pokemon)) {
                break;
            }
            addedCount++;
        }

        // Adding sets pokemon.breeding, so no entry can be picked up twice.
        return addedCount;
    };

    // Fills to capacity. Not configurable - there is only one sensible amount.
    const fillHatcheryToCapacity = () => {
        if (!App.game?.party) {
            return;
        }

        const capacity = hatcheryCapacity();
        if (capacity <= 0) {
            notify('Hatchery and queue are already full');
            return;
        }

        const addedCount = runHatcheryFillPass(capacity);

        if (addedCount === 0) {
            notify('No hatchable Pokemon match the current filters');
        } else if (addedCount < capacity) {
            notify(`Queued ${addedCount} Pokemon — no more match the current filters`);
        } else {
            notify(`Queued ${addedCount} Pokemon — hatchery and queue are now full`);
        }
        refreshPanel();
    };

    // Tops the hatchery up as slots free and Pokemon become eligible. Silent by
    // design: a notification every couple of seconds would be unusable.
    const hatcheryAutoFillTick = () => {
        if (!isHatcheryAutoFillRunning || !App.game?.party) {
            return;
        }
        if (hatcheryCapacity() <= 0) {
            return;
        }

        if (runHatcheryFillPass(hatcheryCapacity()) > 0) {
            refreshHatcheryButton();
        }
    };

    // ---------------------------------------------------------------------
    // Hatchery controls
    // ---------------------------------------------------------------------

    let hatcheryButtonElement = null;
    let hatcheryAutoFillButtonElement = null;

    // The breeding modal's warning row has no id, so reach it via a warning.
    const insertHatcheryButton = () => {
        if (hatcheryButtonElement) {
            return true;
        }
        const warningButton = document.querySelector('#breedingModal .hatchery-warnings');
        const warningsRow = warningButton?.parentNode;
        if (!warningsRow) {
            return false;
        }

        const button = buildElement('button', 'btn ml-2');
        button.type = 'button';
        button.id = 'helperQueueHatchery';
        button.addEventListener('click', fillHatcheryToCapacity);
        warningsRow.appendChild(button);
        hatcheryButtonElement = button;

        // A button, not a switch: this row is already a line of buttons. Stays
        // visible when the queue button hides, or auto-fill could not be undone.
        const autoFillButton = buildElement('button', 'btn ml-2');
        autoFillButton.type = 'button';
        autoFillButton.id = 'helperAutoFillHatchery';
        autoFillButton.addEventListener('click', () => {
            isHatcheryAutoFillRunning = !isHatcheryAutoFillRunning;
            if (isHatcheryAutoFillRunning) {
                hatcheryAutoFillTick();
            }
            refreshHatcheryButton();
        });
        warningsRow.appendChild(autoFillButton);
        hatcheryAutoFillButtonElement = autoFillButton;
        // The panel refresh ran before this existed; without it, blank for 500ms.
        refreshHatcheryButton();
        return true;
    };

    // Capacity is cheap enough for every refresh; the candidate list is not,
    // so it is built only on press.
    const refreshHatcheryButton = () => {
        if (!hatcheryButtonElement) {
            return;
        }

        setButtonState(hatcheryAutoFillButtonElement, isHatcheryAutoFillRunning,
            `Auto-fill: ${isHatcheryAutoFillRunning ? 'ON' : 'OFF'}`);

        // Hidden, not disabled: the game's own "queue is full" warning is here.
        const capacity = App.game?.breeding ? hatcheryCapacity() : 0;
        hatcheryButtonElement.style.display = capacity > 0 ? '' : 'none';
        if (capacity > 0) {
            setButtonVariant(hatcheryButtonElement, 'success', `Queue ${capacity} Pokemon`);
        }
    };

    /* ===================== bulk-selling   ===================== */
// Selling every Underground item of a value type at once.

    // ---------------------------------------------------------------------
    // Underground bulk selling
    // ---------------------------------------------------------------------

    // gainProfit returns false for every value type but these two. Gems land
    // in eighteen per-type wallets, so only diamonds report a figure.
    const UNDERGROUND_SELL_TYPES = [
        { valueTypeName: 'Diamond', currencyLabel: 'Diamonds', reportsGain: true },
        { valueTypeName: 'Gem', currencyLabel: 'Gems', reportsGain: false },
    ];

    // Read the balance rather than predict it.
    const diamondBalance = () => App.game.wallet.currencies[GameConstants.Currency.diamond]();

    const sellAllUndergroundItems = ({ valueTypeName, currencyLabel, reportsGain }) => {
        const valueType = UndergroundItemValueType[valueTypeName];
        const owned = UndergroundItems.getUnlockedItems()
            .filter((item) => item.valueType === valueType && player.itemList[item.itemName]() > 0);

        // Guards sellLocked, which is dev scaffolding for unreleased content.
        const lockedCount = owned.filter((item) => item.sellLocked()).length;
        const sellable = owned.filter((item) => !item.sellLocked());

        const balanceBefore = reportsGain ? diamondBalance() : 0;
        let soldCount = 0;
        sellable.forEach((item) => {
            const amount = player.itemList[item.itemName]();
            UndergroundController.sellMineItem(item, amount);
            soldCount += amount;
        });

        const gainedNote = reportsGain
            ? `${(diamondBalance() - balanceBefore).toLocaleString('en-US')} ${currencyLabel}`
            : currencyLabel;
        const lockedNote = lockedCount ? ` — ${lockedCount} locked kind${lockedCount === 1 ? '' : 's'} kept` : '';
        notify(soldCount
            ? `Sold ${soldCount.toLocaleString('en-US')} item${soldCount === 1 ? '' : 's'} for ${gainedNote}${lockedNote}`
            : `Nothing to sell for ${currencyLabel}${lockedNote}`);
    };

    // ---------------------------------------------------------------------
    // Bulk selling controls
    // ---------------------------------------------------------------------

    // The Quick-Sell button has no id, so its data-bind is the anchor.
    const insertUndergroundSellButtons = () => {
        if (document.getElementById('helperSellAllDiamond')) {
            return true;
        }
        const quickSellButton = document.querySelector('#treasures button[data-bind*="quickSellEnabled"]');
        const formGroup = quickSellButton?.parentNode;
        if (!formGroup) {
            return false;
        }

        UNDERGROUND_SELL_TYPES.forEach((sellType) => {
            const button = buildElement('button', quickSellButton.className, `Sell all for ${sellType.currencyLabel}`);
            button.type = 'button';
            button.id = `helperSellAll${sellType.valueTypeName}`;
            button.addEventListener('click', () => sellAllUndergroundItems(sellType));
            formGroup.appendChild(button);
        });

        return true;
    };

    /* ===================== boot           ===================== */
// Hotkeys, timers and start-up. Loaded last.

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    const handleKeyDown = (event) => {
        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }
        if (event.target.matches('input, textarea, [contenteditable]')) {
            return;
        }

        const pressedKey = event.key.toLowerCase();
        if (pressedKey === CRAWLER_TOGGLE_KEY) {
            // Inert away from a dungeon. Stopping is always allowed.
            if (!isCrawlerRunning && !isAtDungeon()) {
                return;
            }
            toggleCrawler();
        } else if (pressedKey === CLICKER_TOGGLE_KEY) {
            isClickerRunning = !isClickerRunning;
            notify(`Auto clicker ${isClickerRunning ? 'ON' : 'OFF'}`);
            refreshPanel();
        } else if (pressedKey === FILL_HATCHERY_KEY) {
            fillHatcheryToCapacity();
        }
    };

    const boot = () => {
        const isGameReady = typeof DungeonRunner !== 'undefined'
            && typeof Battle !== 'undefined'
            && typeof PartyController !== 'undefined'
            && typeof BattleFrontierRunner !== 'undefined'
            && typeof Point !== 'undefined'
            && typeof App !== 'undefined'
            && typeof Notifier !== 'undefined';

        if (!isGameReady) {
            setTimeout(boot, 500);
            return;
        }

        // Idempotent, so a retry cannot duplicate an earlier control.
        const isEverythingInserted = insertPanel()
            && insertHatcheryButton() && insertUndergroundSellButtons();
        if (!isEverythingInserted) {
            setTimeout(boot, 500);
            return;
        }

        patchBattleLost();
        patchSortModules();
        patchDungeonLeave();
        DungeonRunner.dungeonFinished.subscribe(guardedTick('dungeon finished', handleDungeonFinished));

        setInterval(guardedTick('auto clicker', clickerTick), CLICK_INTERVAL_MS);
        setInterval(guardedTick('dungeon crawler', crawlerTick), CRAWLER_INTERVAL_MS);
        setInterval(guardedTick('panel refresh', refreshPanel), PANEL_REFRESH_INTERVAL_MS);
        setInterval(guardedTick('hatchery auto-fill', hatcheryAutoFillTick), HATCHERY_AUTO_FILL_INTERVAL_MS);
        document.addEventListener('keydown', guardedTick('hotkey', handleKeyDown));

        console.log('[helper] ready'
            + `\n  ${CRAWLER_TOGGLE_KEY.toUpperCase()} — start/stop dungeon crawler`
            + `\n  ${CLICKER_TOGGLE_KEY.toUpperCase()} — toggle auto clicker`
            + `\n  ${FILL_HATCHERY_KEY.toUpperCase()} — fill the hatchery and queue`);
    };

    boot();
})();
