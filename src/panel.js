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

    // Modules register their own cell; registration order is left to right.
    const panelToggles = [];

    const contributeToggle = (elementId, labelText, description, isOn, setOn) => {
        panelToggles.push({ elementId, labelText, description, isOn, setOn, cell: null });
    };

    // Bootstrap prefers a title attribute over the option, so it is only a fallback.
    const attachTooltip = (element, title, placement) => {
        if (typeof $ === 'function' && typeof $(element).tooltip === 'function') {
            $(element).tooltip({ title, trigger: 'hover', placement, html: true, boundary: 'window', animation: false });
        } else {
            element.title = title.replace(/<br>/g, '\n');
        }
    };

    // Built from the key constants, so it cannot drift from the handler.
    const helpTooltip = () => [
        `${CRAWLER_TOGGLE_KEY.toUpperCase()} - start/stop dungeon crawler`,
        `${SAFARI_TOGGLE_KEY.toUpperCase()} - start/stop auto safari (in the Safari Zone)`,
        `${CLICKER_TOGGLE_KEY.toUpperCase()} - toggle auto clicker`,
        `${FILL_HATCHERY_KEY.toUpperCase()} - fill the hatchery and queue`,
    ].join('<br>');

    const buildPanel = () => {
        const { panel, body } = buildCard(PANEL_ID, PANEL_BODY_ID, 'Helper', 'sortable');
        // Flush like the Poke Balls card, so the cells reach the card edges.
        body.classList.remove('p-2');
        body.classList.add('p-0');

        // Copied off the Poke Balls card's "?" button, styles and all.
        const helpButton = buildElement('button', 'btn btn-info', '?');
        helpButton.type = 'button';
        helpButton.id = 'helperHelpButton';
        Object.assign(helpButton.style, {
            position: 'absolute', right: '0px', top: '0px', width: 'auto', height: '41px', padding: '4px',
        });
        attachTooltip(helpButton, helpTooltip(), 'left');
        panel.insertBefore(helpButton, body);

        // Fixed layout so the cells split the width evenly.
        const table = buildElement('table', 'table table-sm m-0');
        table.style.tableLayout = 'fixed';
        const tableBody = buildElement('tbody');
        const row = buildElement('tr');
        panelToggles.forEach((toggle, index) => {
            const isLast = index === panelToggles.length - 1;
            const cell = buildElement('td', `align-middle text-center${isLast ? '' : ' border-right'}`);
            cell.id = toggle.elementId;
            cell.style.padding = '0.3rem';
            cell.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                toggle.setOn(!toggle.isOn());
                refreshPanel();
            });

            const name = buildElement('span', null, toggle.labelText);
            attachTooltip(name, toggle.description, 'top');
            cell.appendChild(name);
            row.appendChild(cell);
            toggle.cell = cell;
        });
        tableBody.appendChild(row);
        table.appendChild(tableBody);
        body.appendChild(table);

        controlElements.panel = panel;
        return panel;
    };

    // The game's grey-out rule is scoped to #pokeballSelector, so its colours are copied.
    const refreshPanelButtons = () => {
        panelToggles.forEach((toggle) => {
            if (!toggle.cell) {
                return;
            }
            const isOn = toggle.isOn();
            toggle.cell.style.backgroundColor = isOn ? '' : 'gray';
            toggle.cell.style.color = isOn ? '' : 'lightgray';
        });
    };

    function refreshPanel() {
        refreshPanelButtons();
        refreshCrawlerControls();
        refreshHatcheryButton();
        refreshSafariButton();
        savePreferences();
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
