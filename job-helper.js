// ==UserScript==
// @name        招聘网站全能助手 (v33.5 不死版)
// @namespace   http://tampermonkey.net/
// @version     33.5
// @description 全能招聘助手：集成了“自动加载”、“屏蔽黑名单”、“暂停控制”以及最新的“僵死自动刷新”功能。
// @author      Gemini (Fixed by Google Expert)
// @match       *://www.zhipin.com/*
// @match       *://*.51job.com/*
// @match       *://search.51job.com/*
// @match       *://we.51job.com/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_addStyle
// @run-at      document-idle
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 配置参数 ---
    const CONFIG = {
        STORAGE_KEY: 'universal_job_blacklist',
        UI_Z_INDEX: 2147483647,
        REFRESH_INTERVAL_MS: 500,
        CHECK_LOAD_INTERVAL: 1200,
        MIN_VISIBLE_ITEMS: 4,
        MAX_RETRY: 10,             // 常规重试上限
        AUTO_REFRESH_LIMIT: 15,    // 【新增】僵死判定阈值：连续15次加载失败触发刷新
    };

    // --- 站点特征配置 ---
    const SITE_CONFIGS = {
        boss: {
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'],
            nameSelectors: ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'],
            listContainerSelector: '.job-list-container, .rec-job-list, .job-list-box',
            scrollContainerSelector: '.page-jobs-main',
            key: 'boss'
        },
        job51: {
            cardSelectors: ['.joblist-item', '.j_joblist .e', '.el', '.job-list-item'],
            nameSelectors: ['.cname a', '.cname', '.t2 a', '.er a', '.company_name'],
            key: '51job'
        }
    };

    const currentSiteConfig = location.host.includes('zhipin.com') ? SITE_CONFIGS.boss : SITE_CONFIGS.job51;

    // --- 2. 状态管理 ---
    const State = {
        isAutoLoading: false,
        isPaused: false,
        retryCount: 0,
        lastCardCount: 0,
        hasReachedLimit: false,
        blockedCountSinceLoad: 0,
        reloadTimer: null // 刷新倒计时句柄
    };

    // --- 3. 存储模块 (通用) ---
    const Storage = {
        cache: new Set(),
        initialized: false,
        init: () => {
            if (Storage.initialized) return;
            const rawList = GM_getValue(CONFIG.STORAGE_KEY, []);
            Storage.cache = new Set(rawList);
            Storage.initialized = true;
        },
        getBlacklist: () => { if (!Storage.initialized) Storage.init(); return Array.from(Storage.cache); },
        addCompany: (name) => {
            if (!name) return false;
            if (!Storage.initialized) Storage.init();
            const trimmedName = name.trim();
            if (!Storage.cache.has(trimmedName)) {
                Storage.cache.add(trimmedName);
                Storage.persist();
                return true;
            }
            return false;
        },
        removeCompany: (name) => {
            if (!Storage.initialized) Storage.init();
            if (Storage.cache.delete(name)) Storage.persist();
        },
        isBlocked: (name) => {
            if (!name) return false;
            if (!Storage.initialized) Storage.init();
            return Storage.cache.has(name.trim());
        },
        persist: () => { GM_setValue(CONFIG.STORAGE_KEY, Array.from(Storage.cache)); },
        importData: (jsonString) => {
            try {
                const list = JSON.parse(jsonString);
                if (Array.isArray(list)) {
                    let count = 0;
                    if (!Storage.initialized) Storage.init();
                    list.forEach(item => {
                        if (item && typeof item === 'string') {
                            const t = item.trim();
                            if (t && !Storage.cache.has(t)) { Storage.cache.add(t); count++; }
                        }
                    });
                    Storage.persist();
                    alert(`导入成功！新增 ${count} 条，共 ${Storage.cache.size} 条。`);
                    Core.refresh();
                } else { alert('格式错误：必须是 JSON 数组'); }
            } catch (e) { alert('解析失败'); console.error(e); }
        }
    };

    // --- 4. UI 模块 ---
    const UI = {
        injectStyles: () => {
            const styles = `
                .boss-action-bar { position: absolute; top: 0; right: 0; z-index: 999; display: none; border-bottom-left-radius: 8px; overflow: hidden; box-shadow: -2px 2px 8px rgba(0,0,0,0.15); background: white; }
                ${currentSiteConfig.cardSelectors.map(s => `${s}:hover .boss-action-bar`).join(', ')} { display: flex !important; }
                .job-card-body:hover .boss-action-bar { display: flex !important; }
                .boss-action-btn { padding: 6px 14px; font-size: 13px; cursor: pointer; font-weight: bold; color: white; display: flex; align-items: center; justify-content: center; }
                .boss-btn-block { background: #ff4d4f; }
                .boss-btn-block:hover { background: #d9363e; }
                .universal-blocked { display: none !important; }

                /* 悬浮球 */
                #universal-helper-fab { position: fixed; bottom: 100px; right: 30px; width: 48px; height: 48px; background: #4285f4; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: ${CONFIG.UI_Z_INDEX}; font-size: 22px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: 0.2s; user-select: none; }
                #universal-helper-fab:hover { transform: scale(1.1); }
                #universal-helper-fab.paused { background: #999; }

                /* 面板 */
                #universal-panel { position: fixed; bottom: 160px; right: 30px; width: 320px; max-height: 600px; background: white; border: 1px solid #ddd; box-shadow: 0 8px 30px rgba(0,0,0,0.15); z-index: ${CONFIG.UI_Z_INDEX}; border-radius: 12px; display: none; flex-direction: column; font-family: sans-serif; font-size: 14px; }
                .u-header { padding: 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; font-weight: bold; background: #f9f9f9; }
                .u-content { flex: 1; overflow-y: auto; padding: 0; }
                .u-section { padding: 16px; border-bottom: 8px solid #f5f5f5; text-align:center;}
                .u-data-btn { width: 48%; padding: 8px; font-size: 12px; cursor: pointer; border: 1px solid #ddd; background: #fff; border-radius: 4px; margin-top: 5px; }
                .u-data-btn:hover { background: #f0f0f0; }
                .u-list-header { padding: 10px 16px; background: #f5f5f5; color: #666; font-size: 12px;}
                .u-item { padding: 10px 16px; border-bottom: 1px solid #f1f3f4; display: flex; justify-content: space-between; }
                .u-remove { color: #ff4d4f; cursor: pointer; }

                /* 开关 */
                #u-toggle-pause { width: 100%; padding: 10px; margin-bottom: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; color: white; }
                .u-btn-running { background: #52c41a; }
                .u-btn-running:hover { background: #73d13d; }
                .u-btn-paused { background: #faad14; }
                .u-btn-paused:hover { background: #ffc53d; }

                /* 提示条 */
                #auto-load-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: #fff; padding: 10px 20px; border-radius: 30px; font-size: 13px; z-index: ${CONFIG.UI_Z_INDEX}; opacity: 0; transition: opacity 0.3s; cursor: pointer; font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.2); display: flex; align-items: center; gap: 8px; }
                #auto-load-toast.show { opacity: 1; }
                #auto-load-toast:hover { background: rgba(255, 77, 79, 0.9); }
                #auto-load-toast.danger { background: #f5222d; animation: pulse 1s infinite; } /* 危险红 */

                @keyframes pulse { 0% { transform: translateX(-50%) scale(1); } 50% { transform: translateX(-50%) scale(1.05); } 100% { transform: translateX(-50%) scale(1); } }

                .u-highlight { color: #4db8ff; font-weight: bold; }
                .u-toast-hint { font-size: 10px; color: #ccc; margin-left: 5px; border-left: 1px solid #666; padding-left: 8px; }

                .u-scroll-bait { width: 100%; height: 100px; opacity: 0; pointer-events: none; }
            `;
            if (typeof GM_addStyle !== 'undefined') GM_addStyle(styles);
            else {
                const s = document.createElement('style');
                s.innerText = styles;
                document.head.appendChild(s);
            }
        },
        init: () => {
            UI.createFab();
            UI.createPanel();
            UI.createAutoLoadToast();
        },
        createFab: () => {
            const fab = document.createElement('div');
            fab.id = 'universal-helper-fab';
            fab.innerText = '🛡️';
            fab.onclick = () => UI.togglePanel();
            document.body.appendChild(fab);
        },
        updateFabStatus: () => {
            const fab = document.getElementById('universal-helper-fab');
            if (State.isPaused) {
                fab.classList.add('paused');
                fab.innerText = '⏸️';
                fab.title = "已暂停加载";
            } else {
                fab.classList.remove('paused');
                fab.innerText = '🛡️';
                fab.title = "运行中";
            }
        },
        createAutoLoadToast: () => {
            const toast = document.createElement('div');
            toast.id = 'auto-load-toast';
            toast.title = "点击立即停止";
            toast.onclick = () => {
                // 如果正在倒计时刷新，取消刷新
                if (State.reloadTimer) {
                    clearTimeout(State.reloadTimer);
                    State.reloadTimer = null;
                    toast.classList.remove('danger');
                    UI.showToast("🛡️ 已取消自动刷新，脚本已暂停", 3000);
                    Core.togglePause(true);
                } else {
                    Core.togglePause(true);
                    UI.showToast("🛑 已紧急停止加载", 2000);
                }
            };
            document.body.appendChild(toast);
        },
        showToast: (html, duration = 2000, isDanger = false) => {
            const t = document.getElementById('auto-load-toast');
            if(t) {
                t.innerHTML = html;
                t.classList.add('show');
                if (isDanger) t.classList.add('danger');
                else t.classList.remove('danger');

                // 如果已经有定时器（非刷新定时器），清除它
                if (t.dataset.timer) clearTimeout(t.dataset.timer);

                // 只有非持久显示的Toast才自动消失
                if (duration > 0) {
                    t.dataset.timer = setTimeout(() => {
                        t.classList.remove('show');
                        t.classList.remove('danger');
                    }, duration);
                }
            }
        },
        hideToast: () => {
             const t = document.getElementById('auto-load-toast');
             if(t) {
                 t.classList.remove('show');
                 t.classList.remove('danger');
             }
        },
        createPanel: () => {
            const panel = document.createElement('div');
            panel.id = 'universal-panel';
            panel.innerHTML = `
                <div class="u-header">
                    <span>全能助手 v33.5</span>
                    <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">×</span>
                </div>
                <div class="u-content">
                    <div class="u-section">
                        <button id="u-toggle-pause" class="u-btn-running">🔄 自动加载：运行中</button>
                        <div style="display:flex; justify-content:space-between; margin-top:10px;">
                             <button id="u-btn-export" class="u-data-btn">📤 导出备份</button>
                             <button id="u-btn-import" class="u-data-btn">📥 导入数据</button>
                             <input type="file" id="u-file-input" style="display:none" accept=".json">
                        </div>
                    </div>
                    <div class="u-list-header">🚫 已屏蔽 (<span id="u-count">0</span>) - 最近50条</div>
                    <div id="u-list"></div>
                </div>`;
            document.body.appendChild(panel);

            document.getElementById('u-toggle-pause').onclick = () => Core.togglePause();
            document.getElementById('u-btn-export').onclick = () => {
                const data = Storage.getBlacklist();
                const blob = new Blob([JSON.stringify(data)], {type: "application/json"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `job_blacklist_${new Date().toISOString().slice(0,10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };
            document.getElementById('u-btn-import').onclick = () => { document.getElementById('u-file-input').click(); };
            document.getElementById('u-file-input').onchange = (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => {
                    Storage.importData(event.target.result);
                    e.target.value = '';
                };
                reader.readAsText(file);
            };
        },
        updatePanelButton: () => {
            const btn = document.getElementById('u-toggle-pause');
            if (!btn) return;
            if (State.isPaused) {
                btn.className = 'u-btn-paused';
                btn.innerText = '⏸️ 自动加载：已暂停';
            } else {
                btn.className = 'u-btn-running';
                btn.innerText = '🔄 自动加载：运行中';
            }
        },
        togglePanel: () => {
            const panel = document.getElementById('universal-panel');
            if (panel.style.display === 'flex') {
                panel.style.display = 'none';
            } else {
                panel.style.display = 'flex';
                UI.renderList();
                UI.updatePanelButton();
            }
        },
        renderList: () => {
            const list = Storage.getBlacklist();
            document.getElementById('u-count').innerText = list.length;
            const container = document.getElementById('u-list');
            container.innerHTML = '';
            [...list].slice(-50).reverse().forEach(name => {
                const div = document.createElement('div');
                div.className = 'u-item';
                div.innerHTML = `<span>${name}</span><span class="u-remove">移除</span>`;
                div.querySelector('.u-remove').onclick = () => {
                    Storage.removeCompany(name);
                    UI.renderList();
                    Core.refresh();
                };
                container.appendChild(div);
            });
        }
    };

    // --- 5. 核心加载模块 ---
    const Loader = {
        triggerTrueReflow: () => {
            document.body.style.borderBottom = '1px solid transparent';
            void document.body.offsetHeight;
            document.body.style.borderBottom = 'none';
        },
        triggerSmartScroll: () => {
            const targets = [
                document.documentElement,
                document.body,
                document.querySelector(currentSiteConfig.scrollContainerSelector)
            ];
            targets.forEach(target => {
                if (!target) return;
                const isWindow = target === document.documentElement || target === document.body;
                const currentScroll = isWindow ? window.scrollY : target.scrollTop;
                const maxScroll = (isWindow ? document.body.scrollHeight : target.scrollHeight) - (isWindow ? window.innerHeight : target.clientHeight);

                if(isWindow) window.scrollTo(0, maxScroll - 50); else target.scrollTop = maxScroll - 50;

                setTimeout(() => {
                    if(isWindow) window.scrollTo(0, maxScroll + 500); else target.scrollTop = maxScroll + 500;
                    const event = new Event('scroll', { bubbles: true });
                    (isWindow ? window : target).dispatchEvent(event);
                }, 150);
            });
        },
        checkAndLoad: () => {
            if (currentSiteConfig.key !== 'boss') return;
            if (State.isPaused) return;
            if (State.isAutoLoading) return;
            // 如果正在准备刷新，也别加载了
            if (State.reloadTimer) return;

            const allCards = document.querySelectorAll(currentSiteConfig.cardSelectors.join(','));
            if (allCards.length === 0) return;

            if (allCards.length === State.lastCardCount) {
                State.retryCount++;
            } else {
                const newItems = allCards.length - State.lastCardCount;
                State.retryCount = 0;
                State.lastCardCount = allCards.length;
                State.hasReachedLimit = false;
            }

            let visibleCount = 0;
            allCards.forEach(card => {
                if (!card.classList.contains('universal-blocked') && card.offsetParent !== null) {
                    visibleCount++;
                }
            });

            // --- 僵死检测核心逻辑 ---
            // 如果全被屏蔽(visibleCount=0) 且 尝试次数超过了常规限制
            if (visibleCount === 0 && State.retryCount > CONFIG.MAX_RETRY) {
                 // 检查是否达到了“刷新阈值”
                 if (State.retryCount >= CONFIG.AUTO_REFRESH_LIMIT) {
                     console.log('触发僵死保护，准备刷新页面...');
                     UI.showToast(`⚠️ 页面似乎卡死，3秒后自动刷新... <span class="u-toast-hint">点击取消</span>`, 0, true);

                     // 设置3秒倒计时刷新
                     State.reloadTimer = setTimeout(() => {
                         location.reload();
                     }, 3000);
                     return;
                 }
                 // 还没到刷新阈值，重置flag继续尝试（不死鸟逻辑）
                 State.hasReachedLimit = false;
            }

            if (State.retryCount > CONFIG.MAX_RETRY && visibleCount > 0) {
                if (!State.hasReachedLimit) {
                    State.hasReachedLimit = true;
                    UI.showToast(`已到底部，停止自动加载`, 3000);
                }
                return;
            }

            if (visibleCount < CONFIG.MIN_VISIBLE_ITEMS) {
                State.isAutoLoading = true;

                if (visibleCount === 0) {
                    UI.showToast(`🗑️ 全屏垃圾清理中... <span class="u-highlight">(${State.retryCount}/${CONFIG.AUTO_REFRESH_LIMIT})</span>`, 5000);
                }

                let bait = document.getElementById('u-scroll-bait');
                if (!bait) {
                    bait = document.createElement('div');
                    bait.id = 'u-scroll-bait';
                    bait.className = 'u-scroll-bait';
                    const listContainer = document.querySelector(currentSiteConfig.listContainerSelector);
                    if (listContainer) listContainer.appendChild(bait);
                    else document.body.appendChild(bait);
                }

                setTimeout(() => {
                    Loader.triggerTrueReflow();
                    Loader.triggerSmartScroll();
                    setTimeout(() => {
                        State.isAutoLoading = false;
                        if (visibleCount > 0) UI.hideToast();
                    }, 1200);
                }, 100);
            }
        }
    };

    // --- 6. 核心逻辑 ---
    const Core = {
        togglePause: (forcePause = false) => {
            if (forcePause) {
                State.isPaused = true;
            } else {
                State.isPaused = !State.isPaused;
            }
            UI.updateFabStatus();
            UI.updatePanelButton();
            if (State.isPaused) {
                State.isAutoLoading = false;
                UI.showToast("⏸️ 自动加载已暂停", 2000);
            } else {
                UI.showToast("▶️ 自动加载已恢复", 2000);
                Loader.checkAndLoad();
            }
        },
        getCompanyName: (card) => {
            let companyName = '';
            for (let s of currentSiteConfig.nameSelectors) {
                const el = card.querySelector(s);
                if (el) { companyName = (el.innerText || '').trim(); break; }
            }
            return companyName;
        },
        processCard: (card) => {
            if (card.dataset.uProcessed === 'true') {
                Core.updateVisibility(card);
                return;
            }
            const companyName = Core.getCompanyName(card);
            if (!companyName) return;

            card.dataset.companyName = companyName;
            Core.injectActionBar(card, companyName);
            Core.updateVisibility(card);
            card.dataset.uProcessed = 'true';
        },
        injectActionBar: (card, name) => {
            if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
            if (card.querySelector('.boss-action-bar')) return;

            const bar = document.createElement('div');
            bar.className = 'boss-action-bar';
            const block = document.createElement('div');
            block.className = 'boss-action-btn boss-btn-block';
            block.innerText = '🚫 屏蔽';
            block.onclick = (e) => {
                e.stopPropagation(); e.preventDefault();
                if (confirm(`屏蔽【${name}】?`)) {
                    Storage.addCompany(name);
                    Core.refresh();
                }
            };
            bar.appendChild(block);
            card.appendChild(bar);
        },
        updateVisibility: (card) => {
            const isBlocked = Storage.isBlocked(card.dataset.companyName);
            if (isBlocked) {
                if (!card.classList.contains('universal-blocked')) {
                    card.classList.add('universal-blocked');
                    State.blockedCountSinceLoad++;
                }
            } else {
                card.classList.remove('universal-blocked');
            }
        },
        refresh: () => {
            document.querySelectorAll(currentSiteConfig.cardSelectors.join(',')).forEach(c => Core.updateVisibility(c));
            if (currentSiteConfig.key === 'boss') {
                State.hasReachedLimit = false;
                State.retryCount = 0;
                Loader.checkAndLoad();
            }
        },
        initScanner: () => {
            Storage.init();
            const run = () => {
                const selector = currentSiteConfig.cardSelectors.join(',');
                document.querySelectorAll(selector).forEach(c => Core.processCard(c));
            };

            const observer = new MutationObserver((mutations) => {
                let shouldRun = false;
                for(let m of mutations) {
                    if (m.addedNodes.length > 0) { shouldRun = true; break; }
                }
                if(shouldRun) run();
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setInterval(run, CONFIG.REFRESH_INTERVAL_MS);

            if (currentSiteConfig.key === 'boss') {
                setInterval(Loader.checkAndLoad, CONFIG.CHECK_LOAD_INTERVAL);
            }
            run();
        }
    };

    const App = {
        init: () => {
            console.log(`[JobHelper v33.5] Loaded. Site: ${currentSiteConfig.key}`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
        }
    };

    App.init();
})();