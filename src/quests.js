// Lifts the quest slot cap and starts every quest in a new set.

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
    };

