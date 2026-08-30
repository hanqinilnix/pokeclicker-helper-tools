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
