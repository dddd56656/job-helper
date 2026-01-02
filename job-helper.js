// ==UserScript==
// @name        招聘网站全能助手 (v33.2 完美双模版)
// @namespace   http://tampermonkey.net/
// @version     33.2
// @description 全能招聘助手：为Boss直聘提供“自动加载+智能限频”功能，为前程无忧(51job)提供“屏蔽”功能。两套逻辑隔离，互不干扰。
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
        REFRESH_INTERVAL_MS: 500,  // 屏蔽扫描频率
        CHECK_LOAD_INTERVAL: 1500, // Boss自动加载频率
        MIN_VISIBLE_ITEMS: 3,      // 屏幕职位少于3个时触发加载
        MAX_RETRY: 3,              // Boss最大连续重试次数
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
            // 51job 的卡片选择器
            cardSelectors: ['.joblist-item', '.j_joblist .e', '.el', '.job-list-item'],
            nameSelectors: ['.cname a', '.cname', '.t2 a', '.er a', '.company_name'],
            key: '51job'
        }
    };

    // 自动识别当前是哪个网站
    const currentSiteConfig = location.host.includes('zhipin.com') ? SITE_CONFIGS.boss : SITE_CONFIGS.job51;

    // --- 2. 状态管理 ---
    const State = {
        isAutoLoading: false,
        retryCount: 0,        // 当前重试次数
        lastCardCount: 0,     // 上一次检查时的卡片总数
        hasReachedLimit: false // 是否已达到重试上限
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
                
                /* 彻底隐藏被屏蔽的卡片 */
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

                /* Boss直聘自动加载提示 */
                #auto-load-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); color: #fff; padding: 8px 16px; border-radius: 20px; font-size: 12px; z-index: ${CONFIG.UI_Z_INDEX}; opacity: 0; transition: opacity 0.3s; pointer-events: none; }
                #auto-load-toast.show { opacity: 1; }

                /* Boss直聘底部物理诱饵 */
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
                    <span>全能助手 v33.2</span>
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

    // --- 5. 核心加载模块 (仅限 Boss) ---
    const Loader = {
        // 触发重排，强制浏览器重新计算布局
        triggerTrueReflow: () => {
            document.body.style.borderBottom = '1px solid transparent';
            void document.body.offsetHeight;
            setTimeout(() => {
                document.body.style.borderBottom = 'none';
                window.dispatchEvent(new Event('resize'));
            }, 50);
        },

        // 暴力滚动逻辑
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

                // 先往上滚一点
                const upPos = scrollHeight - 200;
                if (isWindow) target.scrollTo(0, upPos); else target.scrollTop = upPos;

                // 再迅速滚到底，并触发事件
                setTimeout(() => {
                    if (isWindow) target.scrollTo(0, scrollHeight); else target.scrollTop = scrollHeight;
                    const event = new Event('scroll');
                    (isWindow ? window : target).dispatchEvent(event);
                }, 100);
            });
        },

        // 主检查函数
        checkAndLoad: () => {
            // 【安全门】如果不是 Boss直聘，绝对不执行后续逻辑
            if (currentSiteConfig.key !== 'boss') return;

            if (State.isAutoLoading || State.hasReachedLimit) return;

            const allCards = document.querySelectorAll(currentSiteConfig.cardSelectors.join(','));
            if (allCards.length === 0) return;

            // --- 智能限频逻辑 ---
            if (allCards.length === State.lastCardCount) {
                State.retryCount++;
                if (State.retryCount > CONFIG.MAX_RETRY) {
                     State.hasReachedLimit = true;
                     UI.showToast(`已尝试${CONFIG.MAX_RETRY}次加载未果，停止加载。`, 3000);
                     return;
                }
            } else {
                // 如果卡片数量增加了，重置计数器
                State.retryCount = 0;
                State.lastCardCount = allCards.length;
                State.hasReachedLimit = false;
            }

            // 计算屏幕上可见的非屏蔽卡片数量
            let visibleCount = 0;
            allCards.forEach(card => {
                if (!card.classList.contains('universal-blocked') && card.offsetParent !== null) {
                    visibleCount++;
                }
            });

            // 只有当可见卡片太少时，才触发加载
            if (visibleCount < CONFIG.MIN_VISIBLE_ITEMS) {
                State.isAutoLoading = true;
                UI.showToast(`正在强制加载 (${State.retryCount}/${CONFIG.MAX_RETRY})...`, 4000);

                // 插入物理诱饵，撑开页面高度
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

                // 组合拳：重排 -> 滚动 -> 清理
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
            // 确保父元素有定位属性，以便按钮绝对定位
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
                    Core.refresh(); // 触发刷新
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
            // 1. 刷新所有卡片的显示/隐藏状态
            document.querySelectorAll(currentSiteConfig.cardSelectors.join(',')).forEach(c => Core.updateVisibility(c));
            
            // 2. 仅在 Boss直聘 上触发加载逻辑
            if (currentSiteConfig.key === 'boss') {
                // 屏蔽了卡片后，屏幕空了，需要重置状态并尝试加载新数据
                State.hasReachedLimit = false; 
                State.retryCount = 0;
                Loader.checkAndLoad();
            }
        },
        initScanner: () => {
            Storage.init();
            
            // 扫描器：负责处理新出现的卡片
            const run = () => {
                const selector = currentSiteConfig.cardSelectors.join(',');
                document.querySelectorAll(selector).forEach(c => Core.processCard(c));
            };

            // DOM 监听：监听网页内容变化
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

            // 兜底定时器：定期扫描，防止漏网之鱼
            setInterval(run, CONFIG.REFRESH_INTERVAL_MS);

            // 【关键修改】仅 Boss直聘 启动自动加载定时器
            if (currentSiteConfig.key === 'boss') {
                setInterval(Loader.checkAndLoad, CONFIG.CHECK_LOAD_INTERVAL);
            }

            run();
        }
    };

    // --- 7. 初始化 ---
    const App = {
        init: () => {
            console.log(`[JobHelper v33.2] Loaded. Site: ${currentSiteConfig.key}`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
        }
    };

    App.init();
})();