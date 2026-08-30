// Runs the real userscript against a minimal DOM shim and reports the UI it
// actually builds: the helper panel, and the hatchery button in the breeding
// modal. Catches blank/unlabelled controls, which a syntax check cannot.

const fs = require('fs');
const vm = require('vm');

const SCRIPT_PATH = process.argv[2];

// --- minimal DOM ---------------------------------------------------------
class ShimElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this._classes = [];
        this.style = {};
        this._text = '';
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = {};
        this.disabled = false;
        this.checked = false;
    }
    get className() { return this._classes.join(' '); }
    set className(value) { this._classes = String(value).split(/\s+/).filter(Boolean); }
    get classList() {
        const self = this;
        return {
            add: (...names) => names.forEach((name) => { if (!self._classes.includes(name)) self._classes.push(name); }),
            remove: (...names) => { self._classes = self._classes.filter((name) => !names.includes(name)); },
            contains: (name) => self._classes.includes(name),
        };
    }
    get textContent() {
        if (this.children.length) return this.children.map((child) => child.textContent).join('');
        return this._text;
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    // Both of these move an already-placed node, like the real DOM does. Without
    // the detach, re-inserting a node leaves a duplicate behind.
    detach(child) {
        if (child.parentNode) {
            child.parentNode.children = child.parentNode.children.filter((existing) => existing !== child);
        }
    }
    appendChild(child) { this.detach(child); child.parentNode = this; this.children.push(child); return child; }
    insertBefore(child, reference) {
        // The DOM spec special-cases inserting a node before itself: the
        // reference becomes its nextSibling, leaving the node where it is.
        if (child === reference) return child;
        this.detach(child);
        child.parentNode = this;
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index === -1) this.children.push(child); else this.children.splice(index, 0, child);
        return child;
    }
    get nextSibling() {
        if (!this.parentNode) return null;
        return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
    }
    get firstChild() { return this.children[0] ?? null; }
    remove() { this.detach(this); this.parentNode = null; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
    matches() { return false; }
}

const allElements = [];
const makeElement = (tagName) => { const element = new ShimElement(tagName); allElements.push(element); return element; };

const document = {
    createElement: makeElement,
    getElementById: (id) => allElements.find((element) => element.id === id) ?? null,
    querySelector: (selector) => {
        const byClass = {
            '#breedingModal .hatchery-warnings': 'hatchery-warnings',
            '#dungeonGuidesModal .nav-tabs': 'nav-tabs',
            '#dungeonGuidesModal .tab-content': 'tab-content',
        }[selector];
        if (byClass) return allElements.find((element) => element.classList.contains(byClass)) ?? null;
        if (selector === '#treasures button[data-bind*="quickSellEnabled"]') {
            return allElements.find((element) => element.tagName === 'BUTTON'
                && (element.getAttribute('data-bind') || '').includes('quickSellEnabled')) ?? null;
        }
        return null;
    },
    addEventListener: () => {},
    documentElement: makeElement('html'),
};

// --- game shim -----------------------------------------------------------
const makeObservable = (initial) => {
    let value = initial;
    const subscribers = [];
    const observable = (...args) => {
        if (!args.length) return value;
        value = args[0];
        subscribers.forEach((subscriber) => subscriber(value));
        return value;
    };
    observable.subscribe = (subscriber) => { subscribers.push(subscriber); return { dispose() {} }; };
    return observable;
};

const GameConstants = {
    DungeonTileType: { empty: 0, entrance: 1, enemy: 2, chest: 3, boss: 4, ladder: 5 },
    GameState: { loading: -1, idle: 0, paused: 1, fighting: 2, gym: 3, dungeon: 4, safari: 5, town: 6, shop: 7, battleFrontier: 8, temporaryBattle: 9 },
    DungeonInteractionSource: { Click: 0, Keybind: 1, HeldKeybind: 2, DungeonGuide: 3 },
};

const breeding = {
    eggList: [],
    eggSlots: 4,
    hatcheryHelpers: { hired: () => [] },
    usableQueueSlots: () => 40,
    queueList: () => [],
    addPokemonToHatchery: () => true,
};

// Optional third argument seeds the saved column order, so the restore path can
// be exercised: node panel-render.test.js <script> "a|helperPanel|b"
const savedModuleOrder = {
    'modules.middle-top-sort-column': process.argv[3] || '',
    'modules.middle-bottom-sort-column': process.argv[5] || '',
};

// Faithful copy of the reorder loop in Sortable.ts, which is what strands the
// panel at the end of the column when it runs after insertion.
const gameSortModules = () => {
    const column = document.getElementById('middle-top-sort-column');
    const order = String(savedModuleOrder['modules.middle-top-sort-column'] || '').split('|').filter(Boolean);
    let previousId;
    order.forEach((id) => {
        const child = document.getElementById(id);
        if (!child) return;
        if (!previousId) {
            column.insertBefore(child, column.firstChild);
        } else {
            const previousChild = document.getElementById(previousId);
            previousChild.parentNode.insertBefore(child, previousChild.nextSibling);
        }
        previousId = id;
    });
};
// underground stock: two diamond items (one locked), one gem item, one unsellable
const undergroundStock = {
    'Old Amber': () => 12,
    'Helix Fossil': () => 5,
    'Blue Shard': () => 40,
    'Rare Bone': () => 7,
};
const undergroundSales = [];
const notifications = [];
const DIAMOND_BONUS = 1.5;   // Wallet.addAmount applies a multiplier to diamonds
const wallet = { currencies: [] };
const gems = { gemWallet: [] };
const undergroundItems = [
    { itemName: 'Old Amber', valueType: 0, value: 5, sellLocked: () => false },
    { itemName: 'Helix Fossil', valueType: 0, value: 3, sellLocked: () => true },
    { itemName: 'Blue Shard', valueType: 1, value: 1, sellLocked: () => false },
    { itemName: 'Rare Bone', valueType: 3, value: 1, sellLocked: () => false },
];

const timers = [];
const refreshHandlers = [];
const autoFillHandlers = [];
const context = {
    document,
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
    setInterval: (fn, ms) => { timers.push(ms); if (ms === 500) refreshHandlers.push(fn); if (ms === 2000) autoFillHandlers.push(fn); return timers.length; },
    setTimeout: (fn, ms) => { timers.push('timeout:' + ms); return timers.length; },
    GameConstants: Object.assign({ Currency: { money: 0, questPoint: 1, dungeonToken: 2, diamond: 3 } }, GameConstants),
    DungeonRunner: {
        dungeonFinished: makeObservable(false),
        defeatedBoss: makeObservable(null),
        fighting: makeObservable(false),
        dungeonLeave: () => {},
        canStartDungeon: () => true,
        initializeDungeon: () => {},
        handleInteraction: () => {},
        map: null,
    },
    DungeonBattle: { catching: makeObservable(false), clickAttack: () => {} },
    Battle: { clickAttack: () => {} },
    GymBattle: { clickAttack: () => {} },
    TemporaryBattleBattle: { clickAttack: () => {} },
    BattleFrontierRunner: { battleLost: () => {}, start: () => {}, started: makeObservable(false) },
    PartyController: { compareBy: () => () => 0 },
    Notifier: { notify: (options) => { notifications.push(options.message); console.log('  [notify] ' + options.message); } },
    NotificationConstants: { NotificationOption: { info: 0 } },
    Settings: { getSetting: (name) => ({ observableValue: () => savedModuleOrder[name] ?? '' }) },
    App: {
        game: {
            gameState: GameConstants.GameState.town,
            breeding,
            party: { caughtPokemon: [] },
            wallet,
            gems,
            challenges: { list: { regionalAttackDebuff: { active: () => false } } },
        },
    },
    Point: function Point(x, y, floor) { this.x = x; this.y = y; this.floor = floor; },
    player: {
        town: { dungeon: { name: 'Viridian Forest' } },
        itemList: undergroundStock,
    },
    UndergroundItemValueType: { Diamond: 0, Gem: 1, Shard: 2, Fossil: 3 },
    UndergroundItems: { getUnlockedItems: () => undergroundItems },
    UndergroundController: {
        // mirrors gainProfit: diamonds get the wallet bonus, gems are flat
        sellMineItem: (item, amount) => {
            if (item.sellLocked()) { undergroundSales.push('REFUSED ' + item.itemName); return; }
            undergroundSales.push(item.itemName + ' x' + amount);
            undergroundStock[item.itemName] = () => 0;
            if (item.valueType === 0) {
                const base = Math.floor(item.value * amount);
                const banked = Math.floor(base * DIAMOND_BONUS);
                wallet.currencies[3](wallet.currencies[3]() + banked);
            } else if (item.valueType === 1) {
                gems.gemWallet[0](gems.gemWallet[0]() + Math.floor(100 * amount));
            }
        },
    },
    SortModules: gameSortModules,
    window: {},
};

// breeding modal warning row the hatchery button attaches to
const warningsRow = makeElement('div');
warningsRow.className = 'float-left';
const eggSlotWarning = makeElement('button');
eggSlotWarning.className = 'btn btn-warning hatchery-warnings';
eggSlotWarning.textContent = "You don't have any free egg slots.";
warningsRow.appendChild(eggSlotWarning);

// dungeon guides modal: existing tab strip and pane container
const guidesTabList = makeElement('ul');
guidesTabList.className = 'nav nav-tabs nav-fill';
['Hire', 'Help'].forEach((name) => {
    const item = makeElement('li');
    item.className = 'nav-item';
    const link = makeElement('a');
    link.className = 'nav-link';
    link.textContent = name;
    item.appendChild(link);
    guidesTabList.appendChild(item);
});
const guidesTabContent = makeElement('div');
guidesTabContent.className = 'tab-content p-0';
['dungeonGuidesModalHireTab', 'dungeonGuidesModalHelpTab'].forEach((id) => {
    const pane = makeElement('div');
    pane.id = id;
    pane.className = 'tab-pane fade';
    guidesTabContent.appendChild(pane);
});

// underground treasures tab: the Quick-Sell Mode button and its form-group
const quickSellGroup = makeElement('div');
quickSellGroup.className = 'form-group col-12';
const quickSellButton = makeElement('button');
quickSellButton.className = 'btn btn-primary btn-block';
quickSellButton.setAttribute('data-bind', 'click: () => UndergroundTrading.quickSellEnabled(!UndergroundTrading.quickSellEnabled())');
quickSellButton.textContent = 'Enable Quick-Sell Mode';
quickSellGroup.appendChild(quickSellButton);
const treasuresTab = makeElement('div');
treasuresTab.id = 'treasures';
treasuresTab.appendChild(quickSellGroup);

// middle-top column the panel attaches to, in the game's own order
const topColumn = makeElement('div');
topColumn.id = 'middle-top-sort-column';
// the game misspells this id ("achivement"); keep it wrong so the shim matches
const achievementTracker = makeElement('div');
achievementTracker.id = 'achivementTrackerContainer';
achievementTracker.className = 'card sortable border-secondary mb-3';
const currencyContainer = makeElement('div');
currencyContainer.id = 'currencyContainer';
currencyContainer.className = 'card sortable border-secondary mb-3';
topColumn.appendChild(achievementTracker);
topColumn.appendChild(currencyContainer);

// middle-bottom column, present so a stale town-map anchor would be noticed
const bottomColumn = makeElement('div');
bottomColumn.id = 'middle-bottom-sort-column';
const townMap = makeElement('div');
townMap.id = 'townMap';
townMap.className = 'card sortable border-secondary mb-3';
bottomColumn.appendChild(townMap);

for (let index = 0; index < 7; index++) wallet.currencies.push(makeObservable(0));
for (let index = 0; index < 18; index++) gems.gemWallet.push(makeObservable(0));

vm.createContext(context);
vm.runInContext(fs.readFileSync(SCRIPT_PATH, 'utf8'), context);

const CHEST_RARITY_COUNT = 5;
let failures = 0;
const fail = (message) => { console.log('FAIL: ' + message); failures++; };

// --- panel ---------------------------------------------------------------
const panel = document.getElementById('helperPanel');
if (!panel) {
    fail('no #helperPanel inserted');
} else {
    const topOrder = topColumn.children.map((child) => child.id);
    console.log('top column    : ' + topOrder.join(' -> '));
    console.log('bottom column : ' + bottomColumn.children.map((child) => child.id).join(' -> '));

    // 4th argument states the expected steady-state order outright; deriving it
    // from the saved order cannot express where unsaved cards end up.
    const expectedOrder = process.argv[4] || 'achivementTrackerContainer,currencyContainer,helperPanel';

    // Before SortModules only the helper cards can have moved - the game's own
    // cards are still in markup order - so the full order is only required once
    // that pass has run. With no saved order, the default must hold immediately.
    if (!savedModuleOrder['modules.middle-top-sort-column'] && topOrder.join(',') !== expectedOrder) {
        fail('default column order should be ' + expectedOrder + ' but got ' + topOrder.join(','));
    }

    // Save.load calls SortModules well after document-idle. Run it and require
    // the panel to survive where it belongs.
    if (typeof context.window.SortModules !== 'function') {
        fail('SortModules was not wrapped');
    } else {
        if (!savedModuleOrder['modules.middle-top-sort-column']) {
            savedModuleOrder['modules.middle-top-sort-column'] = 'achivementTrackerContainer|currencyContainer';
        }
        context.window.SortModules();
        const afterSort = topColumn.children.map((child) => child.id);
        console.log('after SortModules : ' + afterSort.join(' -> '));
        if (afterSort.join(',') !== expectedOrder) {
            fail('SortModules stranded the panel: expected ' + expectedOrder + ' but got ' + afterSort.join(','));
        }
    }
    if (bottomColumn.children.some((child) => child.id === 'helperPanel')) {
        fail('panel is still anchored to the town map');
    }
    console.log('');
    console.log('--- panel contents ---');
    const walk = (element, depth) => {
        const pad = '  '.repeat(depth);
        if (element.tagName === 'BUTTON') {
            console.log(pad + 'BUTTON "' + element.textContent + '"  [' + element.className + ']' + (element.disabled ? ' DISABLED' : ''));
        } else if (element.tagName === 'INPUT') {
            console.log(pad + 'INPUT type=' + element.type + ' value=' + element.value + (element.disabled ? ' DISABLED' : ''));
        } else if (element.id) {
            console.log(pad + '<' + element.tagName + ' #' + element.id + ' .' + element.className + '>');
        }
        element.children.forEach((child) => walk(child, depth + 1));
    };
    walk(panel, 0);

    const panelButtons = [];
    const collect = (element) => { if (element.tagName === 'BUTTON') panelButtons.push(element); element.children.forEach(collect); };
    collect(panel);
    const blank = panelButtons.filter((button) => !button.textContent.trim());
    if (blank.length) fail(blank.length + ' blank-labelled button(s) in the panel');
    if (panelButtons.some((button) => /crawler|Stop \(/i.test(button.textContent))) fail('crawler button still in the panel');
    if (panelButtons.some((button) => /Queue \d+ Pokemon/.test(button.textContent))) fail('hatchery button still in the panel');

    if (!panel.classList.contains('sortable')) fail('panel is not draggable (missing .sortable)');

    console.log('');
    console.log('--- panel switches ---');
    const switches = [];
    const collectSwitches = (element) => {
        if (element.classList.contains('custom-switch')) switches.push(element);
        element.children.forEach(collectSwitches);
    };
    collectSwitches(panel);
    if (switches.length !== 2) fail('expected 2 switches in the panel, found ' + switches.length);

    // both toggles must share one flex row rather than stacking
    if (switches.length === 2) {
        if (switches[0].parentNode !== switches[1].parentNode) {
            fail('toggles are not in the same row');
        } else {
            const row = switches[0].parentNode;
            console.log('  row classes: ' + row.className + '  gap=' + row.style.gap);
            if (!row.classList.contains('d-flex')) fail('toggle row is not a flex row');
            if (!row.classList.contains('flex-wrap')) fail('toggle row cannot wrap on a narrow host');
            switches.forEach((toggle) => {
                if (!toggle.classList.contains('text-nowrap')) fail('toggle label can break mid-word');
            });
        }
    }
    switches.forEach((row) => {
        const input = row.children[0];
        const label = row.children[1];
        console.log('  [' + (input.checked ? 'x' : ' ') + '] ' + label.textContent + '  (id=' + input.id + ')');
        if (input.type !== 'checkbox') fail('switch input is not a checkbox');
        if (!input.id) fail('switch input has no id');
        if (label.getAttribute('for') !== input.id) fail('switch label "for" does not match its input id');
        if (!row.classList.contains('custom-control')) fail('switch row missing custom-control');
    });

    // a hotkey flips the flag; the refresh must mirror it back onto the switch
    const clickerInput = document.getElementById('helperClickerSwitch');
    const clickerChange = (clickerInput.listeners.change || [])[0];
    clickerInput.checked = true;
    clickerChange();
    refreshHandlers.forEach((handler) => handler());
    console.log('  after toggling auto clicker on -> checked=' + clickerInput.checked);
    if (!clickerInput.checked) fail('auto clicker switch did not stay on');
    clickerInput.checked = false;
    clickerChange();
}

// --- crawler panel --------------------------------------------------------
console.log('');
console.log('--- dungeon guides modal tabs (must be untouched) ---');
console.log('  ' + guidesTabList.children.map((item) => item.textContent).join(' | '));
if (guidesTabList.children.length !== 2) fail('a tab was added to the guides modal');
if (document.getElementById('helperCrawlerTab')) fail('crawler pane still in the guides modal');

const crawlerPanel = document.getElementById('helperCrawlerPanel');
if (!crawlerPanel) {
    fail('crawler panel not created');
} else {
    // between the battle view and the town map means: bottom column, above the map
    const bottomOrder = bottomColumn.children.map((child) => child.id);
    console.log('  bottom column: ' + bottomOrder.join(' -> '));
    if (crawlerPanel.parentNode !== bottomColumn) fail('crawler panel is not in the middle-bottom column');
    if (!process.argv[5] && bottomOrder.join(',') !== 'helperCrawlerPanel,townMap') {
        fail('crawler panel should sit above the town map, got ' + bottomOrder.join(','));
    }
    if (!crawlerPanel.classList.contains('sortable')) fail('crawler panel is not draggable (missing .sortable)');

    console.log('');
    console.log('--- crawler panel contents ---');
    const walkPanel = (element, depth) => {
        const pad = '  '.repeat(depth);
        if (element.tagName === 'BUTTON') console.log(pad + 'BUTTON "' + element.textContent + '"');
        else if (element.tagName === 'INPUT') console.log(pad + 'INPUT type=' + element.type + ' value=' + element.value);
        else if (element.id) console.log(pad + '<' + element.tagName + ' #' + element.id + '>');
        element.children.forEach((child) => walkPanel(child, depth + 1));
    };
    walkPanel(crawlerPanel, 1);

    const paneButtons = [];
    const collectPane = (element) => { if (element.tagName === 'BUTTON') paneButtons.push(element); element.children.forEach(collectPane); };
    collectPane(crawlerPanel);
    if (paneButtons.some((button) => !button.textContent.trim())) fail('blank button in the crawler panel');
    if (!paneButtons.some((button) => /crawler|Stop \(/i.test(button.textContent))) fail('no start/stop button');
    const modeLabels = ['Boss rush', 'All chests', 'All enemies'];
    modeLabels.forEach((label) => {
        if (!paneButtons.some((button) => button.textContent === label)) fail('missing mode button: ' + label);
    });
    const modeButtonsFound = paneButtons.filter((button) => modeLabels.includes(button.textContent));
    if (new Set(modeButtonsFound.map((button) => button.parentNode)).size !== 1) fail('mode buttons are not in one group');

    // only the chest mode shows the priority table
    // located independently: headerCells is declared further down
    const chestBlockOf = () => {
        let block = null;
        const walk = (element) => { if (element.tagName === 'TABLE') block = element.parentNode; element.children.forEach(walk); };
        walk(crawlerPanel);
        return block;
    };
    const clickMode = (label) => (paneButtons.find((button) => button.textContent === label).listeners.click || [])
        .forEach((handler) => handler());
    console.log('  mode -> chest table');
    modeLabels.forEach((label) => {
        clickMode(label);
        const shown = chestBlockOf().style.display !== 'none';
        console.log('    ' + label.padEnd(12) + (shown ? 'shown' : 'hidden'));
        if ((label === 'All chests') !== shown) fail(label + ': chest table visibility is wrong');
    });
    clickMode('All chests');

    // rarity headers across the top of the chest table
    const headerCells = [];
    const collectHeaders = (element) => { if (element.tagName === 'TH') headerCells.push(element); element.children.forEach(collectHeaders); };
    collectHeaders(crawlerPanel);
    console.log('  table headers: ' + headerCells.map((cell) => cell.textContent).join(' | '));
    if (headerCells.map((cell) => cell.textContent).join(',') !== 'common,rare,epic,legendary,mythic') {
        fail('chest table headers are not the rarities: ' + headerCells.map((cell) => cell.textContent).join(','));
    }

    // attempts label, and the start button sharing its row
    const runsInput = document.getElementById('helperCrawlerPanel');
    const attemptsLabel = [];
    const collectSpans = (element) => { if (element.tagName === 'SPAN') attemptsLabel.push(element.textContent); element.children.forEach(collectSpans); };
    collectSpans(crawlerPanel);
    if (!attemptsLabel.includes('Attempts')) fail('attempts label reads: ' + JSON.stringify(attemptsLabel));
    if (attemptsLabel.includes('Dungeons')) fail('attempts label still says Dungeons');

    const startButton = paneButtons.find((button) => /crawler|Stop \(/i.test(button.textContent));
    const numberInputs = [];
    const collectNumbers = (element) => { if (element.tagName === 'INPUT' && element.type === 'number') numberInputs.push(element); element.children.forEach(collectNumbers); };
    collectNumbers(crawlerPanel);
    const attemptsInput = numberInputs[numberInputs.length - 1];
    if (startButton.parentNode !== attemptsInput.parentNode) fail('start button is not beside the attempts input');
    if (startButton.classList.contains('btn-block')) fail('btn-block would force the start button onto its own line');
    void runsInput;

    // table styling: no borders, everything centred
    const tableElements = [];
    const collectTables = (element) => { if (element.tagName === 'TABLE') tableElements.push(element); element.children.forEach(collectTables); };
    collectTables(crawlerPanel);
    const table = tableElements[0];
    if (!table) {
        fail('no chest table');
    } else {
        console.log('  table classes: ' + table.className);
        if (table.classList.contains('table-bordered')) fail('table still bordered');
        if (!table.classList.contains('table-borderless')) fail('table is not borderless');
        if (!table.classList.contains('text-center')) fail('table cells are not centred');
    }
    numberInputs.slice(0, CHEST_RARITY_COUNT).forEach((input) => {
        // form-control is display:block with a set width, so text-center alone
        // leaves it hugging the left edge of its cell
        if (!input.classList.contains('mx-auto')) fail('priority input is not centred in its cell');
    });

    // start button green when it can start, grey only when it cannot
    console.log('  start button: "' + startButton.textContent + '" [' + startButton.className + ']');
    if (!startButton.classList.contains('btn-success')) {
        fail('start button is not green: ' + startButton.className);
    }

    // boss rush hides the chest table outright
    const chestTable = headerCells[0] && headerCells[0].parentNode.parentNode.parentNode.parentNode;
    const modeButton = (label) => paneButtons.find((button) => button.textContent === label);
    (modeButton('Boss rush').listeners.click || []).forEach((handler) => handler());
    console.log('  boss rush  -> chest block ' + (chestTable.style.display === 'none' ? 'hidden' : 'VISIBLE'));
    if (chestTable.style.display !== 'none') fail('chest table still shown in boss rush');
    (modeButton('All chests').listeners.click || []).forEach((handler) => handler());
    console.log('  all chests -> chest block ' + (chestTable.style.display === 'none' ? 'HIDDEN' : 'visible'));
    if (chestTable.style.display === 'none') fail('chest table hidden in all-chests mode');

    // visibility follows location, but never hides a running crawler
    console.log('');
    console.log('--- crawler panel visibility ---');
    const visible = () => crawlerPanel.style.display !== 'none';
    const show = (label, gameState, hasDungeon) => {
        context.App.game.gameState = gameState;
        context.player.town = hasDungeon ? { dungeon: {} } : {};
        refreshHandlers.forEach((handler) => handler());
        console.log('  ' + label.padEnd(34) + (visible() ? 'visible' : 'hidden'));
        return visible();
    };
    const states = GameConstants.GameState;
    if (!show('town with a dungeon', states.town, true)) fail('hidden at a dungeon town');
    if (!show('inside a dungeon', states.dungeon, true)) fail('hidden inside a dungeon');
    if (show('town without a dungeon', states.town, false)) fail('shown in a plain town');
    if (show('on a route', states.fighting, true)) fail('shown on a route');

    // start a run, then walk away: it must stay reachable
    const startStop = document.getElementById('helperCrawlerPanel');
    context.App.game.gameState = states.dungeon;
    context.player.town = { dungeon: {} };
    refreshHandlers.forEach((handler) => handler());
    const crawlerButton = paneButtons.find((button) => /crawler|Stop \(/i.test(button.textContent));
    (crawlerButton.listeners.click || []).forEach((handler) => handler());
    if (!show('running, wandered onto a route', states.fighting, false)) {
        fail('panel hid while attempts were running - no way to stop');
    }
    (crawlerButton.listeners.click || []).forEach((handler) => handler());
    if (show('stopped, still on a route', states.fighting, false)) fail('stayed visible after stopping');
    void startStop;
}

// --- hatchery button ------------------------------------------------------
console.log('');
console.log('--- breeding modal warning row ---');
warningsRow.children.forEach((child) => {
    console.log('  ' + child.tagName + '#' + (child.id || '-') + ' "' + child.textContent + '" [' + child.className + ']' + (child.disabled ? ' DISABLED' : ''));
});

const hatcheryButton = document.getElementById('helperQueueHatchery');
if (!hatcheryButton) {
    fail('hatchery button not inserted into the breeding modal');
} else {
    console.log('');
    console.log('--- capacity -> button state ---');
    const cases = [
        ['4 free eggs, 40 queue', 4, 40, 0, 44, true],
        ['eggs full, queue open', 0, 40, 0, 40, true],
        ['eggs full, queue half', 0, 40, 20, 20, true],
        ['everything full', 0, 40, 40, 0, false],
        ['queue disabled, eggs free', 4, 0, 0, 4, true],
        ['queue disabled, eggs full', 0, 0, 0, 0, false],
    ];
    cases.forEach((testCase) => {
        const label = testCase[0];
        const freeEggs = testCase[1];
        const queueSlots = testCase[2];
        const queued = testCase[3];
        const expectedCapacity = testCase[4];
        const expectEnabled = testCase[5];

        const eggs = [];
        for (let slot = 0; slot < 4; slot++) {
            const isFilled = slot >= freeEggs;
            eggs.push(() => ({ isNone: () => !isFilled }));
        }
        breeding.eggList = eggs;
        breeding.eggSlots = 4;
        breeding.usableQueueSlots = () => queueSlots;
        breeding.queueList = () => new Array(queued);
        refreshHandlers.forEach((handler) => handler());

        const visible = hatcheryButton.style.display !== 'none';
        const text = hatcheryButton.textContent;
        console.log('  ' + label.padEnd(26) + ' -> "' + text + '"' + (visible ? '  visible' : '  HIDDEN'));
        if (visible !== expectEnabled) fail(label + ': expected ' + (expectEnabled ? 'visible' : 'hidden'));
        if (hatcheryButton.disabled) fail(label + ': should hide, not disable');
        if (expectEnabled && !text.includes(String(expectedCapacity))) fail(label + ': expected capacity ' + expectedCapacity + ' in label');
    });

    // --- auto-fill toggle -------------------------------------------------
    const autoFillButton = document.getElementById('helperAutoFillHatchery');
    if (!autoFillButton) {
        fail('auto-fill toggle not inserted');
    } else {
        console.log('');
        console.log('--- auto-fill toggle ---');
        // full hatchery: the queue button hides, the toggle must not
        breeding.usableQueueSlots = () => 0;
        breeding.queueList = () => [];
        breeding.eggList = [0, 1, 2, 3].map(() => () => ({ isNone: () => false }));
        refreshHandlers.forEach((handler) => handler());
        console.log('  hatchery full -> queue "' + (hatcheryButton.style.display === 'none' ? '(hidden)' : hatcheryButton.textContent)
            + '", toggle "' + autoFillButton.textContent + '"');
        if (autoFillButton.tagName !== 'BUTTON') fail('auto-fill control should be a button, not a switch');
        if (autoFillButton.style.display === 'none') fail('auto-fill toggle hid along with the queue button');
        if (!autoFillButton.textContent.includes('OFF')) fail('auto-fill toggle should start OFF');

        const autoFillClick = (autoFillButton.listeners.click || [])[0];
        autoFillClick();
        console.log('  after click   -> toggle "' + autoFillButton.textContent + '"');
        if (!autoFillButton.textContent.includes('ON')) fail('auto-fill toggle did not switch on');

        // with the toggle on and room to fill, the tick must actually queue
        const queued = [];
        breeding.addPokemonToHatchery = (pokemon) => { queued.push(pokemon); return true; };
        context.App.game.party.caughtPokemon = [
            { name: 'A', isHatchableFiltered: () => true },
            { name: 'B', isHatchableFiltered: () => true },
            { name: 'C', isHatchableFiltered: () => true },
        ];
        breeding.usableQueueSlots = () => 2;
        breeding.queueList = () => [];
        breeding.eggList = [0, 1, 2, 3].map((slot) => () => ({ isNone: () => slot >= 1 }));
        autoFillHandlers.forEach((handler) => handler());
        console.log('  auto-fill tick queued ' + queued.length + ' (capacity was 5, 3 candidates)');
        if (queued.length !== 3) fail('auto-fill tick queued ' + queued.length + ', expected 3');

        // switched off, the tick must do nothing
        autoFillClick();
        if (!autoFillButton.textContent.includes('OFF')) fail('auto-fill toggle did not switch back off');
        queued.length = 0;
        context.App.game.party.caughtPokemon = [{ name: 'D', isHatchableFiltered: () => true }];
        autoFillHandlers.forEach((handler) => handler());
        console.log('  toggle off -> queued ' + queued.length);
        if (queued.length !== 0) fail('auto-fill queued while switched off');
    }
}

console.log('');
console.log('timers registered : ' + timers.filter((entry) => typeof entry === 'number').join(', '));
console.log(failures ? failures + ' FAILURE(S)' : 'all checks passed');
if (failures) process.exitCode = 1;

// --- underground sell buttons ---------------------------------------------
console.log('');
console.log('--- treasures tab ---');
treasuresTab.children.forEach((group) => {
    group.children.forEach((child) => {
        console.log('  ' + child.tagName + '#' + (child.id || '-') + ' "' + child.textContent + '" [' + child.className + ']');
    });
});

const diamondButton = document.getElementById('helperSellAllDiamond');
const gemButton = document.getElementById('helperSellAllGem');
if (!diamondButton || !gemButton) {
    fail('underground sell buttons not inserted');
} else {
    if (diamondButton.parentNode !== quickSellGroup) fail('diamond button is not in the quick-sell form-group');
    if (gemButton.parentNode !== quickSellGroup) fail('gem button is not in the quick-sell form-group');
    if (treasuresTab.children.length !== 1) fail('a second form-group was added to the treasures tab');

    // directly below the anchor, in order
    const groupOrder = quickSellGroup.children.map((child) => child.id || 'quickSell');
    console.log('  group order: ' + groupOrder.join(' -> '));
    if (groupOrder.join(',') !== 'quickSell,helperSellAllDiamond,helperSellAllGem') {
        fail('unexpected order inside the form-group: ' + groupOrder.join(','));
    }

    // same styling as the anchor
    [diamondButton, gemButton].forEach((button) => {
        if (button.className !== quickSellButton.className) {
            fail('button styling differs from Quick-Sell: "' + button.className + '" vs "' + quickSellButton.className + '"');
        }
    });

    console.log('');
    console.log('--- selling ---');
    (diamondButton.listeners.click || []).forEach((handler) => handler());
    console.log('  diamonds -> ' + JSON.stringify(undergroundSales) + '  wallet=' + wallet.currencies[3]());
    const diamondMessage = notifications[notifications.length - 1];
    const diamondWallet = wallet.currencies[3]();
    // 12 items at value 5 = 60 base; the 1.5x wallet bonus makes it 90, so a
    // predicted value*amount would read 60 and disagree with the wallet
    if (diamondWallet !== 90) fail('fixture wallet should hold 90 diamonds, has ' + diamondWallet);
    if (!diamondMessage.includes('90 Diamonds')) fail('reported gain does not match the wallet delta: ' + diamondMessage);
    if (diamondMessage.includes('60 Diamonds')) fail('gain was predicted from item.value, not measured');
    if (undergroundSales.length !== 1 || undergroundSales[0] !== 'Old Amber x12') {
        fail('diamond sell should have sold only the unlocked diamond item, got ' + JSON.stringify(undergroundSales));
    }

    undergroundSales.length = 0;
    (gemButton.listeners.click || []).forEach((handler) => handler());
    console.log('  gems     -> ' + JSON.stringify(undergroundSales) + '  gems=' + gems.gemWallet[0]());
    const gemMessage = notifications[notifications.length - 1];
    if (gems.gemWallet[0]() !== 4000) fail('fixture should hold 4000 gems');
    // gems report the count sold only, never a currency figure
    if (!gemMessage.includes('for Gems')) fail('gem message should end at the currency name: ' + gemMessage);
    if (/[\d,]+ Gems/.test(gemMessage)) fail('gem message still reports a gem value: ' + gemMessage);
    if (!gemMessage.includes('Sold 40 items')) fail('gem message should still report the count: ' + gemMessage);
    if (undergroundSales.length !== 1 || undergroundSales[0] !== 'Blue Shard x40') {
        fail('gem sell should have sold only the gem item, got ' + JSON.stringify(undergroundSales));
    }

    // nothing left: must not call sellMineItem at all
    undergroundSales.length = 0;
    (diamondButton.listeners.click || []).forEach((handler) => handler());
    console.log('  again    -> ' + JSON.stringify(undergroundSales));
    if (undergroundSales.length !== 0) fail('sold something that was already gone');
}

console.log(failures ? failures + ' FAILURE(S) (underground)' : 'underground checks passed');
if (failures) process.exitCode = 1;
