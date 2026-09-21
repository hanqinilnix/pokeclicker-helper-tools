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
    matches(selector) { return selector.includes('input') && this.tagName === 'INPUT'; }
    // Leaving a field fires its change listeners, as a browser does.
    blur() { (this.listeners.change || []).forEach((handler) => handler()); }
}

const allElements = [];
const keydownHandlers = [];
const makeElement = (tagName) => { const element = new ShimElement(tagName); allElements.push(element); return element; };

const document = {
    createElement: makeElement,
    getElementById: (id) => allElements.find((element) => element.id === id) ?? null,
    querySelector: (selector) => {
        const byClass = {
            '#breedingModal .hatchery-warnings': 'hatchery-warnings',
            '#dungeonGuidesModal .nav-tabs': 'nav-tabs',
            '#dungeonGuidesModal .tab-content': 'tab-content',
            '#safariModal .modalClose': 'modalClose',
        }[selector];
        if (byClass) return allElements.find((element) => element.classList.contains(byClass)) ?? null;
        if (selector === '#treasures button[data-bind*="quickSellEnabled"]') {
            return allElements.find((element) => element.tagName === 'BUTTON'
                && (element.getAttribute('data-bind') || '').includes('quickSellEnabled')) ?? null;
        }
        return null;
    },
    addEventListener: (type, handler) => { if (type === 'keydown') keydownHandlers.push(handler); },
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
    SafariTile: { ground: 0, waterC: 5, grass: 10, treeTopC: 30 },
    SAFARI_LEGAL_WALK_BLOCKS: [0, 5, 10],
    SAFARI_WATER_BLOCKS: [5],
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

// safari fixture: 5x5, a grass band across the middle, grass bottom-left
const safariGrid = [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 10, 10, 10, 0],
    [0, 0, 0, 0, 0],
    [10, 0, 0, 0, 0],
];
const safariActions = [];
// move/stop follow Safari.move, setNextDirection and stop closely enough to
// show whether a held direction and its turns come out right.
const Safari = {
    grid: safariGrid,
    accessibleTiles: safariGrid.map((row) => row.map(() => true)),
    pokemonGrid: makeObservable([]),
    itemGrid: makeObservable([]),
    playerXY: { x: 2, y: 4 },
    isMoving: false,
    walking: false,
    queue: [],
    inProgress: makeObservable(true),
    inBattle: makeObservable(false),
    balls: makeObservable(30),
    safariLevel: makeObservable(20),
    move(direction) {
        if (!this.walking && !this.isMoving) {
            this.queue = [direction];
            this.walking = true;
        } else if (this.queue[0] !== direction) {
            if (this.queue.length === 1) this.queue.unshift(direction); else this.queue[0] = direction;
            this.walking = true;
        }
    },
    stop(direction) {
        this.queue = this.queue.filter((queued) => queued !== direction);
        if (!this.queue.length) this.walking = false;
    },
    canPay: () => safariCanPay,
    payEntranceFee() { safariFeesPaid++; this.inProgress(true); },
    openModal: () => { safariModalOpens++; },
};
let safariFeesPaid = 0;
let safariModalOpens = 0;
let safariCanPay = true;
let doneSoundsPlayed = 0;
// modalState tracks show/hide/hidden; _isTransitioning is Bootstrap's own flag.
let safariModalState = 'show';
let safariModalTransitioning = false;
const DisplayObservables = { modalState: { get safariModal() { return safariModalState; } } };
// Bootstrap tooltips land here, keyed by element, so tests can read them.
const tooltips = new Map();
const jQueryShim = (target) => ({
    on: () => {},
    tooltip: (config) => { tooltips.set(target, config); },
    data: () => ({ _isShown: safariModalState === 'show', _isTransitioning: safariModalTransitioning }),
});
const berryStock = { Razz: 5, Nanab: 5 };
const BaitList = {
    Bait: { name: 'Bait', amount: () => 'inf' },
    Razz: { name: 'Razz', amount: () => berryStock.Razz },
    Nanab: { name: 'Nanab', amount: () => berryStock.Nanab },
};
const SafariBattle = {
    busy: makeObservable(false),
    enemy: null,
    selectedBait: makeObservable(BaitList.Bait),
    throwBall: () => safariActions.push('ball'),
    throwRock: () => safariActions.push('rock'),
    throwBait: () => safariActions.push('bait:' + SafariBattle.selectedBait().name),
};
let magicBallBonus = 0;

// Saved preferences from an earlier session, two of them invalid on purpose.
const PREFERENCES_KEY = 'pokeclicker-helper.preferences';
const storage = new Map([[PREFERENCES_KEY, JSON.stringify({
    isFrontierRestartRunning: true,
    dungeonRunsRequested: 3,
    chestSettings: { mythic: { isEnabled: false, priority: 2 }, epic: { isEnabled: true, priority: -4 } },
    crawlerMode: 'nonsense',
    safariRunsRequested: -2,
})]]);

const timers = [];
const refreshHandlers = [];
const safariHandlers = [];
const autoFillHandlers = [];
const context = {
    document,
    console,
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    setInterval: (fn, ms) => { timers.push(ms); if (ms === 500) refreshHandlers.push(fn); if (ms === 2000) autoFillHandlers.push(fn); if (ms === 60) safariHandlers.push(fn); return timers.length; },
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
    NotificationConstants: {
        NotificationOption: { info: 0 },
        NotificationSound: { General: { dungeon_guide_complete: { play: () => { doneSoundsPlayed++; } } } },
    },
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
    Safari,
    SafariBattle,
    BaitList,
    OakItemType: { Magic_Ball: 0 },
    DisplayObservables,
    $: jQueryShim,
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

// safari modal header: the game's Leave button is the helper button's anchor
const safariHeader = makeElement('div');
safariHeader.className = 'modal-header';
const safariLeaveButton = makeElement('button');
safariLeaveButton.className = 'btn btn-danger modalClose';
safariLeaveButton.textContent = 'Leave';
safariHeader.appendChild(safariLeaveButton);

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
const rightClick = (element) => {
    let prevented = false;
    (element.listeners.contextmenu || []).forEach((handler) => handler({ preventDefault: () => { prevented = true; } }));
    return prevented;
};
const toggleState = (cell) => (cell.style.backgroundColor === 'gray' ? 'Off' : 'On');

// --- saved preferences: load ---------------------------------------------
{
    console.log('--- saved preferences (load) ---');
    const frontierRow = document.getElementById('helperFrontierToggle');
    const crawlerNumbers = [];
    const collect = (element) => { if (element.tagName === 'INPUT') crawlerNumbers.push(element); element.children.forEach(collect); };
    collect(document.getElementById('helperCrawlerPanel'));
    const checkboxes = crawlerNumbers.filter((input) => input.type === 'checkbox');
    const numbers = crawlerNumbers.filter((input) => input.type === 'number');
    const attempts = numbers[numbers.length - 1];
    const epicPriority = numbers[2];
    console.log('  frontier ' + toggleState(frontierRow) + ', attempts ' + attempts.value + ', mythic ' + checkboxes[4].checked
        + ', epic priority ' + epicPriority.value + ', safari runs ' + document.getElementById('helperSafariRuns').value);
    if (toggleState(frontierRow) !== 'On') fail('saved frontier restart not restored');
    if (attempts.value !== '3') fail('saved attempts not restored: ' + attempts.value);
    if (checkboxes[4].checked) fail('saved mythic switch-off not restored');
    if (epicPriority.value !== '1.5') fail('invalid saved priority was used: ' + epicPriority.value);
    if (document.getElementById('helperSafariRuns').value !== '1') fail('invalid saved safari runs was used');
    // Put the defaults back, so the checks below see a fresh install.
    rightClick(frontierRow);
    attempts.value = '1';
    (attempts.listeners.change || []).forEach((handler) => handler());
    checkboxes[4].checked = true;
    (checkboxes[4].listeners.change || []).forEach((handler) => handler());
    console.log('');
}

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
    console.log('--- panel toggles ---');
    // Poke Balls filter behaviour, laid out side by side with a line between.
    const cells = ['helperClickerToggle', 'helperFrontierToggle'].map((id) => document.getElementById(id));
    if (cells.some((cell) => !cell)) {
        fail('toggle cells missing from the panel');
    } else {
        const description = (cell) => tooltips.get(cell.children[0])?.title ?? '';
        console.log('  ' + cells.map((cell) => cell.textContent + ' (' + toggleState(cell) + ') [' + cell.className + ']').join('  |  '));
        cells.forEach((cell) => console.log('    ' + cell.textContent + ' tooltip: "' + description(cell) + '"'));
        if (cells[0].parentNode !== cells[1].parentNode || cells[0].parentNode.tagName !== 'TR') fail('toggles are not side by side in one row');
        if (!cells[0].classList.contains('border-right')) fail('no dividing line after the left toggle');
        if (cells[1].classList.contains('border-right')) fail('dividing line after the last toggle');
        cells.forEach((cell) => {
            if (!description(cell)) fail(cell.id + ' has no description tooltip');
            if (cell.children[0].title) fail(cell.id + ' title attribute would override the Bootstrap tooltip');
        });

        const clickerCell = cells[0];
        if (toggleState(clickerCell) !== 'Off' || clickerCell.style.color !== 'lightgray') fail('off cell is not greyed out');
        if (!rightClick(clickerCell)) fail('right click did not suppress the browser menu');
        console.log('  after right click on auto clicker -> ' + toggleState(clickerCell));
        if (toggleState(clickerCell) !== 'On' || clickerCell.style.color) fail('right click did not turn auto clicker on');

        // a hotkey flips the flag; the refresh must mirror it back onto the cell
        refreshHandlers.forEach((handler) => handler());
        if (toggleState(clickerCell) !== 'On') fail('auto clicker cell did not stay on');
        rightClick(clickerCell);
        if (toggleState(clickerCell) !== 'Off') fail('second right click did not turn auto clicker off');
    }

    // Help button: the Poke Balls "?" with one hotkey per line in its tooltip.
    const helpButton = document.getElementById('helperHelpButton');
    const helpLines = (tooltips.get(helpButton)?.title ?? '').split('<br>');
    if (!helpButton) {
        fail('no help button on the Helper card');
    } else {
        console.log('  help button "' + helpButton.textContent + '" [' + helpButton.className + '] tooltip:');
        helpLines.forEach((line) => console.log('    ' + line));
        if (helpButton.parentNode !== panel) fail('help button is not on the card itself');
        if (helpButton.className !== 'btn btn-info') fail('help button styling differs from the Poke Balls card');
        if (helpButton.title) fail('help button title attribute would override the Bootstrap tooltip');
        if (tooltips.get(helpButton)?.html !== true) fail('help tooltip is not html, so the lines would run together');
        const keys = helpLines.map((line) => line.split(' - ')[0]);
        if (keys.join(',') !== 'J,V,N,G') fail('expected one hotkey per line, got ' + JSON.stringify(helpLines));
        if (helpLines.some((line) => /right click/i.test(line))) fail('toggle hint still in the help tooltip');
    }
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

// --- safari crawler -------------------------------------------------------
console.log('');
console.log('--- safari modal header ---');
console.log('  ' + safariHeader.children.map((child) => child.tagName + '#' + (child.id || '-')
    + ' "' + child.textContent + '"').join(' -> '));

const safariButton = document.getElementById('helperSafariToggle');
const safariControls = document.getElementById('helperSafariControls');
const safariRunsInput = document.getElementById('helperSafariRuns');
if (!safariButton || !safariControls || !safariRunsInput) {
    fail('safari controls not inserted into the modal header');
} else {
    const refreshAll = () => refreshHandlers.forEach((handler) => handler());
    const safariTick = () => safariHandlers.forEach((handler) => handler());
    const isShown = (element) => element.style.display !== 'none';

    // Before the game's own Leave button, so the controls sit together.
    const headerOrder = safariHeader.children.map((child) => child.id || 'leave');
    if (headerOrder.join(',') !== 'helperSafariControls,leave') {
        fail('unexpected safari header order: ' + headerOrder.join(','));
    }

    // A run entered by hand can be taken over partway: no fee, and it counts
    // as the first run.
    context.App.game.gameState = GameConstants.GameState.safari;
    context.App.game.oakItems = { calculateBonus: () => magicBallBonus };
    Safari.inProgress(true);
    refreshAll();
    console.log('  manual run     -> BUTTON "' + safariButton.textContent + '"');
    if (!isShown(safariControls) || !isShown(safariRunsInput)) fail('auto safari not offered in the middle of a manual run');
    (safariButton.listeners.click || []).forEach((handler) => handler());
    console.log('  taken over     -> fees paid ' + safariFeesPaid + ', holding ' + (Safari.queue.join(',') || 'nothing')
        + ', BUTTON "' + safariButton.textContent + '"');
    if (safariFeesPaid !== 0) fail('paid a fee to take over a run already under way');
    if (!Safari.walking) fail('did not start walking the run it took over');
    if (safariButton.textContent !== 'Stop auto safari (run 1 of 1)') fail('taken-over run label is "' + safariButton.textContent + '"');
    Safari.queue.slice().forEach((direction) => Safari.stop(direction));
    Safari.inProgress(false);
    safariTick();
    console.log('  its run ends   -> BUTTON "' + safariButton.textContent + '", sounds ' + doneSoundsPlayed);
    if (safariButton.textContent !== 'Auto safari 1 run') fail('taken-over run was not counted as run 1 of 1');
    if (doneSoundsPlayed !== 1 || safariFeesPaid !== 0) fail('taken-over run did not finish cleanly');
    doneSoundsPlayed = 0;

    Safari.inProgress(false);
    refreshAll();
    console.log('  entrance screen -> INPUT value=' + safariRunsInput.value + ', BUTTON "' + safariButton.textContent + '"');
    if (!isShown(safariControls) || !isShown(safariRunsInput)) fail('auto safari not offered on the entrance screen');

    safariRunsInput.value = '2';
    (safariRunsInput.listeners.change || []).forEach((handler) => handler());
    if (safariButton.textContent !== 'Auto safari 2 runs') fail('runs input not reflected: ' + safariButton.textContent);

    console.log('');
    console.log('--- safari runs ---');
    (safariButton.listeners.click || []).forEach((handler) => handler());
    console.log('  after start -> fees paid ' + safariFeesPaid + ', BUTTON "' + safariButton.textContent + '"');
    if (safariFeesPaid !== 1 || !Safari.inProgress()) fail('starting did not pay for the first run');
    if (safariButton.textContent !== 'Stop auto safari (run 1 of 2)') fail('running label is "' + safariButton.textContent + '"');
    if (isShown(safariRunsInput)) fail('runs input still editable mid-run');

    console.log('');
    console.log('--- safari walking ---');
    const releaseAll = () => Safari.queue.slice().forEach((direction) => Safari.stop(direction));
    // Plays the held direction out one tile, the way the step animation would.
    const advanceSafariPlayer = () => {
        const offset = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[Safari.queue[0]];
        if (!offset) return false;
        Safari.playerXY = { x: Safari.playerXY.x + offset[0], y: Safari.playerXY.y + offset[1] };
        return true;
    };

    // An item outranks a Pokemon, even a nearer one.
    Safari.itemGrid([{ x: 4, y: 4 }]);
    Safari.pokemonGrid([{ x: 2, y: 3 }]);
    safariTick();
    console.log('  item (4,4) vs pokemon (2,3) -> holding ' + Safari.queue.join(','));
    if (Safari.queue[0] !== 'right') fail('expected to head right for the item, holding ' + Safari.queue.join(','));
    if (!Safari.walking) fail('direction is not being held');

    // Held, not tapped: another tick on the same tile changes nothing.
    Safari.isMoving = true;
    safariTick();
    if (Safari.queue.join(',') !== 'right') fail('re-steered a tile already steered: ' + Safari.queue.join(','));
    Safari.isMoving = false;

    // Pokemon beyond the grass band: the route goes round it, turning on the
    // move without ever letting go.
    releaseAll();
    Safari.playerXY = { x: 2, y: 4 };
    Safari.itemGrid([]);
    Safari.pokemonGrid([{ x: 2, y: 0 }]);
    const route = [];
    let wasReleased = false;
    for (let tile = 0; tile < 12; tile++) {
        safariTick();
        if (route.length && !Safari.walking) wasReleased = true;
        Safari.isMoving = true;
        if (!advanceSafariPlayer()) break;
        route.push(Safari.playerXY.x + ',' + Safari.playerXY.y);
        if (Safari.playerXY.x === 2 && Safari.playerXY.y === 0) break;
    }
    Safari.isMoving = false;
    console.log('  route to (2,0) -> ' + route.join(' '));
    if (route[route.length - 1] !== '2,0') fail('never reached the Pokemon');
    if (route.some((tile) => { const [x, y] = tile.split(',').map(Number); return safariGrid[y][x] === 10; })) {
        fail('walked through grass on the way');
    }
    if (wasReleased) fail('let go of the direction mid-route');
    if (route.length !== 8) fail('route is not the shortest way round: ' + route.length + ' tiles');

    // Nothing spawned: grass is the target, and it keeps walking inside it.
    releaseAll();
    Safari.pokemonGrid([]);
    Safari.playerXY = { x: 2, y: 3 };
    safariTick();
    console.log('  no spawns at (2,3)        -> holding ' + Safari.queue.join(','));
    if (Safari.queue[0] !== 'up') fail('expected to step up into the grass band, holding ' + Safari.queue.join(','));
    Safari.isMoving = true;
    advanceSafariPlayer();
    safariTick();
    console.log('  inside the band at (2,2)  -> holding ' + Safari.queue.join(','));
    if (!['left', 'right'].includes(Safari.queue[0])) fail('left the grass instead of wandering it: ' + Safari.queue.join(','));
    Safari.isMoving = false;
    releaseAll();

    console.log('');
    console.log('--- safari battle ---');
    const runBattle = (enemy, turns) => {
        safariActions.length = 0;
        SafariBattle.enemy = enemy;
        Safari.inBattle(true);
        for (let turn = 0; turn < turns; turn++) safariTick();
        Safari.inBattle(false);
        return safariActions.join(',');
    };
    const tough = () => ({ baseCatchFactor: 170 / 6, catchFactor: 32 });

    // Catch rate 170, level 20, no Magic Ball: the wiki says Nanab then Rock.
    let actions = runBattle(tough(), 4);
    console.log('  rate 170, lvl 20, no MB -> ' + actions);
    if (actions !== 'bait:Nanab,rock,ball,ball') fail('wrong opener for rate 170 lvl 20: ' + actions);
    if (SafariBattle.selectedBait() !== BaitList.Bait) fail('player bait selection was not restored');

    // The same Pokemon at level 10 is on the Razz side of the table.
    Safari.safariLevel(10);
    actions = runBattle(tough(), 3);
    console.log('  rate 170, lvl 10, no MB -> ' + actions);
    if (actions !== 'bait:Razz,rock,ball') fail('wrong opener for rate 170 lvl 10: ' + actions);

    // Level 5 Magic Ball, rate 180, level 40: Razz alone.
    Safari.safariLevel(40);
    magicBallBonus = 10;
    actions = runBattle({ baseCatchFactor: 30, catchFactor: 60 }, 2);
    console.log('  rate 180, lvl 40, MB 5  -> ' + actions);
    if (actions !== 'bait:Razz,ball') fail('wrong opener for rate 180 lvl 40 with Magic Ball: ' + actions);
    magicBallBonus = 0;
    Safari.safariLevel(20);

    // No Nanab left: skip the opener rather than Rock without its bait.
    berryStock.Nanab = 0;
    actions = runBattle(tough(), 2);
    console.log('  no Nanab berries        -> ' + actions);
    if (actions !== 'ball,ball') fail('threw an opener without its berry: ' + actions);
    berryStock.Nanab = 5;

    // Already certain: an opener would only waste turns.
    actions = runBattle({ baseCatchFactor: 45, catchFactor: 100 }, 1);
    if (actions !== 'ball') fail('opened on a guaranteed catch: ' + actions);

    // busy() is the game's gate on every animation chain.
    safariActions.length = 0;
    SafariBattle.enemy = tough();
    Safari.inBattle(true);
    SafariBattle.busy(true);
    safariTick();
    if (safariActions.length) fail('acted over a busy animation');
    SafariBattle.busy(false);
    Safari.inBattle(false);

    console.log('');
    console.log('--- safari run end ---');
    // gameOver: inProgress cleared, then the modal closes. The next run waits
    // for it to close, reopens it, and pays once it has opened.
    Safari.inProgress(false);
    safariModalState = 'hide';
    safariTick();
    if (safariModalOpens !== 0 || safariFeesPaid !== 1) fail('acted while the modal was still closing');
    safariModalState = 'hidden';
    safariTick();
    if (safariModalOpens !== 1) fail('did not reopen the modal for run 2');
    safariModalState = 'show';
    safariModalTransitioning = true;
    safariTick();
    if (safariFeesPaid !== 1) fail('paid before the modal finished opening');
    safariModalTransitioning = false;
    safariTick();
    refreshAll();
    console.log('  run 1 over -> fees paid ' + safariFeesPaid + ', BUTTON "' + safariButton.textContent + '"');
    if (safariFeesPaid !== 2) fail('did not pay for run 2');
    if (safariButton.textContent !== 'Stop auto safari (run 2 of 2)') fail('run 2 label is "' + safariButton.textContent + '"');

    // The last run ends: stop, let go of the keys, and play the done sound.
    Safari.queue = ['up'];
    Safari.walking = true;
    Safari.inProgress(false);
    refreshAll();
    safariTick();
    console.log('  run 2 over -> BUTTON "' + safariButton.textContent + '", sounds ' + doneSoundsPlayed
        + ', holding ' + (Safari.queue.join(',') || 'nothing'));
    if (safariButton.textContent !== 'Auto safari 2 runs') fail('kept running after the last run');
    if (safariFeesPaid !== 2) fail('paid for a run beyond the count');
    if (doneSoundsPlayed !== 1) fail('no sound when the runs finished');
    if (Safari.queue.length) fail('finishing left a direction held');

    // Out of Quest Points: stop, and still say so with the sound.
    safariCanPay = false;
    safariModalState = 'show';
    (safariButton.listeners.click || []).forEach((handler) => handler());
    console.log('  cannot pay -> fees paid ' + safariFeesPaid + ', sounds ' + doneSoundsPlayed);
    if (safariFeesPaid !== 2 || safariButton.textContent !== 'Auto safari 2 runs') fail('ran without Quest Points');
    if (doneSoundsPlayed !== 2) fail('no sound when stopping for Quest Points');
    safariCanPay = true;

    // Leaving mid-run pauses: keys let go, nothing is paid, and going back in
    // carries on with the same run.
    (safariButton.listeners.click || []).forEach((handler) => handler());
    const feesBeforeLeaving = safariFeesPaid;
    Safari.queue = ['left'];
    Safari.walking = true;
    context.App.game.gameState = GameConstants.GameState.town;
    safariTick();
    safariTick();
    refreshAll();
    console.log('  left mid-run -> BUTTON "' + safariButton.textContent + '", holding ' + (Safari.queue.join(',') || 'nothing'));
    if (!/^Stop auto safari/.test(safariButton.textContent)) fail('leaving mid-run stopped auto safari instead of pausing it');
    if (Safari.queue.length) fail('leaving mid-run left a direction held');
    if (safariFeesPaid !== feesBeforeLeaving || safariModalOpens !== 1) fail('tried to open or pay while the run was only paused');
    context.App.game.gameState = GameConstants.GameState.safari;
    Safari.playerXY = { x: 2, y: 4 };
    safariTick();
    console.log('  went back    -> holding ' + (Safari.queue.join(',') || 'nothing'));
    if (!Safari.walking) fail('did not carry on walking after going back in');
    (safariButton.listeners.click || []).forEach((handler) => handler());
    if (safariButton.textContent !== 'Auto safari 2 runs') fail('Stop did not stop a resumed run');
}

console.log(failures ? failures + ' FAILURE(S) (safari)' : 'safari checks passed');
if (failures) process.exitCode = 1;

// --- saved preferences: save ---------------------------------------------
console.log('');
console.log('--- saved preferences (save) ---');
{
    const saved = JSON.parse(storage.get(PREFERENCES_KEY) || '{}');
    console.log('  ' + JSON.stringify(saved));
    if (saved.crawlerMode !== 'allChests') fail('invalid saved crawler mode survived a save');
    if (saved.safariRunsRequested !== 2) fail('safari runs not saved');
    if (saved.chestSettings?.epic?.priority !== 1.5) fail('invalid saved priority survived a save');
    if (saved.isFrontierRestartRunning !== false) fail('frontier switch-off not saved');
    if (typeof saved.isClickerRunning !== 'boolean' || typeof saved.isHatcheryAutoFillRunning !== 'boolean') {
        fail('toggles missing from the saved preferences');
    }
    if ('isCrawlerRunning' in saved || 'isSafariRunning' in saved) fail('a run in progress was saved');

    // The hotkey path saves too, not only the switches.
    context.App.game.gameState = GameConstants.GameState.town;
    rightClick(document.getElementById('helperClickerToggle'));
    if (JSON.parse(storage.get(PREFERENCES_KEY)).isClickerRunning !== true) fail('auto clicker switch-on not saved');
}

console.log(failures ? failures + ' FAILURE(S) (preferences)' : 'preference checks passed');
if (failures) process.exitCode = 1;

// --- crawler finish sound -------------------------------------------------
console.log('');
console.log('--- crawler finish sound ---');
{
    const crawlerButtons = [];
    const collect = (element) => { if (element.tagName === 'BUTTON') crawlerButtons.push(element); element.children.forEach(collect); };
    collect(document.getElementById('helperCrawlerPanel'));
    const crawlerButton = crawlerButtons.find((button) => /crawler|Stop \(/i.test(button.textContent));
    const press = () => (crawlerButton.listeners.click || []).forEach((handler) => handler());
    context.App.game.gameState = GameConstants.GameState.town;
    context.player.town = { dungeon: {} };

    // The last attempt ending on its own plays the sound.
    const soundsBefore = doneSoundsPlayed;
    press();
    context.DungeonRunner.dungeonFinished(true);
    context.DungeonRunner.dungeonFinished(false);
    console.log('  all attempts done -> BUTTON "' + crawlerButton.textContent + '", sounds ' + (doneSoundsPlayed - soundsBefore));
    if (doneSoundsPlayed - soundsBefore !== 1) fail('no sound when the crawler finished its attempts');

    // Stopping it by hand is not worth a sound.
    press();
    press();
    console.log('  stopped by hand   -> BUTTON "' + crawlerButton.textContent + '", sounds ' + (doneSoundsPlayed - soundsBefore));
    if (doneSoundsPlayed - soundsBefore !== 1) fail('played the sound for a stop the player asked for');
}

console.log(failures ? failures + ' FAILURE(S) (crawler sound)' : 'crawler sound checks passed');
if (failures) process.exitCode = 1;

// --- safari hotkey --------------------------------------------------------
console.log('');
console.log('--- safari hotkey ---');
{
    const pressKey = (key, target) => keydownHandlers.forEach((handler) => handler({
        key, target: target ?? document.documentElement, preventDefault: () => {},
    }));
    const button = document.getElementById('helperSafariToggle');
    const runsBox = document.getElementById('helperSafariRuns');
    const notifiedBefore = notifications.length;
    const feesBefore = safariFeesPaid;
    Safari.queue.slice().forEach((direction) => Safari.stop(direction));

    // Anywhere but the safari screen, V does nothing at all.
    context.App.game.gameState = GameConstants.GameState.town;
    Safari.inProgress(false);
    pressKey('v');
    console.log('  V in a town -> BUTTON "' + button.textContent + '", notifications ' + (notifications.length - notifiedBefore));
    if (/^Stop/.test(button.textContent)) fail('V started auto safari outside the safari screen');
    if (notifications.length !== notifiedBefore) fail('V outside the safari screen still showed a notification');

    // On the entrance screen, V starts and pays, even with the runs box focused
    // and a new count typed but not yet committed.
    context.App.game.gameState = GameConstants.GameState.safari;
    safariModalState = 'show';
    runsBox.value = '3';
    pressKey('v', runsBox);
    console.log('  V on the entrance, runs box says 3 -> fees paid ' + (safariFeesPaid - feesBefore) + ', BUTTON "' + button.textContent + '"');
    if (safariFeesPaid - feesBefore !== 1) fail('V on the entrance screen did not start a run');
    if (button.textContent !== 'Stop auto safari (run 1 of 3)') fail('V ignored the typed run count: ' + button.textContent);

    // And V again stops it.
    pressKey('v');
    if (/^Stop/.test(button.textContent)) fail('V did not stop auto safari');
}

console.log(failures ? failures + ' FAILURE(S) (safari hotkey)' : 'safari hotkey checks passed');
if (failures) process.exitCode = 1;
