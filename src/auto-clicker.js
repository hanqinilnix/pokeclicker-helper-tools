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
