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
