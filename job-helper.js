// ==UserScript==
// @name        招聘网站全能助手 (v33.0 智能限频版)
// @namespace   http://tampermonkey.net/
// @version     33.0
// @description 修复Boss直聘加载问题。采用“组合拳”触发加载，但限制最多尝试3次，防止到底后无限空转。
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
        CHECK_LOAD_INTERVAL: 1500, // 每次尝试加载的间隔
        MIN_VISIBLE_ITEMS: 3,      // 屏幕上少于3个职位时触发
        MAX_RETRY: 3,              // 【核心修改】最大连续重试次数设为 3次
        DEFAULT_GREETING: '你好，我对这个职位很感兴趣，希望能有机会聊聊。'
    };

    const SITE_CONFIGS = {
        boss: {
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'],
            nameSelectors: ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'],
            // 列表的直接父容器 (用于插入诱饵)
            listContainerSelector: '.job-list-container, .rec-job-list, .job-list-box',
            // 潜在的滚动容器
            scrollContainerSelector: '.page-jobs-main',
            key: 'boss'
        },
        job51: {
            cardSelectors: ['.joblist-item', '.j_joblist .e', '.el', '.job-list-item'],
            nameSelectors: ['.cname a', '.cname', '.t2 a', '.er a', '.company_name'],
            chatBtnSelectors: [],
            key: '51job'
        }
    };

    const currentSiteConfig = location.host.includes('zhipin.com') ? SITE_CONFIGS.boss : SITE_CONFIGS.job51;

    // --- 2. 状态管理 ---
    const State = {
        isBatchRunning: false,
        stopBatchSignal: false,
        isAutoLoading: false,
        retryCount: 0,        // 当前重试次数
        lastCardCount: 0,     // 上一次检查时的卡片总数
        hasReachedLimit: false // 是否已达到重试上限
    };

    // --- 3. 存储模块 ---
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
                .boss-btn-apply { background: #00bebd; border-right: 1px solid rgba(255,255,255,0.2); }
                .boss-btn-apply:hover { background: #00a5a4; }
                .boss-btn-block { background: #ff4d4f; }
                .boss-btn-block:hover { background: #d9363e; }
                .boss-applied { background-color: #f0f9eb !important; opacity: 0.8; border-left: 4px solid #67c23a; }

                /* 彻底隐藏 */
                .universal-blocked { display: none !important; }

                #universal-helper-fab { position: fixed; bottom: 100px; right: 30px; width: 48px; height: 48px; background: #4285f4; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: ${CONFIG.UI_Z_INDEX}; font-size: 22px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: 0.2s; }
                #universal-helper-fab:hover { transform: scale(1.1); }
                #universal-panel { position: fixed; bottom: 160px; right: 30px; width: 320px; max-height: 600px; background: white; border: 1px solid #ddd; box-shadow: 0 8px 30px rgba(0,0,0,0.15); z-index: ${CONFIG.UI_Z_INDEX}; border-radius: 12px; display: none; flex-direction: column; font-family: sans-serif; font-size: 14px; }
                .u-header { padding: 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; font-weight: bold; background: #f9f9f9; }
                .u-content { flex: 1; overflow-y: auto; padding: 0; }
                .u-section { padding: 16px; border-bottom: 8px solid #f5f5f5; text-align:center;}
                .u-data-btn { width: 48%; padding: 8px; font-size: 12px; cursor: pointer; border: 1px solid #ddd; background: #fff; border-radius: 4px; margin-top: 5px; }
                .u-data-btn:hover { background: #f0f0f0; }
                .u-list-header { padding: 10px 16px; background: #f5f5f5; color: #666; font-size: 12px;}
                .u-item { padding: 10px 16px; border-bottom: 1px solid #f1f3f4; display: flex; justify-content: space-between; }
                .u-remove { color: #ff4d4f; cursor: pointer; }

                #auto-load-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 12px; z-index: ${CONFIG.UI_Z_INDEX}; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
                #auto-load-toast.show { opacity: 1; }

                /* 底部诱饵样式 */
                .u-scroll-bait {
                    width: 100%;
                    height: 1000px; /* 撑开高度 */
                    background: transparent;
                    display: flex;
                    align-items: flex-end;
                    justify-content: center;
                    padding-bottom: 20px;
                    color: #999;
                    font-size: 12px;
                }
            `;
            if (typeof GM_addStyle !== 'undefined') GM_addStyle(styles);
            else {
                const s = document.createElement('style');
                s.innerText = styles;
                document.head.appendChild(s);
            }
            document.body.setAttribute('data-site', currentSiteConfig.key);
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
        createAutoLoadToast: () => {
            const toast = document.createElement('div');
            toast.id = 'auto-load-toast';
            toast.innerText = '';
            document.body.appendChild(toast);
        },
        showToast: (text, duration = 2000) => {
            const t = document.getElementById('auto-load-toast');
            if(t) {
                t.innerText = text;
                t.classList.add('show');
                setTimeout(() => t.classList.remove('show'), duration);
            }
        },
        hideToast: () => {
             const t = document.getElementById('auto-load-toast');
             if(t) t.classList.remove('show');
        },
        createPanel: () => {
            const panel = document.createElement('div');
            panel.id = 'universal-panel';
            panel.innerHTML = `
                <div class="u-header">
                    <span>全能助手 v33.0</span>
                    <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">×</span>
                </div>
                <div class="u-content">
                    <div class="u-section" style="border-bottom: 8px solid #f5f5f5;">
                        <div style="display:flex; justify-content:space-between;">
                             <button id="u-btn-export" class="u-data-btn">📤 导出备份</button>
                             <button id="u-btn-import" class="u-data-btn">📥 导入数据</button>
                             <input type="file" id="u-file-input" style="display:none" accept=".json">
                        </div>
                         <div style="font-size:12px;color:#999;margin-top:5px">支持跨电脑迁移数据</div>
                    </div>
                    <div class="u-list-header">🚫 已屏蔽 (<span id="u-count">0</span>) - 最近50条</div>
                    <div id="u-list"></div>
                </div>`;
            document.body.appendChild(panel);

            document.getElementById('u-btn-export').onclick = () => {
                const data = Storage.getBlacklist();
                const blob = new Blob([JSON.stringify(data)], {type: "application/json"});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `job_helper_blacklist_${new Date().toISOString().slice(0,10)}.json`;
                a.click();
                URL.revokeObjectURL(url);
            };

            document.getElementById('u-btn-import').onclick = () => {
                document.getElementById('u-file-input').click();
            };
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
        togglePanel: () => {
            const panel = document.getElementById('universal-panel');
            if (panel.style.display === 'flex') {
                panel.style.display = 'none';
            } else {
                panel.style.display = 'flex';
                UI.renderList();
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
            setTimeout(() => {
                document.body.style.borderBottom = 'none';
                window.dispatchEvent(new Event('resize'));
            }, 50);
        },

        triggerGlobalScroll: () => {
            const targets = [
                window,
                document.documentElement,
                document.body,
                document.querySelector(currentSiteConfig.scrollContainerSelector)
            ];

            targets.forEach(target => {
                if (!target) return;
                const isWindow = target === window;
                const scrollHeight = isWindow ? document.documentElement.scrollHeight : target.scrollHeight;

                const upPos = scrollHeight - 200;
                if (isWindow) target.scrollTo(0, upPos); else target.scrollTop = upPos;

                setTimeout(() => {
                    if (isWindow) target.scrollTo(0, scrollHeight); else target.scrollTop = scrollHeight;
                    const event = new Event('scroll');
                    (isWindow ? window : target).dispatchEvent(event);
                }, 100);
            });
        },

        checkAndLoad: () => {
            if (State.isAutoLoading || State.hasReachedLimit) return;

            const allCards = document.querySelectorAll(currentSiteConfig.cardSelectors.join(','));
            if (allCards.length === 0) return;

            // --- 智能限频逻辑 ---
            if (allCards.length === State.lastCardCount) {
                State.retryCount++;
                // 如果超过3次，且职位数没变，说明到底了，或者加载不出，停止尝试
                if (State.retryCount > CONFIG.MAX_RETRY) {
                     State.hasReachedLimit = true;
                     UI.showToast(`已尝试${CONFIG.MAX_RETRY}次加载未果，自动停止。`, 3000);
                     return;
                }
            } else {
                // 如果职位数增加了，说明加载成功，重置计数器
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

            if (visibleCount < CONFIG.MIN_VISIBLE_ITEMS) {
                State.isAutoLoading = true;
                // 显示当前尝试次数
                UI.showToast(`正在强制加载 (${State.retryCount}/${CONFIG.MAX_RETRY})...`, 4000);

                let bait = document.getElementById('u-scroll-bait');
                if (!bait) {
                    bait = document.createElement('div');
                    bait.id = 'u-scroll-bait';
                    bait.className = 'u-scroll-bait';
                    bait.innerText = '正在用力加载更多职位...';

                    const listContainer = document.querySelector(currentSiteConfig.listContainerSelector);
                    if (listContainer) listContainer.appendChild(bait);
                    else document.body.appendChild(bait);
                }

                setTimeout(() => {
                    Loader.triggerTrueReflow();
                    setTimeout(() => {
                        Loader.triggerGlobalScroll();
                    }, 200);

                    setTimeout(() => {
                        if(bait) bait.remove();
                        State.isAutoLoading = false;
                        UI.hideToast();
                    }, 1500);
                }, 100);
            }
        }
    };

    // --- 6. 核心逻辑 ---
    const Core = {
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
            if (Storage.isBlocked(card.dataset.companyName)) {
                card.classList.add('universal-blocked');
            } else {
                card.classList.remove('universal-blocked');
            }
        },
        refresh: () => {
            document.querySelectorAll(currentSiteConfig.cardSelectors.join(',')).forEach(c => Core.updateVisibility(c));
            // 每次刷新完（例如刚屏蔽了一个），重置状态，允许尝试加载
            State.hasReachedLimit = false;
            State.retryCount = 0;
            Loader.checkAndLoad();
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
                    if (m.addedNodes.length > 0) {
                        shouldRun = true;
                        break;
                    }
                }
                if(shouldRun) run();
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setInterval(run, CONFIG.REFRESH_INTERVAL_MS);
            setInterval(Loader.checkAndLoad, CONFIG.CHECK_LOAD_INTERVAL);

            run();
        }
    };

    // --- 7. 初始化 ---
    const App = {
        init: () => {
            console.log(`[BossHelper v33.0] Loaded (Smart Limit: 3 Retries)`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
        }
    };

    App.init();
})();