// Safari Zone automation: walking the map, and catching what it meets.

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
