// ==UserScript==
// @name         PokeClicker Helper
// @namespace    https://github.com/hanqinilnix/pokeclicker-helper-tools
// @version      1.4.0
// @description  Dungeon crawler, safari crawler, auto mining, auto farm, auto clicker, hatchery filler and quest automation for PokeClicker
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
    // Battle.clickAttack drops anything inside 50ms.
    const CLICK_INTERVAL_MS = 50;
    // Movement is not rate-limited; this only keeps a run watchable.
    const CRAWLER_INTERVAL_MS = 100;
    // A runaway guard, not a throttle.
    const MAX_MOVES_PER_TICK = 6;
    const PANEL_REFRESH_INTERVAL_MS = 500;
    // Timed: "reached level 100" has no observable to subscribe to.
    const HATCHERY_AUTO_FILL_INTERVAL_MS = 2000;
    // UndergroundController caps the mine at 20 clicks a second.
    const MINING_INTERVAL_MS = 50;
    // Under the 250ms safari step, so every tile is steered before it ends.
    const SAFARI_INTERVAL_MS = 60;
    // Berries take minutes at best; this only has to beat the eye.
    const FARM_INTERVAL_MS = 1000;

    // Only G J N V X Y Z are unbound by the game; see its HotkeySetting block.
    const CRAWLER_TOGGLE_KEY = 'j';
    const CLICKER_TOGGLE_KEY = 'n';
    const FILL_HATCHERY_KEY = 'g';
    const SAFARI_TOGGLE_KEY = 'v';
    const MINING_TOGGLE_KEY = 'x';

    const DEFAULT_DUNGEON_RUNS = 1;
    // Nine spins uncover the nine Alcremie forms a sweet can produce.
    const DEFAULT_ALCREMIE_SPINS = 9;
    const DEFAULT_SAFARI_RUNS = 1;
    // Costlier, not banned: a long enough detour loses to crossing grass.
    const SAFARI_ENCOUNTER_TILE_COST = 8;

    // Three intents, kept apart rather than blended.
    const CrawlerMode = {
        bossRush: 'bossRush',
        allChests: 'allChests',
        clearEnemies: 'clearEnemies',
    };

    // What the farm is being driven towards; each picks its own layout.
    const FarmMode = {
        layout: 'layout',
        farmPoints: 'farmPoints',
        alcremie: 'alcremie',
        mutation: 'mutation',
    };

    const FARM_MODE_LABELS = {
        layout: 'Layout',
        farmPoints: 'Farm Points',
        alcremie: 'Alcremie',
        mutation: 'Mutation',
    };

    const DEFAULT_FARM_PRESET = 'harvest';

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
    let isMiningRunning = false;
    let isSafariRunning = false;
    let isFarmRunning = false;
    let safariRunsRequested = DEFAULT_SAFARI_RUNS;
    let safariRunsCompleted = 0;
    let crawlerMode = CrawlerMode.allChests;
    let farmMode = FarmMode.layout;
    let farmPreset = DEFAULT_FARM_PRESET;
    let farmTargetBerry = null;
    let farmMutationBerry = null;
    let alcremieSpinsWanted = DEFAULT_ALCREMIE_SPINS;
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

    // ---------------------------------------------------------------------
    // Saved preferences
    // ---------------------------------------------------------------------

    // Choices only, never a run in progress; Settings would leave keys in the save.
    const PREFERENCES_STORAGE_KEY = 'pokeclicker-helper.preferences';

    const currentPreferences = () => ({
        isClickerRunning,
        isFrontierRestartRunning,
        isHatcheryAutoFillRunning,
        isMiningRunning,
        isFarmRunning,
        crawlerMode,
        farmMode,
        farmPreset,
        farmTargetBerry,
        farmMutationBerry,
        alcremieSpinsWanted,
        dungeonRunsRequested,
        safariRunsRequested,
        chestSettings,
    });

    let lastSavedPreferences = null;

    // Only writes when something changed, so the panel refresh can call it.
    const savePreferences = () => {
        const serialized = JSON.stringify(currentPreferences());
        if (serialized === lastSavedPreferences) {
            return;
        }
        try {
            localStorage.setItem(PREFERENCES_STORAGE_KEY, serialized);
            lastSavedPreferences = serialized;
        } catch (error) {
            // Private windows: preferences just reset next time.
        }
    };

    const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

    // Each field is checked on its own, so one bad value costs only itself.
    const loadPreferences = () => {
        let stored;
        try {
            stored = JSON.parse(localStorage.getItem(PREFERENCES_STORAGE_KEY));
        } catch (error) {
            return;
        }
        if (!stored || typeof stored !== 'object') {
            return;
        }
        lastSavedPreferences = JSON.stringify(stored);

        if (typeof stored.isClickerRunning === 'boolean') {
            isClickerRunning = stored.isClickerRunning;
        }
        if (typeof stored.isFrontierRestartRunning === 'boolean') {
            isFrontierRestartRunning = stored.isFrontierRestartRunning;
        }
        if (typeof stored.isHatcheryAutoFillRunning === 'boolean') {
            isHatcheryAutoFillRunning = stored.isHatcheryAutoFillRunning;
        }
        if (typeof stored.isMiningRunning === 'boolean') {
            isMiningRunning = stored.isMiningRunning;
        }
        if (typeof stored.isFarmRunning === 'boolean') {
            isFarmRunning = stored.isFarmRunning;
        }
        if (Object.values(CrawlerMode).includes(stored.crawlerMode)) {
            crawlerMode = stored.crawlerMode;
        }
        if (Object.values(FarmMode).includes(stored.farmMode)) {
            farmMode = stored.farmMode;
        }
        if (typeof stored.farmPreset === 'string') {
            farmPreset = stored.farmPreset;
        }
        // Berry ids, not names: validated against the game only once it is loaded.
        if (Number.isInteger(stored.farmTargetBerry)) {
            farmTargetBerry = stored.farmTargetBerry;
        }
        if (Number.isInteger(stored.farmMutationBerry)) {
            farmMutationBerry = stored.farmMutationBerry;
        }
        if (isPositiveInteger(stored.alcremieSpinsWanted)) {
            alcremieSpinsWanted = stored.alcremieSpinsWanted;
        }
        if (isPositiveInteger(stored.dungeonRunsRequested)) {
            dungeonRunsRequested = stored.dungeonRunsRequested;
        }
        if (isPositiveInteger(stored.safariRunsRequested)) {
            safariRunsRequested = stored.safariRunsRequested;
        }
        CHEST_RARITIES.forEach((rarity) => {
            const storedChest = stored.chestSettings?.[rarity];
            if (typeof storedChest?.isEnabled === 'boolean') {
                chestSettings[rarity].isEnabled = storedChest.isEnabled;
            }
            if (Number.isFinite(storedChest?.priority) && storedChest.priority >= MINIMUM_CHEST_PRIORITY) {
                chestSettings[rarity].priority = storedChest.priority;
            }
        });
    };

    // Before any card is built, so every control starts from the saved value.
    loadPreferences();


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

    // The Dungeon Guide's sound, so the player's own setting for it applies.
    const playDoneSound = () => {
        try {
            NotificationConstants.NotificationSound.General.dungeon_guide_complete.play();
        } catch (error) {
            // Sounds are optional; the notification still says it is done.
        }
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

    const buildSelect = (elementId) => {
        const select = buildElement('select', 'form-control');
        select.id = elementId;
        return select;
    };

    // Rebuilt only when the choices themselves change, or a refresh would throw
    // away whatever the player had just picked.
    const fillSelect = (select, options, selectedValue) => {
        const signature = options.map((option) => `${option.value}:${option.label}`).join('|');
        if (select.getAttribute('data-signature') !== signature) {
            select.setAttribute('data-signature', signature);
            select.textContent = '';
            options.forEach((option) => {
                const element = buildElement('option', null, option.label);
                element.value = String(option.value);
                select.appendChild(element);
            });
        }
        select.value = String(selectedValue);
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

    // A covered window throttles main-thread timers about tenfold; worker timers
    // are exempt, which is how Game.ts keeps its own tick rate. Falls back to
    // setInterval where Worker is unavailable.
    const startTicks = (ticks) => {
        const handlers = ticks.map((tick) => guardedTick(tick.label, tick.run));

        if (typeof Worker !== 'undefined') {
            try {
                const source = 'onmessage=(e)=>e.data.forEach((ms,i)=>setInterval(()=>postMessage(i),ms))';
                const worker = new Worker(URL.createObjectURL(new Blob([source])));
                worker.onmessage = (event) => handlers[event.data]();
                worker.postMessage(ticks.map((tick) => tick.interval));
                return 'worker';
            } catch (error) {
                console.error('[helper] worker timers unavailable:', error);
            }
        }

        ticks.forEach((tick, index) => setInterval(handlers[index], tick.interval));
        return 'setInterval';
    };

    /* ===================== panel          ===================== */
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

    // Modules register their own cell; registration order is left to right.
    const panelToggles = [];

    const contributeToggle = (elementId, labelText, description, isOn, setOn) => {
        panelToggles.push({ elementId, labelText, description, isOn, setOn, cell: null });
    };

    // Bootstrap prefers a title attribute over the option, so it is only a fallback.
    const attachTooltip = (element, title, placement) => {
        if (typeof $ === 'function' && typeof $(element).tooltip === 'function') {
            $(element).tooltip({ title, trigger: 'hover', placement, html: true, boundary: 'window', animation: false });
        } else {
            element.title = title.replace(/<br>/g, '\n');
        }
    };

    // Built from the key constants, so it cannot drift from the handler.
    const helpTooltip = () => [
        `${CRAWLER_TOGGLE_KEY.toUpperCase()} - start/stop dungeon crawler`,
        `${SAFARI_TOGGLE_KEY.toUpperCase()} - start/stop auto safari (in the Safari Zone)`,
        `${CLICKER_TOGGLE_KEY.toUpperCase()} - toggle auto clicker`,
        `${MINING_TOGGLE_KEY.toUpperCase()} - toggle auto mining`,
        `${FILL_HATCHERY_KEY.toUpperCase()} - fill the hatchery and queue`,
    ].join('<br>');

    const buildPanel = () => {
        const { panel, body } = buildCard(PANEL_ID, PANEL_BODY_ID, 'Helper', 'sortable');
        // Flush like the Poke Balls card, so the cells reach the card edges.
        body.classList.remove('p-2');
        body.classList.add('p-0');

        // Copied off the Poke Balls card's "?" button, styles and all.
        const helpButton = buildElement('button', 'btn btn-info', '?');
        helpButton.type = 'button';
        helpButton.id = 'helperHelpButton';
        Object.assign(helpButton.style, {
            position: 'absolute', right: '0px', top: '0px', width: 'auto', height: '41px', padding: '4px',
        });
        attachTooltip(helpButton, helpTooltip(), 'left');
        panel.insertBefore(helpButton, body);

        // Fixed layout so the cells split the width evenly.
        const table = buildElement('table', 'table table-sm m-0');
        table.style.tableLayout = 'fixed';
        const tableBody = buildElement('tbody');
        const row = buildElement('tr');
        panelToggles.forEach((toggle, index) => {
            const isLast = index === panelToggles.length - 1;
            const cell = buildElement('td', `align-middle text-center${isLast ? '' : ' border-right'}`);
            cell.id = toggle.elementId;
            cell.style.padding = '0.3rem';
            cell.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                toggle.setOn(!toggle.isOn());
                refreshPanel();
            });

            const name = buildElement('span', null, toggle.labelText);
            attachTooltip(name, toggle.description, 'top');
            cell.appendChild(name);
            row.appendChild(cell);
            toggle.cell = cell;
        });
        tableBody.appendChild(row);
        table.appendChild(tableBody);
        body.appendChild(table);

        controlElements.panel = panel;
        return panel;
    };

    // The game's grey-out rule is scoped to #pokeballSelector, so its colours are copied.
    const refreshPanelButtons = () => {
        panelToggles.forEach((toggle) => {
            if (!toggle.cell) {
                return;
            }
            const isOn = toggle.isOn();
            toggle.cell.style.backgroundColor = isOn ? '' : 'gray';
            toggle.cell.style.color = isOn ? '' : 'lightgray';
        });
    };

    function refreshPanel() {
        refreshPanelButtons();
        refreshCrawlerControls();
        refreshHatcheryButton();
        refreshSafariButton();
        refreshFarmTab();
        savePreferences();
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

    contributeToggle('helperClickerToggle', 'Auto Clicker [N]',
        'Click attacks on routes, gyms, dungeons and temporary battles.',
        () => isClickerRunning,
        (isOn) => { isClickerRunning = isOn; });

    /* ===================== frontier-restart ===================== */
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

    contributeToggle('helperFrontierToggle', 'Frontier Restart',
        'Starts a new Battle Frontier run when one ends in a loss.',
        () => isFrontierRestartRunning,
        (isOn) => { isFrontierRestartRunning = isOn; });

    /* ===================== crawler        ===================== */
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

    /* ===================== safari         ===================== */
    // ---------------------------------------------------------------------
    // Safari walking
    // ---------------------------------------------------------------------

    const SAFARI_DIRECTIONS = [
        { name: 'up', x: 0, y: -1 },
        { name: 'down', x: 0, y: 1 },
        { name: 'left', x: -1, y: 0 },
        { name: 'right', x: 1, y: 0 },
    ];

    // TS `private` is erased at runtime, and nothing public exposes the player's tile.
    const safariPlayerPosition = () => Safari.playerXY;

    const isSafariWalkable = (x, y) => {
        const row = Safari.grid?.[y];
        return !!row && x >= 0 && x < row.length
            && GameConstants.SAFARI_LEGAL_WALK_BLOCKS.includes(row[x])
            && !!Safari.accessibleTiles?.[y]?.[x];
    };

    // Where a step can roll an encounter: grass, and water in the Alola pond.
    const isSafariEncounterTile = (x, y) => {
        const tile = Safari.grid[y][x];
        return tile === GameConstants.SafariTile.grass
            || GameConstants.SAFARI_WATER_BLOCKS.includes(tile);
    };

    // Encounters interrupt the trip, so grass and water cost more without being banned.
    // Linear scan, not a heap: a few hundred tiles, searched once per tile.
    const searchSafariMap = () => {
        const width = Safari.grid[0].length;
        const tileCount = width * Safari.grid.length;
        const start = safariPlayerPosition();
        const startIndex = start.y * width + start.x;

        const distances = new Array(tileCount).fill(Infinity);
        const previous = new Array(tileCount).fill(-1);
        const isSettled = new Array(tileCount).fill(false);
        distances[startIndex] = 0;

        for (let settled = 0; settled < tileCount; settled++) {
            let nearest = -1;
            for (let index = 0; index < tileCount; index++) {
                if (!isSettled[index] && (nearest === -1 || distances[index] < distances[nearest])) {
                    nearest = index;
                }
            }
            if (nearest === -1 || distances[nearest] === Infinity) {
                break;
            }
            isSettled[nearest] = true;

            const x = nearest % width;
            const y = Math.floor(nearest / width);
            SAFARI_DIRECTIONS.forEach((direction) => {
                const nextX = x + direction.x;
                const nextY = y + direction.y;
                if (!isSafariWalkable(nextX, nextY)) {
                    return;
                }
                const nextIndex = nextY * width + nextX;
                const cost = isSafariEncounterTile(nextX, nextY) ? SAFARI_ENCOUNTER_TILE_COST : 1;
                if (distances[nearest] + cost < distances[nextIndex]) {
                    distances[nextIndex] = distances[nearest] + cost;
                    previous[nextIndex] = nearest;
                }
            });
        }

        return { width, distances, previous, startIndex };
    };

    const firstSafariStepToward = (search, goalIndex) => {
        let cursor = goalIndex;
        while (search.previous[cursor] !== search.startIndex) {
            cursor = search.previous[cursor];
            if (cursor === -1) {
                return null;
            }
        }
        return { x: cursor % search.width, y: Math.floor(cursor / search.width) };
    };

    // Distance 0 is the player's own tile: standing still rolls nothing.
    const nearestSafariTile = (search, tiles) => {
        let best = null;
        tiles.forEach((tile) => {
            const index = tile.y * search.width + tile.x;
            const distance = search.distances[index];
            if (distance === Infinity || distance === 0) {
                return;
            }
            if (!best || distance < best.distance) {
                best = { index, distance };
            }
        });
        return best;
    };

    const safariEncounterTiles = () => {
        const tiles = [];
        for (let y = 0; y < Safari.grid.length; y++) {
            for (let x = 0; x < Safari.grid[y].length; x++) {
                if (isSafariWalkable(x, y) && isSafariEncounterTile(x, y)) {
                    tiles.push({ x, y });
                }
            }
        }
        return tiles;
    };

    // Inside a grass patch every neighbour ties on cost, so it keeps wandering it.
    const pickSafariTarget = (search) => {
        const target = nearestSafariTile(search, Safari.itemGrid())
            ?? nearestSafariTile(search, Safari.pokemonGrid())
            ?? nearestSafariTile(search, safariEncounterTiles());
        return target ? target.index : null;
    };

    const safariDirectionTo = (from, to) => SAFARI_DIRECTIONS
        .find((direction) => from.x + direction.x === to.x && from.y + direction.y === to.y);

    const nextSafariDirection = () => {
        const search = searchSafariMap();
        const targetIndex = pickSafariTarget(search);
        const playerPosition = safariPlayerPosition();
        const step = targetIndex === null ? null : firstSafariStepToward(search, targetIndex);
        if (step) {
            return safariDirectionTo(playerPosition, step).name;
        }

        // Walled in: a step still advances the spawn timer.
        return SAFARI_DIRECTIONS.find((candidate) => isSafariWalkable(
            playerPosition.x + candidate.x, playerPosition.y + candidate.y))?.name ?? null;
    };

    // A held arrow key's calls: mid-walk, move() queues a turn, so the walk never pauses.
    const holdSafariDirection = (direction) => {
        const held = Safari.queue[0] ?? null;
        if (held === direction) {
            return;
        }
        if (direction) {
            Safari.move(direction);
        }
        if (held) {
            Safari.stop(held);
        }
    };

    // playerXY updates as a step starts, so steering on entry beats the next step.
    let safariSteeredTile = null;

    const walkSafari = () => {
        const position = safariPlayerPosition();
        const tileKey = `${position.x},${position.y}`;
        if (Safari.isMoving || Safari.walking) {
            // Released and coasting to a stop, or this tile is already steered.
            if (!Safari.walking || tileKey === safariSteeredTile) {
                return;
            }
        }
        safariSteeredTile = tileKey;
        holdSafariDirection(nextSafariDirection());
    };

    // ---------------------------------------------------------------------
    // Safari battles
    // ---------------------------------------------------------------------

    // Wiki "Catch Rate Table": base catch rate, Magic Ball none / level 5, level ranges.
    // RR Razz then Rock, NR Nanab then Rock, R Razz alone.
    const SAFARI_OPENER_TABLE = [
        [3, '1-40:RR', '1-40:RR'],
        [5, '1-40:RR', '1-40:RR'],
        [6, '1-40:RR', '1-40:RR'],
        [10, '1-40:RR', '1-40:RR'],
        [15, '1-40:RR', '1-40:RR'],
        [20, '1-40:RR', '1-40:RR'],
        [25, '1-40:RR', '1-40:RR'],
        [30, '1-40:RR', '1-40:RR'],
        [35, '1-40:RR', '1-40:RR'],
        [45, '1-40:RR', '1-40:RR'],
        [50, '1-40:RR', '1-40:RR'],
        [55, '1-40:RR', '1-40:RR'],
        [60, '1-40:RR', '1-39:RR,40-40:NR'],
        [65, '1-40:RR', '1-36:RR,37-40:NR'],
        [70, '1-40:RR', '1-34:RR,35-40:NR'],
        [75, '1-40:RR', '1-31:RR,32-40:NR'],
        [80, '1-40:RR', '1-29:RR,30-40:NR'],
        [90, '1-40:RR', '1-24:RR,25-40:NR'],
        [100, '1-40:RR', '1-20:RR,21-40:NR'],
        [120, '1-39:RR,40-40:NR', '1-13:RR,14-40:NR'],
        [125, '1-36:RR,37-40:NR', '1-11:RR,12-40:NR'],
        [127, '1-35:RR,36-40:NR', '1-11:RR,12-40:NR'],
        [130, '1-34:RR,35-40:NR', '1-10:RR,11-40:NR'],
        [140, '1-29:RR,30-40:NR', '1-6:RR,7-40:NR'],
        [145, '1-27:RR,28-40:NR', '1-5:RR,6-40:NR'],
        [150, '1-24:RR,25-40:NR', '1-4:RR,5-40:NR'],
        [155, '1-22:RR,23-40:NR', '1-2:RR,3-40:NR'],
        [160, '1-20:RR,21-40:NR', '1-1:RR,2-40:NR'],
        [170, '1-16:RR,17-40:NR', '1-40:NR'],
        [180, '1-13:RR,14-40:NR', '1-39:NR,40-40:R'],
        [190, '1-10:RR,11-40:NR', '1-37:NR,38-40:R'],
        [200, '1-6:RR,7-40:NR', '1-36:NR,37-40:R'],
        [205, '1-5:RR,6-40:NR', '1-35:NR,36-40:R'],
        [220, '1-1:RR,2-40:NR', '1-33:NR,34-40:R'],
        [225, '1-40:NR', '1-33:NR,34-40:R'],
        [235, '1-40:NR', '1-31:NR,32-40:R'],
        [255, '1-37:NR,38-40:R', '1-28:NR,29-40:R'],
    ];

    const SAFARI_OPENER_STEPS = {
        RR: ['Razz', 'rock'],
        NR: ['Nanab', 'rock'],
        R: ['Razz'],
    };

    // Magic Ball gives 5-10%; the table has only 0 and 10, so the nearer column wins.
    const usesMagicBallColumn = () => {
        try {
            return App.game.oakItems.calculateBonus(OakItemType.Magic_Ball) >= 7.5;
        } catch (error) {
            return false;
        }
    };

    const safariOpenerCode = (catchRate, level, hasMagicBall) => {
        const row = SAFARI_OPENER_TABLE.reduce((best, candidate) =>
            (Math.abs(candidate[0] - catchRate) < Math.abs(best[0] - catchRate) ? candidate : best));
        const ranges = row[hasMagicBall ? 2 : 1].split(',');
        const match = ranges.find((range) => {
            const [low, high] = range.split(':')[0].split('-').map(Number);
            return level >= low && level <= high;
        }) ?? ranges[ranges.length - 1];
        return match.split(':')[1];
    };

    // No berry, no opener: a Rock alone doubles the escape chance for nothing.
    const safariOpenerFor = (enemy) => {
        if (enemy.catchFactor >= 100) {
            return [];
        }
        const code = safariOpenerCode(enemy.baseCatchFactor * 6, Safari.safariLevel(), usesMagicBallColumn());
        const steps = SAFARI_OPENER_STEPS[code] ?? [];
        const hasBerries = steps.every((step) => step === 'rock' || Number(BaitList[step].amount()) > 0);
        return hasBerries ? [...steps] : [];
    };

    // throwBait reads the selection synchronously, so it is restored at once.
    const throwSafariBerry = (berryName) => {
        const previousBait = SafariBattle.selectedBait();
        SafariBattle.selectedBait(BaitList[berryName]);
        SafariBattle.throwBait();
        SafariBattle.selectedBait(previousBait);
    };

    let safariPlanEnemy = null;
    let safariPlanSteps = [];

    const fightSafariBattle = () => {
        // Every action is a long animation chain; busy() is the game's own gate.
        if (SafariBattle.busy()) {
            return;
        }
        const enemy = SafariBattle.enemy;
        if (enemy !== safariPlanEnemy) {
            safariPlanEnemy = enemy;
            safariPlanSteps = safariOpenerFor(enemy);
        }

        const step = safariPlanSteps.shift();
        if (step === 'rock') {
            SafariBattle.throwRock();
        } else if (step) {
            throwSafariBerry(step);
        } else {
            SafariBattle.throwBall();
        }
    };

    // ---------------------------------------------------------------------
    // Safari crawler
    // ---------------------------------------------------------------------

    // True once a run is paid for, so its end is counted exactly once.
    let isSafariRunOpen = false;
    // Left mid-run: the run keeps its balls, so re-entering carries on with it.
    let isSafariPaused = false;

    // Let go of the held direction, or the player walks on into a wall.
    const releaseSafariKeys = () => {
        safariSteeredTile = null;
        [...Safari.queue].forEach((direction) => Safari.stop(direction));
    };

    const stopSafari = (message, isFinished = false) => {
        isSafariRunning = false;
        isSafariRunOpen = false;
        isSafariPaused = false;
        if (typeof Safari !== 'undefined') {
            releaseSafariKeys();
        }
        if (message) {
            notify(message);
        }
        if (isFinished) {
            playDoneSound();
        }
        refreshPanel();
    };

    const safariProgress = () => `${safariRunsCompleted} of ${safariRunsRequested} run${safariRunsRequested === 1 ? '' : 's'}`;

    // From the entrance screen, or partway through a run entered by hand.
    const isInSafariModal = () => typeof Safari !== 'undefined'
        && App.game?.gameState === gameStates().safari;

    const startSafari = () => {
        if (!isInSafariModal()) {
            notify('Open the Safari Zone to start auto safari');
            return;
        }
        safariRunsCompleted = 0;
        // A run already under way is taken over and counts as the first.
        isSafariRunOpen = Safari.inProgress();
        isSafariPaused = false;
        isSafariRunning = true;
        notify(`Auto safari: ${safariRunsRequested} run${safariRunsRequested === 1 ? '' : 's'}`);
        refreshPanel();
        safariTick();
    };

    const toggleSafari = () => {
        if (isSafariRunning) {
            stopSafari(`Auto safari stopped after ${safariProgress()}`);
            return;
        }
        startSafari();
    };

    // gameOver clears inProgress once the last ball is spent.
    const handleSafariProgressChanged = (isInProgress) => {
        if (isInProgress || !isSafariRunning || !isSafariRunOpen) {
            return;
        }
        isSafariRunOpen = false;
        safariRunsCompleted++;
        if (safariRunsCompleted >= safariRunsRequested) {
            stopSafari(`Auto safari done — ${safariProgress()}`, true);
            return;
        }
        refreshPanel();
    };

    // Pays only once the modal is fully open: load() sizes the map off its width.
    const openNextSafariRun = () => {
        const modal = $('#safariModal').data('bs.modal');
        if (DisplayObservables.modalState.safariModal === 'hidden') {
            Safari.openModal();
            return;
        }
        if (!modal?._isShown || modal._isTransitioning) {
            return;
        }
        if (!Safari.canPay()) {
            stopSafari(`Auto safari stopped after ${safariProgress()} — not enough Quest Points`, true);
            return;
        }
        Safari.payEntranceFee();
        isSafariRunOpen = Safari.inProgress();
        refreshPanel();
    };

    const safariTick = () => {
        if (!isSafariRunning || typeof Safari === 'undefined' || !App.game) {
            return;
        }

        if (!Safari.inProgress()) {
            openNextSafariRun();
            return;
        }
        if (App.game.gameState !== gameStates().safari) {
            if (!isSafariPaused) {
                isSafariPaused = true;
                releaseSafariKeys();
                notify('Auto safari paused — enter the Safari Zone again to carry on');
                refreshPanel();
            }
            return;
        }
        if (isSafariPaused) {
            isSafariPaused = false;
            notify(`Auto safari resumed — ${Safari.balls()} balls left`);
        }

        if (Safari.inBattle()) {
            // SafariBattle.load releases every arrow, so the walk restarts clean.
            safariSteeredTile = null;
            if (typeof SafariBattle !== 'undefined') {
                fightSafariBattle();
            }
            return;
        }

        if (!safariPlayerPosition()) {
            stopSafari('Auto safari stopped — cannot read the player position');
            return;
        }
        walkSafari();
    };

    const subscribeSafariProgress = () => {
        if (typeof Safari !== 'undefined') {
            Safari.inProgress.subscribe(guardedTick('safari run ended', handleSafariProgressChanged));
        }
    };

    // ---------------------------------------------------------------------
    // Safari controls
    // ---------------------------------------------------------------------

    let safariControlElements = null;

    // In the modal header: its static backdrop blocks the Helper card while open.
    const insertSafariButton = () => {
        if (safariControlElements) {
            return true;
        }
        const leaveButton = document.querySelector('#safariModal .modalClose');
        const header = leaveButton?.parentNode;
        if (!header) {
            return false;
        }

        const group = buildElement('div', 'd-flex align-items-center mr-2');
        group.id = 'helperSafariControls';
        group.style.gap = '0.375rem';

        const runsInput = buildNumberInput(safariRunsRequested, 1);
        runsInput.id = 'helperSafariRuns';
        runsInput.title = 'Runs';
        runsInput.addEventListener('change', () => {
            const parsed = parseInt(runsInput.value, 10);
            safariRunsRequested = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAFARI_RUNS;
            runsInput.value = String(safariRunsRequested);
            refreshPanel();
        });
        group.appendChild(runsInput);

        const button = buildElement('button', 'btn text-nowrap');
        button.type = 'button';
        button.id = 'helperSafariToggle';
        button.title = `Hotkey: ${SAFARI_TOGGLE_KEY.toUpperCase()}`;
        button.addEventListener('click', toggleSafari);
        group.appendChild(button);

        header.insertBefore(group, leaveButton);
        safariControlElements = { group, runsInput, button };

        // The panel refresh ran before this existed; without it, blank for 500ms.
        refreshSafariButton();
        return true;
    };

    function refreshSafariButton() {
        if (!safariControlElements) {
            return;
        }
        const { runsInput, button } = safariControlElements;

        runsInput.style.display = isSafariRunning ? 'none' : '';
        if (isSafariRunning) {
            setButtonVariant(button, 'danger', `Stop auto safari (run ${Math.min(safariRunsCompleted + 1, safariRunsRequested)} of ${safariRunsRequested})`);
        } else {
            setButtonVariant(button, 'success', `Auto safari ${safariRunsRequested} run${safariRunsRequested === 1 ? '' : 's'}`);
        }
    }

    /* ===================== mining         ===================== */
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

    /* ===================== farm           ===================== */
    // ---------------------------------------------------------------------
    // Layouts
    // ---------------------------------------------------------------------

    const FARM_PLOT_COUNT = 25;
    // The one cell the player fills in; '' keeps the plot empty.
    const FARM_TARGET = 'T';

    // The wiki's setups (wiki.pokeclicker.com/#!Farm/Setups), read left to right
    // and top to bottom. `harvest` lists the cells the keeper picks and replants;
    // everything else is held ripe, because its aura is the point of the setup.
    const FARM_PRESETS = {
        harvest: {
            label: 'Harvest — Passho + Petaya',
            description: 'Ten plots of the target under a Passho harvest aura. For berries that drop one or more per harvest.',
            needsTarget: true,
            harvest: [FARM_TARGET],
            grid: [
                'Petaya', 'Passho', 'Passho', 'Passho', 'Passho',
                'T', 'T', 'T', 'T', 'T',
                'Passho', 'Passho', 'Passho', 'Passho', 'Passho',
                'T', 'T', 'T', 'T', 'T',
                'Passho', 'Passho', 'Passho', 'Passho', 'Passho',
            ],
        },
        growth: {
            label: 'Growth — Wacan + 4 Lum',
            description: 'One target in the centre under the strongest growth aura in the game. For a single slow berry.',
            needsTarget: true,
            harvest: [FARM_TARGET],
            grid: [
                '', '', 'Lum', '', '',
                '', 'Wacan', 'Wacan', 'Wacan', '',
                'Lum', 'Wacan', 'T', 'Wacan', 'Lum',
                '', 'Wacan', 'Wacan', 'Wacan', '',
                '', '', 'Lum', '', '',
            ],
        },
        handoffGrowth: {
            label: 'Handoff — Wacan phase',
            description: 'Four targets grown under Wacan. Switch to the Passho phase before they ripen.',
            needsTarget: true,
            harvest: [],
            grid: [
                'Wacan', 'Wacan', 'Wacan', 'Wacan', 'Wacan',
                'Wacan', 'T', 'Wacan', 'T', 'Wacan',
                'Wacan', 'Wacan', 'Wacan', 'Wacan', 'Wacan',
                'Wacan', 'T', 'Wacan', 'T', 'Wacan',
                'Wacan', 'Wacan', 'Wacan', 'Wacan', 'Wacan',
            ],
        },
        handoffHarvest: {
            label: 'Handoff — Passho phase',
            description: 'The same four targets under a harvest aura instead. For berries that drop half a berry per harvest.',
            needsTarget: true,
            harvest: [FARM_TARGET],
            grid: [
                'Passho', 'Passho', 'Passho', 'Passho', 'Passho',
                'Passho', 'T', 'Passho', 'T', 'Passho',
                'Passho', 'Passho', 'Passho', 'Passho', 'Passho',
                'Passho', 'T', 'Passho', 'T', 'Passho',
                'Passho', 'Passho', 'Passho', 'Passho', 'Passho',
            ],
        },
        aura: {
            label: 'Aura — target + 4 Lum + Petaya',
            description: 'Twenty of the target held ripe, Lum to amplify them and Petaya to keep them alive. For Starf, Rowap or Jaboca.',
            needsTarget: true,
            harvest: [],
            grid: [
                'T', 'T', 'T', 'T', 'T',
                'T', 'Lum', 'T', 'Lum', 'T',
                'T', 'T', 'T', 'T', 'T',
                'T', 'Lum', 'T', 'Lum', 'T',
                'T', 'T', 'T', 'T', 'Petaya',
            ],
        },
        eggSteps: {
            label: 'Egg steps — Chople + Babiri + Petaya',
            description: 'Seventeen Chople for egg steps. Babiri blocks the Chilan mutation; the free plot takes the target.',
            needsTarget: true,
            harvest: [],
            grid: [
                'Chople', 'Lum', 'Chople', 'Lum', 'Chople',
                'Petaya', 'T', 'Chople', 'Chople', 'Chople',
                'Chople', 'Chople', 'Chople', 'Babiri', 'Chople',
                'Lum', 'Chople', 'Babiri', 'Lum', 'Chople',
                'Chople', 'Chople', 'Chople', 'Chople', 'Chople',
            ],
        },
        colburNonsense: {
            label: 'Farm Points — Colbur Nonsense',
            description: 'Colbur overtakes the Cheri, and Cheri regrows in half a minute. The fastest Farm Points in the game.',
            needsTarget: false,
            harvest: ['Cheri'],
            grid: [
                'Babiri', 'Petaya', 'Cheri', 'Cheri', 'Cheri',
                'Payapa', 'Payapa', 'Cheri', 'Colbur', 'Cheri',
                'Cheri', 'Cheri', 'Cheri', 'Cheri', 'Cheri',
                'Cheri', 'Colbur', 'Cheri', 'Colbur', 'Cheri',
                'Cheri', 'Cheri', 'Cheri', 'Cheri', 'Cheri',
            ],
        },
        fill: {
            label: 'Fill — one berry, every plot',
            description: 'Twenty-five of the target, harvested and replanted. No aura, but nothing is spent on one either.',
            needsTarget: true,
            harvest: [FARM_TARGET],
            grid: new Array(FARM_PLOT_COUNT).fill(FARM_TARGET),
        },
    };

    const berryName = (berryType) => BerryType[berryType] ?? '?';
    const berryData = (berryType) => BerryList[berryType];
    const farmPlot = (index) => App.game.farming.plotList[index];
    const isBerryUnlocked = (berryType) => !!App.game.farming.unlockedBerries[berryType]?.();

    // A preset cell is either a berry the keeper plants or a plot it keeps clear.
    const buildPresetLayout = (preset, targetBerry) => preset.grid.map((token) => {
        if (!token) {
            return null;
        }
        const berry = token === FARM_TARGET ? targetBerry : BerryType[token];
        if (berry === undefined || berry === null) {
            return null;
        }
        return { berry, harvest: preset.harvest.includes(token) };
    });

    // ---------------------------------------------------------------------
    // Mutation layouts
    // ---------------------------------------------------------------------

    // Read off the instance rather than its class name, which a bundler can
    // rename. A strict requirement is laid out the same way as a minimum one,
    // since an exact neighbourhood also satisfies "at least this many".
    const farmMutationPlan = (mutation) => {
        // Every Evolve mutation assigns originalBerry, undefined included.
        const isEvolve = 'originalBerry' in mutation;
        if (isEvolve && mutation.originalBerry === undefined) {
            return null;
        }
        const plan = { isEvolve, centreBerry: mutation.originalBerry };
        if (Array.isArray(mutation.berryReqs)) {
            return Object.assign(plan, { kind: 'list', reqs: mutation.berryReqs });
        }
        if (mutation.berryReqs && typeof mutation.berryReqs === 'object') {
            return Object.assign(plan, { kind: 'counts', reqs: mutation.berryReqs });
        }
        if (Array.isArray(mutation.fieldBerries)) {
            return Object.assign(plan, { kind: 'field', reqs: mutation.fieldBerries });
        }
        // Flavour, parasite and Oak-item mutations: no layout can be derived.
        return null;
    };

    // The game's own adjacency, so a layout cannot disagree with what it checks.
    const farmNeighbours = (index) => Plot.findNearPlots(index);

    // undefined is still free, null must stay empty, a number is a berry.
    const reserveMutationCentre = (grid, index, plan) => {
        const wanted = plan.isEvolve ? plan.centreBerry : null;
        if (grid[index] !== undefined && grid[index] !== wanted) {
            return false;
        }
        grid[index] = wanted;
        return true;
    };

    // Each requirement has to appear once; whatever is already there counts.
    const fillListNeighbourhood = (grid, neighbours, reqs) => {
        const present = new Set(neighbours.map((index) => grid[index]).filter((cell) => typeof cell === 'number'));
        const missing = reqs.filter((req) => !present.has(req));
        const free = neighbours.filter((index) => grid[index] === undefined);
        if (free.length < missing.length) {
            return false;
        }
        missing.forEach((req, offset) => { grid[free[offset]] = req; });
        return true;
    };

    // Exact counts, so every plot left over has to stay bare for good.
    const fillCountNeighbourhood = (grid, neighbours, reqs) => {
        const remaining = new Map(Object.keys(reqs).map((berry) => [Number(berry), reqs[berry]]));
        for (const index of neighbours) {
            if (typeof grid[index] !== 'number') {
                continue;
            }
            const left = remaining.get(grid[index]);
            if (!left) {
                return false;
            }
            remaining.set(grid[index], left - 1);
        }
        const free = neighbours.filter((index) => grid[index] === undefined);
        const wanted = [];
        remaining.forEach((count, berry) => { for (let n = 0; n < count; n++) wanted.push(berry); });
        if (free.length < wanted.length) {
            return false;
        }
        free.forEach((index, offset) => { grid[index] = offset < wanted.length ? wanted[offset] : null; });
        return true;
    };

    // Every plot that can be made into a mutation site is, so each tick of the
    // game's mutation roll gets as many chances as the farm can hold.
    const buildNeighbourhoodLayout = (plan) => {
        let grid = new Array(FARM_PLOT_COUNT).fill(undefined);
        for (let centre = 0; centre < FARM_PLOT_COUNT; centre++) {
            const attempt = grid.slice();
            const neighbours = farmNeighbours(centre);
            const filled = reserveMutationCentre(attempt, centre, plan)
                && (plan.kind === 'counts'
                    ? fillCountNeighbourhood(attempt, neighbours, plan.reqs)
                    : fillListNeighbourhood(attempt, neighbours, plan.reqs));
            if (filled) {
                grid = attempt;
            }
        }
        return grid;
    };

    // A field mutation counts berries anywhere in the farm and lands in an empty
    // plot, so the only layout is "the whole order, and room left over".
    const buildFieldLayout = (plan) => {
        const grid = new Array(FARM_PLOT_COUNT).fill(undefined);
        let index = 0;
        for (const field of plan.reqs) {
            for (let n = 0; n < field.amountRequired; n++) {
                if (index >= FARM_PLOT_COUNT - 1) {
                    return null;
                }
                grid[index++] = field.berry;
            }
        }
        return grid;
    };

    // Nothing is harvested: every requirement has to be ripe at the same time.
    const buildMutationLayout = (mutation) => {
        const plan = farmMutationPlan(mutation);
        if (!plan) {
            return null;
        }
        const grid = plan.kind === 'field' ? buildFieldLayout(plan) : buildNeighbourhoodLayout(plan);
        if (!grid) {
            return null;
        }
        return grid.map((cell) => (typeof cell === 'number' ? { berry: cell, harvest: false } : null));
    };

    const farmMutationFor = (berryType) => App.game.farming.mutations
        .find((mutation) => mutation.mutatedBerry === berryType && mutation.unlocked && farmMutationPlan(mutation));

    // Locked berries the game would currently let us mutate into.
    const mutatableBerries = () => App.game.farming.mutations
        .filter((mutation) => !isBerryUnlocked(mutation.mutatedBerry) && mutation.unlocked && farmMutationPlan(mutation))
        .map((mutation) => mutation.mutatedBerry)
        .filter((berry, index, all) => all.indexOf(berry) === index)
        .sort((left, right) => left - right);

    // ---------------------------------------------------------------------
    // Goals
    // ---------------------------------------------------------------------

    // Seconds to ripe, as the plot would actually grow it. The aura part is an
    // estimate: the neighbours it reads are the ones growing there now.
    const ripeSeconds = (berryType, plot) => {
        const multiplier = App.game.farming.getGrowthMultiplier() * (plot?.getGrowthMultiplier() ?? 1);
        return berryData(berryType).growthTime[3] / (multiplier || 1);
    };

    // Farm Points per second, which is what the wiki's table ranks berries by.
    // Berries that yield less than one per harvest cannot replant themselves.
    const bestFarmPointBerry = () => {
        let best = null;
        App.game.farming.unlockedBerries.forEach((isUnlocked, berryType) => {
            const data = berryData(berryType);
            if (!isUnlocked() || !data || data.harvestAmount < 1) {
                return;
            }
            const rate = data.farmValue / data.growthTime[3];
            if (!best || rate > best.rate) {
                best = { berryType, rate };
            }
        });
        return best?.berryType ?? null;
    };

    // Every berry the Battle Cafe charges for a spin, times the spins wanted.
    // getPrice is private in the game's TypeScript, which erases at runtime.
    const alcremieShortfalls = () => {
        if (typeof BattleCafeController === 'undefined') {
            return [];
        }
        const sweets = Object.keys(BattleCafeController.evolutions).map(Number);
        const needed = new Map();
        sweets.forEach((sweet) => {
            (BattleCafeController.getPrice(sweet) ?? []).forEach((cost) => {
                needed.set(cost.berry, (needed.get(cost.berry) ?? 0) + cost.amount * alcremieSpinsWanted);
            });
        });

        const shortfalls = [];
        needed.forEach((amount, berryType) => {
            const short = amount - App.game.farming.berryInventory[berryType]();
            if (short > 0) {
                shortfalls.push({ berryType, short });
            }
        });
        return shortfalls;
    };

    // The berry that takes longest to grow the rest of, not the one you are
    // shortest of: a thousand Passho are quicker than a hundred Haban.
    const alcremieTargetBerry = () => {
        let worst = null;
        alcremieShortfalls().forEach(({ berryType, short }) => {
            const data = berryData(berryType);
            const harvests = short / Math.max(data.harvestAmount, 0.5);
            const seconds = harvests * data.growthTime[3];
            if (!worst || seconds > worst.seconds) {
                worst = { berryType, seconds };
            }
        });
        return worst?.berryType ?? null;
    };

    // ---------------------------------------------------------------------
    // The keeper
    // ---------------------------------------------------------------------

    let farmLayout = null;
    let farmLayoutKey = '';
    let farmLayoutStartedAt = 0;
    let farmStatusText = 'Idle';

    // Which berry each mode is currently working on, so the tab can say so.
    const farmModeTarget = () => {
        if (farmMode === FarmMode.farmPoints) {
            return bestFarmPointBerry();
        }
        if (farmMode === FarmMode.alcremie) {
            return alcremieTargetBerry();
        }
        if (farmMode === FarmMode.mutation) {
            return farmMutationBerry;
        }
        return farmTargetBerry;
    };

    const farmModePreset = () => {
        if (farmMode === FarmMode.farmPoints) {
            return FARM_PRESETS.fill;
        }
        if (farmMode === FarmMode.alcremie) {
            // Half-berry harvests need the aura more than they need the plots.
            const target = alcremieTargetBerry();
            return target !== null && berryData(target).harvestAmount < 1
                ? FARM_PRESETS.handoffHarvest
                : FARM_PRESETS.harvest;
        }
        return FARM_PRESETS[farmPreset] ?? FARM_PRESETS[DEFAULT_FARM_PRESET];
    };

    const buildFarmLayout = () => {
        if (farmMode === FarmMode.mutation) {
            const mutation = farmMutationBerry === null ? null : farmMutationFor(farmMutationBerry);
            return mutation ? buildMutationLayout(mutation) : null;
        }
        const preset = farmModePreset();
        const target = farmModeTarget();
        if (preset.needsTarget && target === null) {
            return null;
        }
        return buildPresetLayout(preset, target);
    };

    // Rebuilt only when the choice behind it changes, so the planting schedule
    // below is not restarted every tick.
    const farmLayoutSignature = () => [farmMode, farmPreset, farmModeTarget(), farmMutationBerry].join('|');

    const ensureFarmLayout = () => {
        const signature = farmLayoutSignature();
        if (signature !== farmLayoutKey) {
            farmLayoutKey = signature;
            farmLayout = buildFarmLayout();
            farmLayoutStartedAt = Date.now();
        }
        return farmLayout;
    };

    const berriesMissingFor = (layout) => {
        const missing = new Set();
        layout.forEach((cell, index) => {
            const plot = farmPlot(index);
            if (cell && plot?.isUnlocked && plot.isEmpty() && !App.game.farming.hasBerry(cell.berry)) {
                missing.add(cell.berry);
            }
        });
        return [...missing];
    };

    // Planting everything at once ripens it at staggered times, and a setup only
    // works while all of it is ripe. Each berry waits out the difference between
    // its own growing time and the slowest one in the layout, which is what the
    // wiki's timing tables do by hand.
    // A berry there is none of sets no pace: waiting on one that cannot be
    // planted would hold up the whole layout for as long as it takes to grow.
    const plantingDelays = (layout) => {
        const seconds = layout.map((cell, index) => {
            const plot = farmPlot(index);
            const isComing = cell && (!plot.isEmpty() || App.game.farming.hasBerry(cell.berry));
            return isComing ? ripeSeconds(cell.berry, plot) : 0;
        });
        const slowest = seconds.reduce((left, right) => Math.max(left, right), 0);
        return { slowest, delays: seconds.map((value) => slowest - value) };
    };

    const applyFarmLayout = (layout, isManual) => {
        const farming = App.game.farming;
        const elapsed = (Date.now() - farmLayoutStartedAt) / 1000;
        const { slowest, delays } = plantingDelays(layout);

        layout.forEach((cell, index) => {
            const plot = farming.plotList[index];
            // Safe-locked plots are the player saying "not this one".
            if (!plot?.isUnlocked || plot.isSafeLocked) {
                return;
            }
            const isRipe = !plot.isEmpty() && plot.stage() === PlotStage.Berry;

            if (!cell) {
                // Only clear a plot the layout wants bare when asked to by hand.
                if (isManual && isRipe) {
                    farming.harvest(index);
                }
                return;
            }
            if (!plot.isEmpty()) {
                // Held: the aura it emits is the whole point of the plot.
                if (plot.berry === cell.berry && !cell.harvest) {
                    return;
                }
                if (isRipe) {
                    farming.harvest(index);
                } else if (isManual && plot.berry !== cell.berry) {
                    farming.shovel(index);
                }
                return;
            }
            if (!farming.hasBerry(cell.berry)) {
                return;
            }
            // Past the slowest berry's own growing time the schedule is over, so
            // a replacement goes straight in.
            if (elapsed < slowest && elapsed < delays[index]) {
                return;
            }
            farming.plant(index, cell.berry);
        });
    };

    const stopFarm = (message, isFinished = false) => {
        isFarmRunning = false;
        farmStatusText = message;
        notify(message);
        if (isFinished) {
            playDoneSound();
        }
        refreshPanel();
    };

    // True when the run is over; the layout itself follows the target, so a mode
    // that still has work to do simply rebuilds around the next berry.
    const isFarmGoalReached = () => {
        if (farmMode === FarmMode.mutation) {
            return farmMutationBerry !== null && isBerryUnlocked(farmMutationBerry);
        }
        if (farmMode === FarmMode.alcremie) {
            return alcremieTargetBerry() === null;
        }
        return false;
    };

    const farmTick = () => {
        if (!isFarmRunning || !App.game?.farming?.canAccess()) {
            return;
        }
        if (isFarmGoalReached()) {
            stopFarm(farmMode === FarmMode.mutation
                ? `${berryName(farmMutationBerry)} unlocked`
                : 'Alcremie berries stocked', true);
            return;
        }

        const layout = ensureFarmLayout();
        if (!layout) {
            stopFarm('Nothing to plant — pick a berry');
            return;
        }

        applyFarmLayout(layout, false);

        const missing = berriesMissingFor(layout);
        farmStatusText = missing.length
            ? `Waiting for ${missing.map(berryName).join(', ')}`
            : `Keeping ${farmModeStatus()}`;
    };

    const farmModeStatus = () => {
        const target = farmModeTarget();
        if (farmMode === FarmMode.mutation) {
            return `a ${berryName(target)} mutation`;
        }
        if (farmMode === FarmMode.alcremie) {
            const short = alcremieShortfalls().find((entry) => entry.berryType === target);
            return `${berryName(target)} — ${Math.ceil(short?.short ?? 0).toLocaleString('en-US')} to go`;
        }
        if (farmMode === FarmMode.farmPoints) {
            return `${berryName(target)} for Farm Points`;
        }
        return farmModePreset().label;
    };

    // ---------------------------------------------------------------------
    // Farm tab
    // ---------------------------------------------------------------------

    let farmControlElements = null;

    const toggleFarm = () => {
        if (isFarmRunning) {
            stopFarm('Auto farm stopped');
            return;
        }
        // A fresh start replants on its own schedule rather than the last one's.
        farmLayoutKey = '';
        const layout = ensureFarmLayout();
        if (!layout) {
            notify('Pick a berry for the farm first');
            return;
        }
        isFarmRunning = true;
        farmStatusText = `Keeping ${farmModeStatus()}`;
        notify(`Auto farm started — ${farmModeStatus()}`);
        refreshPanel();
    };

    // Shovels the berries the layout does not want, which the tick never does.
    const plantFarmLayoutNow = () => {
        farmLayoutKey = '';
        const layout = ensureFarmLayout();
        if (!layout) {
            notify('Pick a berry for the farm first');
            return;
        }
        applyFarmLayout(layout, true);
        refreshPanel();
    };

    const berryOptions = (berries) => berries.map((berryType) => ({ value: berryType, label: berryName(berryType) }));

    const unlockedBerryOptions = () => berryOptions(App.game.farming.unlockedBerries
        .map((isUnlocked, berryType) => (isUnlocked() ? berryType : null))
        .filter((berryType) => berryType !== null));

    const buildFarmTabBody = () => {
        const body = buildElement('div', 'p-2');

        const modeRow = buildRow();
        modeRow.appendChild(buildElement('span', null, 'Goal'));
        const modeSelect = buildSelect('helperFarmMode');
        fillSelect(modeSelect, Object.keys(FarmMode).map((mode) => ({ value: mode, label: FARM_MODE_LABELS[mode] })), farmMode);
        modeSelect.addEventListener('change', () => {
            farmMode = modeSelect.value;
            refreshPanel();
        });
        modeRow.appendChild(modeSelect);
        body.appendChild(modeRow);

        const presetRow = buildRow();
        presetRow.appendChild(buildElement('span', null, 'Setup'));
        const presetSelect = buildSelect('helperFarmPreset');
        fillSelect(presetSelect, Object.keys(FARM_PRESETS)
            .map((name) => ({ value: name, label: FARM_PRESETS[name].label })), farmPreset);
        presetSelect.addEventListener('change', () => {
            farmPreset = presetSelect.value;
            refreshPanel();
        });
        presetRow.appendChild(presetSelect);
        body.appendChild(presetRow);

        const targetRow = buildRow();
        targetRow.appendChild(buildElement('span', null, 'Berry'));
        const targetSelect = buildSelect('helperFarmTarget');
        targetSelect.addEventListener('change', () => {
            const berryType = Number(targetSelect.value);
            if (farmMode === FarmMode.mutation) {
                farmMutationBerry = berryType;
            } else {
                farmTargetBerry = berryType;
            }
            refreshPanel();
        });
        targetRow.appendChild(targetSelect);
        body.appendChild(targetRow);

        const spinsRow = buildRow();
        spinsRow.appendChild(buildElement('span', null, 'Spins per sweet'));
        const spinsInput = buildNumberInput(alcremieSpinsWanted, 1);
        spinsInput.id = 'helperFarmSpins';
        spinsInput.addEventListener('change', () => {
            const parsed = parseInt(spinsInput.value, 10);
            alcremieSpinsWanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_ALCREMIE_SPINS;
            spinsInput.value = String(alcremieSpinsWanted);
            refreshPanel();
        });
        spinsRow.appendChild(spinsInput);
        body.appendChild(spinsRow);

        const buttonRow = buildRow();
        const toggleButton = buildElement('button', 'btn');
        toggleButton.type = 'button';
        toggleButton.id = 'helperFarmToggle';
        toggleButton.addEventListener('click', toggleFarm);
        buttonRow.appendChild(toggleButton);

        const plantButton = buildElement('button', 'btn btn-primary', 'Plant now');
        plantButton.type = 'button';
        plantButton.id = 'helperFarmPlant';
        plantButton.title = 'Applies the layout at once, shovelling berries it does not want';
        plantButton.addEventListener('click', plantFarmLayoutNow);
        buttonRow.appendChild(plantButton);
        body.appendChild(buttonRow);

        const status = buildElement('div', 'small');
        status.id = 'helperFarmStatus';
        body.appendChild(status);

        farmControlElements = { modeSelect, presetRow, presetSelect, targetRow, targetSelect, spinsRow, spinsInput, toggleButton, status };
        return body;
    };

    // The farm modal's own tab strip, with the Farm Points button pinned last.
    const insertFarmTab = () => {
        if (document.getElementById('helperFarmView')) {
            return true;
        }
        const tabList = document.querySelector('#farmModal .nav-tabs');
        const tabContent = document.querySelector('#farmModal .tab-content');
        if (!tabList || !tabContent) {
            return false;
        }

        const item = buildElement('li', 'nav-item');
        const link = buildElement('a', 'nav-link', 'Helper');
        link.setAttribute('data-toggle', 'tab');
        link.setAttribute('href', '#helperFarmView');
        item.appendChild(link);
        tabList.insertBefore(item, tabList.children[tabList.children.length - 1]);

        const pane = buildElement('div', 'tab-pane fade');
        pane.id = 'helperFarmView';
        pane.appendChild(buildFarmTabBody());
        tabContent.appendChild(pane);

        // The panel refresh ran before this existed; without it, blank for 500ms.
        refreshFarmTab();
        return true;
    };

    function refreshFarmTab() {
        if (!farmControlElements || !App.game?.farming) {
            return;
        }
        const { presetRow, presetSelect, targetRow, targetSelect, spinsRow, spinsInput, toggleButton, status } = farmControlElements;

        // Only the Layout goal picks its own setup; the others choose for you.
        presetRow.style.display = farmMode === FarmMode.layout ? '' : 'none';
        presetSelect.value = farmPreset;
        spinsRow.style.display = farmMode === FarmMode.alcremie ? '' : 'none';
        spinsInput.value = String(alcremieSpinsWanted);

        const isMutation = farmMode === FarmMode.mutation;
        const needsBerry = isMutation || (farmMode === FarmMode.layout && farmModePreset().needsTarget);
        targetRow.style.display = needsBerry ? '' : 'none';
        if (needsBerry) {
            const options = isMutation ? berryOptions(mutatableBerries()) : unlockedBerryOptions();
            const selected = isMutation ? farmMutationBerry : farmTargetBerry;
            // A saved berry the save cannot offer any more falls back to the first.
            const fallback = options.some((option) => option.value === selected) ? selected : options[0]?.value ?? null;
            if (isMutation) {
                farmMutationBerry = fallback;
            } else {
                farmTargetBerry = fallback;
            }
            fillSelect(targetSelect, options.length ? options : [{ value: '', label: 'Nothing available' }], fallback ?? '');
        }

        setButtonState(toggleButton, isFarmRunning, isFarmRunning ? 'Stop' : 'Start');
        status.textContent = isFarmRunning ? farmStatusText : (buildFarmLayout() ? farmModeStatus() : 'Nothing to plant');
    }

    /* ===================== hatchery       ===================== */
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
            refreshPanel();
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

    /* ===================== quests         ===================== */
    // ---------------------------------------------------------------------
    // Quests
    // ---------------------------------------------------------------------

    let isQuestPatchInstalled = false;

    // Direct begin(): Quests.beginQuest would close the modal under hideQuestsOnFull.
    const startAllQuests = () => {
        const quests = App.game?.quests;
        if (!quests?.isDailyQuestsUnlocked()) {
            return;
        }
        quests.questList().forEach((quest) => {
            if (!quest.inProgress() && !quest.isCompleted()) {
                quest.begin();
            }
        });
    };

    // Through Quests.claimQuest for its Medichamite roll and the all-claimed refresh.
    const claimQuests = (completedQuests) => {
        const quests = App.game.quests;
        completedQuests.forEach((quest) => {
            // Claiming the last quest swaps in a new list mid-loop.
            const index = quests.questList().indexOf(quest);
            if (index !== -1 && quest.isCompleted() && !quest.claimed()) {
                quests.claimQuest(index);
            }
        });
    };

    // App.game only exists once a save is picked, so this retries from the panel tick.
    const installQuestPatch = () => {
        const quests = App.game?.quests;
        if (isQuestPatchInstalled || !quests) {
            return;
        }
        isQuestPatchInstalled = true;
        // Replaces the level-based cap of GameConstants.MAX_QUEST_SLOTS; bindings reread the property.
        quests.questSlots = ko.pureComputed(() => Math.max(1, quests.questList().length));
        // Only a new set, not a loaded save, so a quest the player quits stays quit.
        const originalGenerateQuestList = quests.generateQuestList.bind(quests);
        quests.generateQuestList = (...generateArguments) => {
            const result = originalGenerateQuestList(...generateArguments);
            guardedTick('quest start', startAllQuests)();
            return result;
        };
        const completedQuests = ko.pureComputed(() => quests.questList()
            .filter((quest) => quest.isCompleted() && !quest.claimed()));
        const guardedClaimQuests = guardedTick('quest claim', claimQuests);
        completedQuests.subscribe(guardedClaimQuests);
        guardedClaimQuests(completedQuests());
    };

    /* ===================== bulk-selling   ===================== */
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
    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    const handleKeyDown = (event) => {
        if (event.ctrlKey || event.altKey || event.metaKey) {
            return;
        }
        const pressedKey = event.key.toLowerCase();
        // The runs box takes numbers only, so V there still means start.
        const isInSafariRunsBox = event.target.id === 'helperSafariRuns' && pressedKey === SAFARI_TOGGLE_KEY;
        if (event.target.matches('input, textarea, [contenteditable]') && !isInSafariRunsBox) {
            return;
        }
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
        } else if (pressedKey === MINING_TOGGLE_KEY) {
            isMiningRunning = !isMiningRunning;
            notify(`Auto mining ${isMiningRunning ? 'ON' : 'OFF'}`);
            refreshPanel();
        } else if (pressedKey === FILL_HATCHERY_KEY) {
            fillHatcheryToCapacity();
        } else if (pressedKey === SAFARI_TOGGLE_KEY) {
            // Only on the safari screen, entrance included.
            if (App.game?.gameState !== gameStates().safari) {
                return;
            }
            if (isInSafariRunsBox) {
                // Blurring fires `change`, so a count still being typed is used.
                event.preventDefault();
                event.target.blur();
            }
            toggleSafari();
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
            && insertHatcheryButton() && insertUndergroundSellButtons()
            && insertSafariButton() && insertFarmTab();
        if (!isEverythingInserted) {
            setTimeout(boot, 500);
            return;
        }

        patchBattleLost();
        patchSortModules();
        patchDungeonLeave();
        subscribeSafariProgress();
        DungeonRunner.dungeonFinished.subscribe(guardedTick('dungeon finished', handleDungeonFinished));

        const tickSource = startTicks([
            { label: 'auto clicker', interval: CLICK_INTERVAL_MS, run: clickerTick },
            { label: 'dungeon crawler', interval: CRAWLER_INTERVAL_MS, run: crawlerTick },
            { label: 'panel refresh', interval: PANEL_REFRESH_INTERVAL_MS, run: refreshPanel },
            { label: 'hatchery auto-fill', interval: HATCHERY_AUTO_FILL_INTERVAL_MS, run: hatcheryAutoFillTick },
            { label: 'auto safari', interval: SAFARI_INTERVAL_MS, run: safariTick },
            { label: 'auto mining', interval: MINING_INTERVAL_MS, run: miningTick },
            { label: 'auto farm', interval: FARM_INTERVAL_MS, run: farmTick },
            { label: 'quest patch', interval: PANEL_REFRESH_INTERVAL_MS, run: installQuestPatch },
        ]);
        document.addEventListener('keydown', guardedTick('hotkey', handleKeyDown));

        console.log(`[helper] ready (${tickSource} timers)`
            + `\n  ${CRAWLER_TOGGLE_KEY.toUpperCase()} — start/stop dungeon crawler`
            + `\n  ${CLICKER_TOGGLE_KEY.toUpperCase()} — toggle auto clicker`
            + `\n  ${MINING_TOGGLE_KEY.toUpperCase()} — toggle auto mining`
            + `\n  ${FILL_HATCHERY_KEY.toUpperCase()} — fill the hatchery and queue`
            + `\n  ${SAFARI_TOGGLE_KEY.toUpperCase()} — start/stop auto safari`);
    };

    boot();
})();
