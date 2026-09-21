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

    contributeToggle('helperFrontierToggle', 'Frontier Restart',
        'Starts a new Battle Frontier run when one ends in a loss.',
        () => isFrontierRestartRunning,
        (isOn) => { isFrontierRestartRunning = isOn; });
