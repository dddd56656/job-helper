// ==UserScript==
// @name        招聘网站全能助手 (v24.0 企业级性能版)
// @namespace   http://tampermonkey.net/
// @version     24.0
// @description 支持10万+级黑名单依然丝滑流畅。引入 Set 哈希算法与内存缓存机制，保留“弹窗杀手”与“自动投递”功能。
// @author      Gemini (Modified by Google CTO Persona)
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

    // --- 1. Configuration ---
    const CONFIG = {
        STORAGE_KEY: 'universal_job_blacklist',
        UI_Z_INDEX: 2147483647,
        REFRESH_INTERVAL_MS: 1000,
        BATCH_DELAY_MIN: 2000,
        BATCH_DELAY_MAX: 4000,
        DEFAULT_GREETING: '你好，我对这个职位很感兴趣，希望能有机会聊聊。',
        DETAIL_LOAD_TIMEOUT: 3000
    };

    const SITE_CONFIGS = {
        boss: {
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'],
            nameSelectors: ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'],
            chatBtnSelectors: ['.start-chat-btn', '.btn-startchat'],
            detailPanelSelector: '.job-detail-container, .job-detail-box',
            detailSubmitSelector: '.op-btn-chat, .btn-sure, .btn-startchat, .op-btn-chat',
            sentDialogSelector: '.greet-boss-dialog',
            sentDialogCloseSelector: '.cancel-btn, .close',
            dialogSelector: '.dialog-container',
            dialogInputSelector: 'textarea',
            dialogSubmitSelector: '.btn-sure, .btn-startchat',
            dialogStaySelector: '.cancel-btn, .btn-cancel, .btn-close, .close',
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

    // --- 2. State Management ---
    const State = {
        isBatchRunning: false,
        stopBatchSignal: false,
        processedCount: 0,
        totalCount: 0
    };

    // --- 3. Storage Module (High Performance Refactor) ---
    // 核心重构：引入 Set + 内存缓存，解决 10w+ 数据卡顿问题
    const Storage = {
        // 内存缓存，使用 Set 实现 O(1) 复杂度查找
        cache: new Set(),
        initialized: false,

        // 初始化：从本地存储加载数据到内存 Set
        init: () => {
            if (Storage.initialized) return;
            console.time('LoadBlacklist');
            const rawList = GM_getValue(CONFIG.STORAGE_KEY, []);
            // 将数组转换为 Set，去除重复并优化查询
            Storage.cache = new Set(rawList);
            Storage.initialized = true;
            console.timeEnd('LoadBlacklist');
            console.log(`[BossHelper] 黑名单已加载: ${Storage.cache.size} 条数据`);
        },

        // 获取列表（将 Set 转回 Array 供 UI 渲染，注意：大数据量渲染 UI 会慢，但屏蔽检查依然快）
        getBlacklist: () => {
            if (!Storage.initialized) Storage.init();
            return Array.from(Storage.cache);
        },

        // O(1) 极速添加
        addCompany: (name) => {
            if (!name) return false;
            if (!Storage.initialized) Storage.init();
            const trimmedName = name.trim();
            if (!Storage.cache.has(trimmedName)) {
                Storage.cache.add(trimmedName);
                Storage.persist(); // 异步持久化
                return true;
            }
            return false;
        },

        // O(1) 极速删除
        removeCompany: (name) => {
            if (!Storage.initialized) Storage.init();
            if (Storage.cache.delete(name)) {
                Storage.persist();
            }
        },

        // O(1) 极速查询：这是最关键的性能提升点
        isBlocked: (name) => {
            if (!name) return false;
            if (!Storage.initialized) Storage.init();
            return Storage.cache.has(name.trim());
        },

        // 持久化：将内存 Set 写回硬盘
        persist: () => {
            // 在数据量极大时，这里是唯一的耗时操作，但只有在添加/删除时触发，不影响滚动浏览
            GM_setValue(CONFIG.STORAGE_KEY, Array.from(Storage.cache));
        }
    };

    // --- 4. UI Module ---
    const UI = {
        injectStyles: () => {
            const styles = `
                /* Action Bar */
                .boss-action-bar {
                    position: absolute; top: 0; right: 0; z-index: 999;
                    display: none; border-bottom-left-radius: 8px; overflow: hidden;
                    box-shadow: -2px 2px 8px rgba(0,0,0,0.15); background: white;
                }
                ${currentSiteConfig.cardSelectors.map(s => `${s}:hover .boss-action-bar`).join(', ')} { display: flex !important; }
                .job-card-body:hover .boss-action-bar { display: flex !important; }

                .boss-action-btn {
                    padding: 6px 14px; font-size: 13px; cursor: pointer;
                    font-weight: bold; font-family: sans-serif; color: white;
                    display: flex; align-items: center; justify-content: center;
                }
                .boss-btn-apply { background: #00bebd; border-right: 1px solid rgba(255,255,255,0.2); }
                .boss-btn-apply:hover { background: #00a5a4; }
                .boss-btn-block { background: #ff4d4f; }
                .boss-btn-block:hover { background: #d9363e; }

                /* States */
                .boss-applied { background-color: #f0f9eb !important; opacity: 0.8; border-left: 4px solid #67c23a; }
                .boss-btn-applied { background: #67c23a !important; cursor: default; pointer-events: none; }
                .universal-blocked { display: none !important; }

                /* FAB */
                #universal-helper-fab {
                    position: fixed; bottom: 100px; right: 30px; width: 48px; height: 48px;
                    background: #4285f4; color: white; border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; z-index: ${CONFIG.UI_Z_INDEX}; font-size: 22px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: 0.2s;
                }
                #universal-helper-fab:hover { transform: scale(1.1); }

                /* Panel */
                #universal-panel {
                    position: fixed; bottom: 160px; right: 30px; width: 320px;
                    max-height: 600px; background: white; border: 1px solid #ddd;
                    box-shadow: 0 8px 30px rgba(0,0,0,0.15); z-index: ${CONFIG.UI_Z_INDEX};
                    border-radius: 12px; display: none; flex-direction: column;
                    font-family: sans-serif; font-size: 14px;
                }
                .u-header { padding: 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; font-weight: bold; background: #f9f9f9; }
                .u-content { flex: 1; overflow-y: auto; padding: 0; }
                .u-section { padding: 16px; border-bottom: 8px solid #f5f5f5; text-align:center;}
                .u-batch-btn {
                    width: 100%; padding: 10px; background: #ff4d4f; color: white;
                    border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: bold;
                    margin-bottom: 10px; transition: background 0.2s;
                }
                .u-batch-btn:hover { background: #d9363e; }
                .u-batch-btn.running { background: #ccc; cursor: not-allowed; }

                .u-list-header { padding: 10px 16px; background: #f5f5f5; color: #666; font-size: 12px;}
                .u-item { padding: 10px 16px; border-bottom: 1px solid #f1f3f4; display: flex; justify-content: space-between; }
                .u-remove { color: #ff4d4f; cursor: pointer; }

                /* Progress Overlay */
                #batch-progress-overlay {
                    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
                    background: rgba(0,0,0,0.8); color: white; padding: 10px 20px;
                    border-radius: 30px; z-index: ${CONFIG.UI_Z_INDEX + 1};
                    display: none; align-items: center; font-size: 14px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                }
                .spinner {
                    width: 16px; height: 16px; border: 2px solid #fff; border-top-color: transparent;
                    border-radius: 50%; animation: spin 1s linear infinite; margin-right: 10px;
                }
                @keyframes spin { to { transform: rotate(360deg); } }

                body[data-site="51job"] #universal-helper-fab { background: #ff6000; }
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
            UI.createProgressOverlay();
        },
        createFab: () => {
            const fab = document.createElement('div');
            fab.id = 'universal-helper-fab';
            fab.innerText = '🛡️';
            fab.onclick = () => UI.togglePanel();
            document.body.appendChild(fab);
        },
        createPanel: () => {
            const panel = document.createElement('div');
            panel.id = 'universal-panel';
            // 优化：数据量大时，面板只显示最近的50条，避免渲染卡顿
            panel.innerHTML = `
                <div class="u-header">
                    <span>全能助手 v24 (高性能版)</span>
                    <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">×</span>
                </div>
                <div class="u-content">
                    ${currentSiteConfig.key === 'boss' ?
                    `<div class="u-section">
                        <button id="u-batch-run" class="u-batch-btn">一键投递并屏蔽本页</button>
                        <div style="font-size:12px;color:#999">
                            自动点击列表 -> 等待详情加载 -> 投递。<br>
                            <span style="color:orange">⚠ 必须保持浏览器窗口前台可见</span>
                        </div>
                    </div>` : ''}
                    <div class="u-list-header">🚫 已屏蔽 (<span id="u-count">0</span>) - 仅显示最近50条</div>
                    <div id="u-list"></div>
                </div>`;
            document.body.appendChild(panel);
            const batchBtn = document.getElementById('u-batch-run');
            if (batchBtn) {
                batchBtn.onclick = () => {
                    if (State.isBatchRunning) {
                        Automation.stopBatch();
                    } else {
                        if (confirm('确定要对本页所有职位进行【投递+屏蔽】操作吗？')) {
                            Automation.runBatch();
                        }
                    }
                };
            }
        },
        createProgressOverlay: () => {
            const div = document.createElement('div');
            div.id = 'batch-progress-overlay';
            div.innerHTML = `<div class="spinner"></div><span id="batch-status-text">正在处理...</span>`;
            document.body.appendChild(div);
        },
        updateProgress: (current, total, statusText) => {
            const overlay = document.getElementById('batch-progress-overlay');
            const text = document.getElementById('batch-status-text');
            if (overlay && text) {
                overlay.style.display = 'flex';
                text.innerText = `正在处理: ${current}/${total} - ${statusText}`;
            }
        },
        hideProgress: () => {
            const overlay = document.getElementById('batch-progress-overlay');
            if (overlay) overlay.style.display = 'none';
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
            // 优化：只渲染最近的 50 条，防止 DOM 过多导致面板卡顿
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

    // --- 5. Automation Module ---
    const Automation = {
        setNativeValue: (element, value) => {
            const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
            const prototype = Object.getPrototypeOf(element);
            const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
            if (valueSetter && valueSetter !== prototypeValueSetter) {
                prototypeValueSetter.call(element, value);
            } else {
                valueSetter.call(element, value);
            }
            element.dispatchEvent(new Event('input', { bubbles: true }));
        },
        monitorDialog: () => {
            if (currentSiteConfig.key !== 'boss') return;
            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) {
                        const dialog = document.querySelector(currentSiteConfig.dialogSelector);
                        if (dialog && !dialog.classList.contains('greet-boss-dialog') && !dialog.dataset.bossHelperProcessed) {
                            dialog.dataset.bossHelperProcessed = 'true';
                            const textarea = dialog.querySelector(currentSiteConfig.dialogInputSelector);
                            if (textarea) {
                                setTimeout(() => {
                                    Automation.setNativeValue(textarea, CONFIG.DEFAULT_GREETING);
                                }, 100);
                                setTimeout(() => {
                                    const submitBtn = dialog.querySelector(currentSiteConfig.dialogSubmitSelector);
                                    if (submitBtn) submitBtn.click();
                                }, 300);
                            }
                        }
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });

            setInterval(() => {
                const sentDialog = document.querySelector(currentSiteConfig.sentDialogSelector);
                if (sentDialog && getComputedStyle(sentDialog).display !== 'none') {
                    console.log('[BossHelper] 检测到已发送弹窗，正在关闭...');
                    const cancelBtn = sentDialog.querySelector('.cancel-btn');
                    const closeBtn = sentDialog.querySelector('.close');
                    if (cancelBtn) cancelBtn.click();
                    else if (closeBtn) closeBtn.click();
                }
            }, 500);
        },
        applyJob: (card) => {
            return new Promise((resolve) => {
                let chatBtn = null;
                if (currentSiteConfig.chatBtnSelectors && currentSiteConfig.chatBtnSelectors.length > 0) {
                     for (const s of currentSiteConfig.chatBtnSelectors) {
                        chatBtn = card.querySelector(s);
                        if (chatBtn) break;
                    }
                }
                if (chatBtn) {
                    chatBtn.click();
                    Automation.markApplied(card);
                    setTimeout(() => resolve(true), 800);
                    return;
                }
                const clickTarget = card.querySelector('.job-info') || card;
                clickTarget.click();
                const startTime = Date.now();
                const checkInterval = setInterval(() => {
                    if (Date.now() - startTime > CONFIG.DETAIL_LOAD_TIMEOUT) {
                        clearInterval(checkInterval);
                        console.warn('[BossHelper] 等待详情页按钮超时');
                        resolve(false);
                        return;
                    }
                    const detailPanel = document.querySelector(currentSiteConfig.detailPanelSelector);
                    if (detailPanel) {
                        const detailBtn = detailPanel.querySelector(currentSiteConfig.detailSubmitSelector);
                        if (detailBtn && detailBtn.offsetParent !== null) {
                            const btnText = detailBtn.innerText;
                            if (btnText.includes('沟通') || btnText.includes('Chat')) {
                                clearInterval(checkInterval);
                                detailBtn.click();
                                Automation.markApplied(card);
                                console.log('[BossHelper] 详情页投递成功');
                                resolve(true);
                                return;
                            } else if (btnText.includes('继续') || btnText.includes('已')) {
                                clearInterval(checkInterval);
                                Automation.markApplied(card);
                                resolve(true);
                                return;
                            }
                        }
                    }
                }, 200);
            });
        },
        markApplied: (card) => {
            card.classList.add('boss-applied');
            const btn = card.querySelector('.boss-btn-apply');
            if (btn) {
                btn.innerText = '✅';
                btn.classList.add('boss-btn-applied');
            }
        },
        runBatch: async () => {
            if (State.isBatchRunning) return;
            State.isBatchRunning = true;
            State.stopBatchSignal = false;
            const btn = document.getElementById('u-batch-run');
            if(btn) { btn.innerText = '停止运行'; btn.classList.add('running'); }

            const selector = currentSiteConfig.cardSelectors.join(',');
            const cards = Array.from(document.querySelectorAll(selector)).filter(card => {
                return !card.classList.contains('universal-blocked') && !card.classList.contains('boss-applied');
            });

            State.totalCount = cards.length;
            State.processedCount = 0;
            if (cards.length === 0) {
                alert('当前页面没有可处理的职位。');
                Automation.finishBatch();
                return;
            }
            for (let i = 0; i < cards.length; i++) {
                if (State.stopBatchSignal) break;
                State.processedCount++;
                const card = cards[i];
                const companyName = Core.getCompanyName(card);
                if (companyName && Storage.isBlocked(companyName)) {
                    UI.updateProgress(State.processedCount, State.totalCount, `跳过已屏蔽: ${companyName}`);
                    Core.updateVisibility(card, Storage.getBlacklist());
                    continue;
                }
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                UI.updateProgress(State.processedCount, State.totalCount, `正在投递: ${companyName || '未知'}`);
                await Automation.applyJob(card);
                if (companyName) {
                    Storage.addCompany(companyName);
                    Core.updateVisibility(card, Storage.getBlacklist());
                }
                const waitTime = Math.floor(Math.random() * (CONFIG.BATCH_DELAY_MAX - CONFIG.BATCH_DELAY_MIN + 1)) + CONFIG.BATCH_DELAY_MIN;
                await new Promise(r => setTimeout(r, waitTime));
            }
            Automation.finishBatch();
        },
        stopBatch: () => {
            State.stopBatchSignal = true;
            const btn = document.getElementById('u-batch-run');
            if(btn) btn.innerText = '正在停止...';
        },
        finishBatch: () => {
            State.isBatchRunning = false;
            const btn = document.getElementById('u-batch-run');
            if(btn) { btn.innerText = '一键投递并屏蔽本页'; btn.classList.remove('running'); }
            UI.hideProgress();
            UI.renderList();
        }
    };

    // --- 6. Core Logic ---
    const Core = {
        getCompanyName: (card) => {
            let companyName = '';
            for (let s of currentSiteConfig.nameSelectors) {
                const el = card.querySelector(s);
                if (el) { companyName = (el.innerText || '').trim(); break; }
            }
            return companyName;
        },
        processCard: (card, blacklist) => {
            if (card.dataset.uProcessed === 'true') {
                Core.updateVisibility(card, blacklist); // 就算处理过，也要重新检查屏蔽状态，因为黑名单可能更新
                return;
            }
            const companyName = Core.getCompanyName(card);
            if (!companyName) return;
            card.dataset.companyName = companyName;
            Core.injectActionBar(card, companyName);
            Core.updateVisibility(card, blacklist); // 传入blacklist参数其实不再重要，因为isBlocked现在走内存
            card.dataset.uProcessed = 'true';
        },
        injectActionBar: (card, name) => {
            if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
            if (card.querySelector('.boss-action-bar')) return;
            const bar = document.createElement('div');
            bar.className = 'boss-action-bar';
            if (currentSiteConfig.key === 'boss') {
                const apply = document.createElement('div');
                apply.className = 'boss-action-btn boss-btn-apply';
                apply.innerText = '🚀 投递';
                apply.onclick = (e) => {
                    e.stopPropagation(); e.preventDefault();
                    Automation.applyJob(card);
                };
                bar.appendChild(apply);
            }
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
            // 优化：直接调用内存级 isBlocked，无需传递 huge array
            if (Storage.isBlocked(card.dataset.companyName)) {
                card.classList.add('universal-blocked');
            } else {
                card.classList.remove('universal-blocked');
            }
        },
        refresh: () => {
            // 刷新时不需要获取整个列表，直接遍历 DOM 让每个元素自己去查 Cache
            document.querySelectorAll(currentSiteConfig.cardSelectors.join(',')).forEach(c => Core.updateVisibility(c));
        },
        initScanner: () => {
            Storage.init(); // 启动时预加载黑名单到内存
            const run = () => {
                const selector = currentSiteConfig.cardSelectors.join(',');
                document.querySelectorAll(selector).forEach(c => Core.processCard(c));
            };
            new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
            setInterval(run, CONFIG.REFRESH_INTERVAL_MS);
            run();
        }
    };

    // --- 7. Initialization ---
    const App = {
        init: () => {
            console.log(`[BossHelper v24] Loaded for ${currentSiteConfig.key} (Performance: High)`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
            Automation.monitorDialog();
        }
    };

    App.init();
})();