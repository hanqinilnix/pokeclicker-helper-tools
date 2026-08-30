// Selling every Underground item of a value type at once.

    // ---------------------------------------------------------------------
    // Underground bulk selling
    // ---------------------------------------------------------------------

    // gainProfit returns false for every value type but these two. Gems land
    // in eighteen per-type wallets, so only diamonds report a figure.
    const UNDERGROUND_SELL_TYPES = [
        { valueTypeName: 'Diamond', currencyLabel: 'Diamonds', reportsGain: true },
        { valueTypeName: 'Gem', currencyLabel: 'Gems', reportsGain: false },
    ];

    // Read the balance rather than predict it.
    const diamondBalance = () => App.game.wallet.currencies[GameConstants.Currency.diamond]();

    const sellAllUndergroundItems = ({ valueTypeName, currencyLabel, reportsGain }) => {
        const valueType = UndergroundItemValueType[valueTypeName];
        const owned = UndergroundItems.getUnlockedItems()
            .filter((item) => item.valueType === valueType && player.itemList[item.itemName]() > 0);

        // Guards sellLocked, which is dev scaffolding for unreleased content.
        const lockedCount = owned.filter((item) => item.sellLocked()).length;
        const sellable = owned.filter((item) => !item.sellLocked());

        const balanceBefore = reportsGain ? diamondBalance() : 0;
        let soldCount = 0;
        sellable.forEach((item) => {
            const amount = player.itemList[item.itemName]();
            UndergroundController.sellMineItem(item, amount);
            soldCount += amount;
        });

        const gainedNote = reportsGain
            ? `${(diamondBalance() - balanceBefore).toLocaleString('en-US')} ${currencyLabel}`
            : currencyLabel;
        const lockedNote = lockedCount ? ` — ${lockedCount} locked kind${lockedCount === 1 ? '' : 's'} kept` : '';
        notify(soldCount
            ? `Sold ${soldCount.toLocaleString('en-US')} item${soldCount === 1 ? '' : 's'} for ${gainedNote}${lockedNote}`
            : `Nothing to sell for ${currencyLabel}${lockedNote}`);
    };

    // ---------------------------------------------------------------------
    // Bulk selling controls
    // ---------------------------------------------------------------------

    // The Quick-Sell button has no id, so its data-bind is the anchor.
    const insertUndergroundSellButtons = () => {
        if (document.getElementById('helperSellAllDiamond')) {
            return true;
        }
        const quickSellButton = document.querySelector('#treasures button[data-bind*="quickSellEnabled"]');
        const formGroup = quickSellButton?.parentNode;
        if (!formGroup) {
            return false;
        }

        UNDERGROUND_SELL_TYPES.forEach((sellType) => {
            const button = buildElement('button', quickSellButton.className, `Sell all for ${sellType.currencyLabel}`);
            button.type = 'button';
            button.id = `helperSellAll${sellType.valueTypeName}`;
            button.addEventListener('click', () => sellAllUndergroundItems(sellType));
            formGroup.appendChild(button);
        });

        return true;
    };
