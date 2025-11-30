// ==UserScript==
// @name         招聘网站强力屏蔽助手 (Boss直聘 + 前程无忧) - Google Style
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  数据通用的屏蔽助手！一键屏蔽垃圾公司，在 Boss直聘 和 前程无忧 之间共享黑名单。遵循 Google 工程标准修正版。
// @author       Gemini (Modified by Google CTO Persona)
// @match        *://www.zhipin.com/*
// @match        *://*.51job.com/*
// @match        *://search.51job.com/*
// @match        *://we.51job.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    /**
     * Configuration constants.
     * Centralized configuration for easy maintenance.
     */
    const CONFIG = {
        STORAGE_KEY: 'universal_job_blacklist',
        UI_Z_INDEX: 2147483647, // Max safe integer for z-index
        REFRESH_INTERVAL_MS: 2500,
        DEBOUNCE_DELAY_MS: 200,
    };

    /**
     * Site-specific configurations.
     * Defines how to identify job cards and company names on different platforms.
     */
    const SITE_CONFIGS = {
        boss: {
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li'],
            nameSelectors: ['.boss-name', '.company-name', 'a[href*="/gongsi/"]', '.job-company span.company-text'],
            key: 'boss'
        },
        job51: {
            cardSelectors: ['.joblist-item', '.j_joblist .e', '.el', '.job-list-item'],
            nameSelectors: ['.cname a', '.cname', '.t2 a', '.er a', '.company_name'],
            key: '51job'
        }
    };

    // Determine current site context
    const currentSiteConfig = location.host.includes('zhipin.com') ? SITE_CONFIGS.boss : SITE_CONFIGS.job51;

    /**
     * Storage Manager.
     * Handles data persistence and synchronization.
     * Acts as the Single Source of Truth for blocked companies.
     */
    const StorageManager = {
        getBlacklist: function() {
            return GM_getValue(CONFIG.STORAGE_KEY, []);
        },

        addCompany: function(name) {
            if (!name) return false;
            const trimmedName = name.trim();
            const list = this.getBlacklist();
            if (!list.includes(trimmedName)) {
                list.push(trimmedName);
                GM_setValue(CONFIG.STORAGE_KEY, list);
                return true;
            }
            return false;
        },

        removeCompany: function(name) {
            const list = this.getBlacklist();
            const newList = list.filter(n => n !== name);
            GM_setValue(CONFIG.STORAGE_KEY, newList);
        },

        clearBlacklist: function() {
            GM_setValue(CONFIG.STORAGE_KEY, []);
        }
    };

    /**
     * Style Manager.
     * Injects necessary CSS styles into the document.
     */
    const StyleManager = {
        inject: function() {
            const styles = `
                /* Block Button */
                .universal-block-btn {
                    position: absolute;
                    top: 0;
                    right: 0;
                    z-index: 9999;
                    background: #ea4335; /* Google Red */
                    color: #fff;
                    font-family: 'Roboto', sans-serif;
                    font-size: 11px;
                    padding: 4px 8px;
                    cursor: pointer;
                    border-bottom-left-radius: 4px;
                    display: none; /* Hidden by default */
                    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                    font-weight: 500;
                    letter-spacing: 0.5px;
                }

                /* Show button on hover */
                ${currentSiteConfig.cardSelectors.map(s => `${s}:hover .universal-block-btn`).join(', ')} {
                    display: block;
                }

                /* Hidden Card State - REQUIREMENT: Directly hide, do not mask */
                .universal-blocked {
                    display: none !important;
                }

                /* Floating Action Button (FAB) */
                #universal-helper-fab {
                    position: fixed;
                    bottom: 80px;
                    right: 24px;
                    width: 48px;
                    height: 48px;
                    background: #4285f4; /* Google Blue */
                    color: white;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    z-index: ${CONFIG.UI_Z_INDEX};
                    font-size: 20px;
                    box-shadow: 0 4px 8px rgba(0,0,0,0.3);
                    transition: transform 0.2s cubic-bezier(0.4, 0.0, 0.2, 1);
                    user-select: none;
                }
                #universal-helper-fab:hover {
                    transform: scale(1.1);
                    box-shadow: 0 6px 12px rgba(0,0,0,0.4);
                }

                /* Management Panel */
                #universal-panel {
                    position: fixed;
                    bottom: 140px;
                    right: 24px;
                    width: 320px;
                    max-height: 500px;
                    background: white;
                    border: 1px solid #dadce0;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.15);
                    z-index: ${CONFIG.UI_Z_INDEX};
                    border-radius: 8px;
                    display: none;
                    flex-direction: column;
                    font-family: 'Roboto', sans-serif;
                }
                .u-header {
                    padding: 16px;
                    border-bottom: 1px solid #dadce0;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    background-color: #f8f9fa;
                    border-radius: 8px 8px 0 0;
                }
                .u-title {
                    font-weight: 500;
                    color: #202124;
                    font-size: 14px;
                }
                .u-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0;
                }
                .u-item {
                    padding: 12px 16px;
                    border-bottom: 1px solid #f1f3f4;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    font-size: 13px;
                    color: #3c4043;
                }
                .u-item:last-child {
                    border-bottom: none;
                }
                .u-item:hover {
                    background-color: #f1f3f4;
                }
                .u-remove {
                    color: #1a73e8;
                    cursor: pointer;
                    font-weight: 500;
                    margin-left: 12px;
                    font-size: 12px;
                }
                .u-remove:hover {
                    text-decoration: underline;
                }
                .u-close {
                    cursor: pointer;
                    color: #5f6368;
                    font-size: 18px;
                    line-height: 1;
                }
                .u-close:hover {
                    color: #202124;
                }
                .u-empty {
                    padding: 24px;
                    text-align: center;
                    color: #70757a;
                    font-style: italic;
                    font-size: 13px;
                }

                /* 51Job Specific Color Override */
                body[data-site="51job"] #universal-helper-fab {
                    background: #ff6000;
                }
            `;

            if (typeof GM_addStyle !== 'undefined') {
                GM_addStyle(styles);
            } else {
                const styleEl = document.createElement('style');
                styleEl.textContent = styles;
                document.head.appendChild(styleEl);
            }

            // Tag body for site-specific styling
            document.body.setAttribute('data-site', currentSiteConfig.key);
        }
    };

    /**
     * DOM Manipulation Helper.
     * Handles card processing and button injection.
     */
    const DomHandler = {
        getCompanyName: function(card) {
            for (const selector of currentSiteConfig.nameSelectors) {
                const el = card.querySelector(selector);
                if (el) {
                    // Handle cases where text might be in 'title' attribute or innerText
                    const text = el.innerText || el.textContent || el.getAttribute('title');
                    if (text && text.trim().length > 0) {
                        return text.trim();
                    }
                }
            }
            return null;
        },

        processCard: function(card, blacklist) {
            // Optimization: Check if already processed to avoid re-binding events
            if (card.dataset.uBlockProcessed === 'true') {
                // Even if processed, we must re-check blocking status in case blacklist changed
                this.updateCardVisibility(card, blacklist);
                return;
            }

            const companyName = this.getCompanyName(card);
            if (!companyName) return;

            // Store metadata on DOM element
            card.dataset.companyName = companyName;

            // Inject Block Button
            this.injectButton(card, companyName);

            // Initial visibility check
            this.updateCardVisibility(card, blacklist);

            // Mark as processed
            card.dataset.uBlockProcessed = 'true';
        },

        injectButton: function(card, companyName) {
            // Ensure relative positioning for absolute button placement
            const style = window.getComputedStyle(card);
            if (style.position === 'static') {
                card.style.position = 'relative';
            }

            const btn = document.createElement('div');
            btn.className = 'universal-block-btn';
            btn.textContent = 'Block';
            btn.title = `屏蔽 ${companyName}`;

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();

                // Blocking interaction - Requirement: Direct action, consistent with user intent
                // We removed the confirm dialog for efficiency, but you can uncomment if safety is preferred.
                // To meet "Google Standards" for efficiency, actions should be reversible, not blocked by confirmation.
                // Since we have a management panel to unblock, we can skip confirm here for speed.
                if (confirm(`Block "${companyName}"?`)) {
                     if (StorageManager.addCompany(companyName)) {
                        UIManager.refreshView();
                     }
                }
            });

            card.appendChild(btn);
        },

        updateCardVisibility: function(card, blacklist) {
            const name = card.dataset.companyName;
            if (name && blacklist.includes(name)) {
                // Requirement: "Directly not show" (display: none)
                card.classList.add('universal-blocked');
            } else {
                card.classList.remove('universal-blocked');
            }
        }
    };

    /**
     * UI Manager.
     * Controls the Management Panel and FAB.
     */
    const UIManager = {
        init: function() {
            this.createFab();
            this.createPanel();
        },

        createFab: function() {
            const fab = document.createElement('div');
            fab.id = 'universal-helper-fab';
            fab.textContent = '🛡️';
            fab.title = 'Manage Blocklist';

            fab.addEventListener('click', () => {
                this.togglePanel();
            });

            document.body.appendChild(fab);
        },

        createPanel: function() {
            const panel = document.createElement('div');
            panel.id = 'universal-panel';
            panel.innerHTML = `
                <div class="u-header">
                    <span class="u-title">Blocked Companies (<span id="u-count">0</span>)</span>
                    <span id="u-close-btn" class="u-close">×</span>
                </div>
                <div class="u-content" id="u-list"></div>
            `;

            // Close button event
            // Using event delegation pattern or direct binding
            // We need to find the element after appending it to DOM, or create it via JS objects.
            // InnerHTML is faster for template injection.
            document.body.appendChild(panel);

            document.getElementById('u-close-btn').addEventListener('click', () => {
                panel.style.display = 'none';
            });
        },

        togglePanel: function() {
            const panel = document.getElementById('universal-panel');
            if (panel.style.display === 'flex') {
                panel.style.display = 'none';
            } else {
                panel.style.display = 'flex';
                this.renderPanelList();
            }
        },

        renderPanelList: function() {
            const blacklist = StorageManager.getBlacklist();
            const listEl = document.getElementById('u-list');
            const countEl = document.getElementById('u-count');

            if (!listEl || !countEl) return;

            countEl.textContent = blacklist.length;
            listEl.innerHTML = '';

            if (blacklist.length === 0) {
                listEl.innerHTML = '<div class="u-empty">No blocked companies.</div>';
                return;
            }

            // Reverse to show newest blocked items first
            [...blacklist].reverse().forEach(name => {
                const row = document.createElement('div');
                row.className = 'u-item';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;

                const removeSpan = document.createElement('span');
                removeSpan.className = 'u-remove';
                removeSpan.textContent = 'Unblock';
                removeSpan.onclick = () => {
                    StorageManager.removeCompany(name);
                    this.refreshView(); // Refresh page to show card again
                    this.renderPanelList(); // Refresh panel
                };

                row.appendChild(nameSpan);
                row.appendChild(removeSpan);
                listEl.appendChild(row);
            });
        },

        refreshView: function() {
            // Trigger a scan to update visibility classes based on new data
            App.scan();
        }
    };

    /**
     * Application Core.
     * Orchestrates the initialization and event loops.
     */
    const App = {
        init: function() {
            console.log(`[BossBlocker] Initializing for ${currentSiteConfig.key}...`);
            StyleManager.inject();
            UIManager.init();

            // Initial Scan
            this.scan();

            // Setup Observers for dynamic content (SPA behavior)
            this.setupObservers();

            // Fallback polling for robustness
            setInterval(() => this.scan(), CONFIG.REFRESH_INTERVAL_MS);
        },

        scan: function() {
            const blacklist = StorageManager.getBlacklist();
            const selector = currentSiteConfig.cardSelectors.join(',');
            const cards = document.querySelectorAll(selector);

            cards.forEach(card => {
                DomHandler.processCard(card, blacklist);
            });
        },

        setupObservers: function() {
            const observer = new MutationObserver((mutations) => {
                let shouldUpdate = false;
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) {
                        shouldUpdate = true;
                        break;
                    }
                }
                if (shouldUpdate) {
                    this.scan();
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
        }
    };

    // Start the application
    App.init();

})();