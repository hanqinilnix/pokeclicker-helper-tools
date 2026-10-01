// Lifts the quest slot cap, starts every quest in a new set and claims each one done.

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

