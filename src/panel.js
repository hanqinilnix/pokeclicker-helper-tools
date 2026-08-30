// The Helper card, and the row modules register their toggles into.

    // ---------------------------------------------------------------------
    // Panel
    // ---------------------------------------------------------------------

    // One registry across four hosts, populated one at a time during boot,
    // so each refresh guards its own group.
    const controlElements = {};

    const PANEL_ID = 'helperPanel';
    const PANEL_BODY_ID = 'helperPanelBody';
    const CRAWLER_PANEL_ID = 'helperCrawlerPanel';
    const CRAWLER_PANEL_BODY_ID = 'helperCrawlerPanelBody';
    const COLLAPSED_STORAGE_PREFIX = 'pokeclicker-helper.collapsed.';

    const readPanelCollapsed = (bodyId) => {
        try {
            return localStorage.getItem(COLLAPSED_STORAGE_PREFIX + bodyId) === 'true';
        } catch (error) {
            return false;
        }
    };

    const writePanelCollapsed = (bodyId, isCollapsed) => {
        try {
            localStorage.setItem(COLLAPSED_STORAGE_PREFIX + bodyId, String(isCollapsed));
        } catch (error) {
            // Private windows: it just opens expanded next time.
        }
    };

    // Plain DOM: ko.applyBindings already ran. Collapse copies the game's cards.
    // State in localStorage - Settings would leave keys in the save.
    const buildCard = (panelId, bodyId, title, extraPanelClasses) => {
        const panel = buildElement('div', `card ${extraPanelClasses} border-secondary mb-3`);
        panel.id = panelId;

        const header = buildElement('div', 'card-header p-0');
        header.setAttribute('data-toggle', 'collapse');
        header.setAttribute('href', `#${bodyId}`);
        header.style.textAlign = 'center';
        header.style.cursor = 'pointer';
        header.appendChild(buildElement('span', null, title));
        panel.appendChild(header);

        const body = buildElement('div', `card-body p-2 collapse${readPanelCollapsed(bodyId) ? '' : ' show'}`);
        body.id = bodyId;
        panel.appendChild(body);

        if (typeof $ !== 'undefined') {
            $(body).on('show.bs.collapse', () => writePanelCollapsed(bodyId, false));
            $(body).on('hide.bs.collapse', () => writePanelCollapsed(bodyId, true));
        }

        return { panel, body };
    };

    // Modules register their own switch; registration order is display order.
    const panelToggles = [];

    const contributeToggle = (elementId, labelText, isOn, setOn) => {
        panelToggles.push({ elementId, labelText, isOn, setOn, input: null });
    };

    const buildPanel = () => {
        const { panel, body } = buildCard(PANEL_ID, PANEL_BODY_ID, 'Helper', 'sortable');

        // A pair needs ~320px; flex-wrap covers a narrower host.
        const togglesRow = buildRow();
        togglesRow.classList.add('flex-wrap');
        togglesRow.style.gap = '0.75rem';

        panelToggles.forEach((toggle) => {
            const builtSwitch = buildSwitch(toggle.elementId, toggle.labelText);
            builtSwitch.input.addEventListener('change', () => {
                toggle.setOn(builtSwitch.input.checked);
                refreshPanel();
            });
            builtSwitch.row.classList.add('flex-fill', 'text-nowrap');
            togglesRow.appendChild(builtSwitch.row);
            toggle.input = builtSwitch.input;
        });
        body.appendChild(togglesRow);

        controlElements.panel = panel;
        return panel;
    };

    // Mirrors each flag onto its switch, keeping hotkeys and panel in agreement.
    const refreshPanelButtons = () => {
        panelToggles.forEach((toggle) => {
            if (toggle.input) {
                toggle.input.checked = toggle.isOn();
            }
        });
    };

    function refreshPanel() {
        refreshPanelButtons();
        refreshCrawlerControls();
        refreshHatcheryButton();
    }

    // Each column keeps its own order setting, and the cards are in different ones.
    const savedColumnOrder = (columnId) => {
        try {
            return String(Settings.getSetting(`modules.${columnId}`).observableValue() ?? '')
                .split('|').filter(Boolean);
        } catch (error) {
            return [];
        }
    };

    // The game's reorder pass skips these cards, so replay it here.
    const applySavedPanelPosition = (panel) => {
        const column = panel.parentNode;
        const order = savedColumnOrder(column.id);
        const panelIndex = order.indexOf(panel.id);
        if (panelIndex === -1) {
            return;
        }

        // Nearest saved neighbour still here; cards move columns or disappear.
        for (let index = panelIndex - 1; index >= 0; index--) {
            const previous = document.getElementById(order[index]);
            if (previous && previous.parentNode === column) {
                const reference = previous.nextSibling;
                // insertBefore(panel, panel) only works by spec special case.
                if (reference !== panel) {
                    column.insertBefore(panel, reference);
                }
                return;
            }
        }
        // When already first, firstChild IS the panel.
        if (column.firstChild !== panel) {
            column.insertBefore(panel, column.firstChild);
        }
    };

    // The game's own id is misspelled ("achivement"), so both are tried.
    const findTrackerContainer = () => document.getElementById('achivementTrackerContainer')
        ?? document.getElementById('achievementTrackerContainer');

    // Defaults first, then any dragged position overrides.
    const placeAllPanels = () => {
        const panel = controlElements.panel;
        const crawlerPanel = controlElements.crawlerPanel;
        if (!panel) {
            return false;
        }

        // Under the currency container; the tracker only covers a rename.
        const topAnchor = document.getElementById('currencyContainer') ?? findTrackerContainer();
        if (!topAnchor?.parentNode) {
            return false;
        }
        topAnchor.parentNode.insertBefore(panel, topAnchor.nextSibling);

        // Above the town map, which puts it between the battle view and the map.
        if (crawlerPanel) {
            const townMap = document.getElementById('townMap');
            const bottomColumn = document.getElementById('middle-bottom-sort-column');
            if (townMap?.parentNode) {
                townMap.parentNode.insertBefore(crawlerPanel, townMap);
            } else if (bottomColumn) {
                bottomColumn.appendChild(crawlerPanel);
            } else {
                panel.parentNode.insertBefore(crawlerPanel, panel.nextSibling);
            }
        }

        // Saved order, not build order, or a card anchors to an unmoved neighbour.
        [panel, crawlerPanel]
            .filter((card) => card && savedColumnOrder(card.parentNode.id).includes(card.id))
            .sort((left, right) => savedColumnOrder(left.parentNode.id).indexOf(left.id)
                - savedColumnOrder(right.parentNode.id).indexOf(right.id))
            .forEach(applySavedPanelPosition);
        return true;
    };

    const insertPanel = () => {
        if (document.getElementById(PANEL_ID)) {
            return true;
        }
        if (!document.getElementById('currencyContainer') && !findTrackerContainer()) {
            return false;
        }
        buildPanel();
        buildCrawlerPanel();
        placeAllPanels();
        refreshPanel();
        return true;
    };

    // SortModules runs from Save.load, long after document-idle, and strands
    // anything inserted earlier.
    const patchSortModules = () => {
        if (typeof window === 'undefined' || typeof SortModules !== 'function') {
            return;
        }
        const originalSortModules = SortModules;
        window.SortModules = (...sortArguments) => {
            const result = originalSortModules(...sortArguments);
            placeAllPanels();
            return result;
        };
    };
