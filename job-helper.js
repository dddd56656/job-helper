// ==UserScript==
// @name        招聘网站全能助手 (v33.3 不死鸟修复版)
// @namespace   http://tampermonkey.net/
// @version     33.3
// @description 全能招聘助手：修复Boss直聘在强屏蔽模式下“死锁”无法加载新职位的问题，增加“不死鸟”逻辑。
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

    // --- 1. 配置参数 (专家调整版) ---
    const CONFIG = {
        STORAGE_KEY: 'universal_job_blacklist',
        UI_Z_INDEX: 2147483647,
        REFRESH_INTERVAL_MS: 500,  // 屏蔽扫描频率
        CHECK_LOAD_INTERVAL: 1200, // 加快检查频率 (原1500)
        MIN_VISIBLE_ITEMS: 4,      // 屏幕可见职位少于4个时触发加载
        MAX_RETRY: 10,             // 大幅提升重试容错 (原3)
    };

    // --- 站点特征配置 ---
    const SITE_CONFIGS = {
        boss: {
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'],
            nameSelectors: ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'],
            listContainerSelector: '.job-list-container, .rec-job-list, .job-list-box',
            scrollContainerSelector: '.page-jobs-main', // Boss主要滚动区域
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
        retryCount: 0,
        lastCardCount: 0,
        hasReachedLimit: false,
        blockedCountSinceLoad: 0 // 统计本轮自动跳过了多少垃圾
    };

    // --- 3. 存储模块 (保持原样) ---
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

    // --- 4. UI 模块 (增加状态显示) ---
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

                /* 悬浮球 & 面板 */
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

                /* 优化 Toast 样式 */
                #auto-load-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.8); color: #fff; padding: 10px 20px; border-radius: 30px; font-size: 13px; z-index: ${CONFIG.UI_Z_INDEX}; opacity: 0; transition: opacity 0.3s; pointer-events: none; font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
                #auto-load-toast.show { opacity: 1; }
                .u-highlight { color: #4db8ff; font-weight: bold; }

                /* 物理诱饵 - 隐形但在 */
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
        createAutoLoadToast: () => {
            const toast = document.createElement('div');
            toast.id = 'auto-load-toast';
            toast.innerText = '';
            document.body.appendChild(toast);
        },
        showToast: (text, duration = 2000) => {
            const t = document.getElementById('auto-load-toast');
            if(t) {
                t.innerHTML = text; // 支持HTML
                t.classList.add('show');
                // 清除之前的定时器，防止闪烁
                if (t.dataset.timer) clearTimeout(t.dataset.timer);
                t.dataset.timer = setTimeout(() => t.classList.remove('show'), duration);
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
                    <span>全能助手 v33.3</span>
                    <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">×</span>
                </div>
                <div class="u-content">
                    <div class="u-section">
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
                a.download = `job_blacklist_${new Date().toISOString().slice(0,10)}.json`;
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

    // --- 5. 核心加载模块 (Google Expert Fix) ---
    const Loader = {
        // 触发重排
        triggerTrueReflow: () => {
            document.body.style.borderBottom = '1px solid transparent';
            void document.body.offsetHeight; // 强制计算
            document.body.style.borderBottom = 'none';
        },

        // 优化后的滚动逻辑：模拟“拉到底部”的操作
        triggerSmartScroll: () => {
            const targets = [
                document.documentElement,
                document.body,
                document.querySelector(currentSiteConfig.scrollContainerSelector)
            ];

            targets.forEach(target => {
                if (!target) return;
                const isWindow = target === document.documentElement || target === document.body;

                // 获取当前滚动高度
                const currentScroll = isWindow ? window.scrollY : target.scrollTop;
                const maxScroll = (isWindow ? document.body.scrollHeight : target.scrollHeight) - (isWindow ? window.innerHeight : target.clientHeight);

                // 只有当还没到底部太远时，才执行操作
                // 1. 先微向上一点，打破“静止”状态
                if(isWindow) window.scrollTo(0, maxScroll - 50); else target.scrollTop = maxScroll - 50;

                // 2. 延迟后猛力冲到底
                setTimeout(() => {
                    if(isWindow) window.scrollTo(0, maxScroll + 500); else target.scrollTop = maxScroll + 500;

                    // 3. 手动派发事件，欺骗React/Vue框架
                    const event = new Event('scroll', { bubbles: true });
                    (isWindow ? window : target).dispatchEvent(event);
                }, 150);
            });
        },

        // 主检查函数
        checkAndLoad: () => {
            if (currentSiteConfig.key !== 'boss') return;

            // 如果正在加载中，跳过
            if (State.isAutoLoading) return;

            const allCards = document.querySelectorAll(currentSiteConfig.cardSelectors.join(','));
            if (allCards.length === 0) return;

            // --- 智能限频与死锁解除 ---
            if (allCards.length === State.lastCardCount) {
                State.retryCount++;
            } else {
                // 如果卡片增加了，重置所有计数器
                const newItems = allCards.length - State.lastCardCount;
                State.retryCount = 0;
                State.lastCardCount = allCards.length;
                State.hasReachedLimit = false;
                // UI.showToast(`已加载 ${newItems} 个新职位`, 1500);
            }

            // 计算可见数量
            let visibleCount = 0;
            allCards.forEach(card => {
                if (!card.classList.contains('universal-blocked') && card.offsetParent !== null) {
                    visibleCount++;
                }
            });

            // 【不死鸟逻辑】:
            // 如果屏幕上全是屏蔽卡片(visibleCount == 0)，无论retryCount是多少，必须强制重置！
            // 否则用户面对的就是白屏，且脚本已停止工作。
            if (visibleCount === 0 && State.hasReachedLimit) {
                console.log('[JobHelper] 全屏屏蔽，强制复活加载器...');
                State.hasReachedLimit = false;
                State.retryCount = 0; // 重置重试次数
            }

            // 检查是否达到重试上限 (仅在有可见内容时生效)
            if (State.retryCount > CONFIG.MAX_RETRY) {
                if (!State.hasReachedLimit) {
                    State.hasReachedLimit = true;
                    UI.showToast(`已到底部或网络卡顿，停止自动加载`, 3000);
                }
                return;
            }

            // 触发加载条件
            if (visibleCount < CONFIG.MIN_VISIBLE_ITEMS) {
                State.isAutoLoading = true;

                // 动态提示：如果是由于屏蔽导致的加载，提示用户
                if (visibleCount === 0) {
                    UI.showToast(`🗑️ 当前页全被屏蔽，正在自动翻页... <span class="u-highlight">(${State.retryCount + 1})</span>`, 9000); // 长时间显示直到加载成功
                } else {
                    // UI.showToast(`正在加载更多...`, 1000);
                }

                // 插入物理诱饵
                let bait = document.getElementById('u-scroll-bait');
                if (!bait) {
                    bait = document.createElement('div');
                    bait.id = 'u-scroll-bait';
                    bait.className = 'u-scroll-bait';
                    const listContainer = document.querySelector(currentSiteConfig.listContainerSelector);
                    if (listContainer) listContainer.appendChild(bait);
                    else document.body.appendChild(bait);
                }

                // 执行滚动
                setTimeout(() => {
                    Loader.triggerTrueReflow();
                    Loader.triggerSmartScroll();

                    // 1.2秒后解除锁定，允许下一次检查
                    setTimeout(() => {
                        State.isAutoLoading = false;
                        if (visibleCount > 0) UI.hideToast(); // 如果有内容了就隐藏提示
                    }, 1200);
                }, 100);
            }
        }
    };

    // --- 6. 核心逻辑 (业务层) ---
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

            // 仅 Boss 直聘启动自动加载
            if (currentSiteConfig.key === 'boss') {
                console.log('[JobHelper] Boss直聘自动加载模块已启动');
                setInterval(Loader.checkAndLoad, CONFIG.CHECK_LOAD_INTERVAL);
            }
            run();
        }
    };

    // --- 7. 初始化 ---
    const App = {
        init: () => {
            console.log(`[JobHelper v33.3] Loaded. Site: ${currentSiteConfig.key}`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
        }
    };

    App.init();
})();