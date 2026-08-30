// Filling the hatchery and queue, and its controls in the breeding modal.

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
            refreshHatcheryButton();
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
