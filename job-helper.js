// ==UserScript==
// @name        招聘网站全能助手 (v21.0 智能跳过版)
// @namespace   http://tampermonkey.net/
// @version     21.0
// @description 一键批量投递并屏蔽！自动跳过已屏蔽公司，极速去弹窗，效率更高。
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

    // --- 1. 配置模块 (Configuration) ---
    // 定义全局常量、UI层级及反爬虫策略参数
    const CONFIG = {
        STORAGE_KEY: 'universal_job_blacklist',
        UI_Z_INDEX: 2147483647, // 确保 UI 覆盖在所有页面元素之上
        REFRESH_INTERVAL_MS: 1000, // DOM 扫描轮询间隔
        // 批量操作时的随机延迟范围 (毫秒)，模拟人类操作以规避风控
        BATCH_DELAY_MIN: 2000,
        BATCH_DELAY_MAX: 4000,
        DEFAULT_GREETING: '你好，我对这个职位很感兴趣，希望能有机会聊聊。'
    };

    // 针对不同站点的 DOM 选择器配置 (策略模式)
    const SITE_CONFIGS = {
        boss: {
            // 职位卡片、公司名称、聊天按钮等关键元素的 CSS 选择器列表
            cardSelectors: ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'],
            nameSelectors: ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'],
            chatBtnSelectors: ['.start-chat-btn', '.op-btn-chat', '.btn-startchat', '.btn-container .btn-sure'],
            detailPanelSelector: '.job-detail-container, .job-detail-box',

            // 弹窗处理相关选择器
            dialogSelector: '.dialog-container, .greet-boss-dialog',
            dialogInputSelector: 'textarea',
            dialogSubmitSelector: '.btn-sure, .btn-startchat',
            dialogStaySelector: '.cancel-btn, .btn-cancel, .btn-close, .close',

            key: 'boss'
        },
        job51: {
            cardSelectors: ['.joblist-item', '.j_joblist .e', '.el', '.job-list-item'],
            nameSelectors: ['.cname a', '.cname', '.t2 a', '.er a', '.company_name'],
            chatBtnSelectors: [], // 51job 暂未实现自动沟通
            key: '51job'
        }
    };

    // 根据当前域名确定使用的站点配置
    const currentSiteConfig = location.host.includes('zhipin.com') ? SITE_CONFIGS.boss : SITE_CONFIGS.job51;

    // --- 2. 状态管理 (State Management) ---
    // 维护运行时状态，防止批量操作冲突
    const State = {
        isBatchRunning: false,
        stopBatchSignal: false,
        processedCount: 0,
        totalCount: 0
    };

    // --- 3. 存储模块 (Storage Module) ---
    // 封装 Tampermonkey 的存储 API，用于持久化黑名单数据
    const Storage = {
        getBlacklist: () => GM_getValue(CONFIG.STORAGE_KEY, []),

        // 添加公司到黑名单（去重）
        addCompany: (name) => {
            if (!name) return false;
            const list = Storage.getBlacklist();
            const trimmedName = name.trim();
            if (!list.includes(trimmedName)) {
                list.push(trimmedName);
                GM_setValue(CONFIG.STORAGE_KEY, list);
                return true;
            }
            return false;
        },

        removeCompany: (name) => {
            const list = Storage.getBlacklist().filter(n => n !== name);
            GM_setValue(CONFIG.STORAGE_KEY, list);
        },

        isBlocked: (name) => {
            if(!name) return false;
            const list = Storage.getBlacklist();
            return list.includes(name.trim());
        }
    };

    // --- 4. UI 模块 (UI Module) ---
    // 负责样式注入和悬浮窗/面板的 DOM 构建
    const UI = {
        injectStyles: () => {
            // 使用模板字符串构建 CSS，包含操作栏、高亮样式、悬浮球及弹窗隐藏逻辑
            const styles = `
                /* --- 操作栏样式 (Action Bar) --- */
                .boss-action-bar {
                    position: absolute; top: 0; right: 0; z-index: 999;
                    display: none; border-bottom-left-radius: 8px; overflow: hidden;
                    box-shadow: -2px 2px 8px rgba(0,0,0,0.15); background: white;
                }
                /* 鼠标悬停显示操作栏 */
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

                /* --- 状态样式 --- */
                .boss-applied { background-color: #f0f9eb !important; opacity: 0.8; border-left: 4px solid #67c23a; }
                .boss-btn-applied { background: #67c23a !important; cursor: default; pointer-events: none; }
                .universal-blocked { display: none !important; } /* 隐藏被屏蔽的公司 */

                /* --- 悬浮球 (FAB) --- */
                #universal-helper-fab {
                    position: fixed; bottom: 100px; right: 30px; width: 48px; height: 48px;
                    background: #4285f4; color: white; border-radius: 50%;
                    display: flex; align-items: center; justify-content: center;
                    cursor: pointer; z-index: ${CONFIG.UI_Z_INDEX}; font-size: 22px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: 0.2s;
                }
                #universal-helper-fab:hover { transform: scale(1.1); }

                /* --- 控制面板 --- */
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

                /* --- 进度覆盖层 --- */
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

                /* --- 隐形模式：隐藏特定弹窗 --- */
                .greet-boss-dialog {
                    display: none !important;
                    opacity: 0 !important;
                    pointer-events: none !important;
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
            // 动态生成面板 HTML
            panel.innerHTML = `
                <div class="u-header">
                    <span>全能助手 v21</span>
                    <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">×</span>
                </div>
                <div class="u-content">
                    ${currentSiteConfig.key === 'boss' ?
                    `<div class="u-section">
                        <button id="u-batch-run" class="u-batch-btn">一键投递并屏蔽本页</button>
                        <div style="font-size:12px;color:#999">
                            自动逐个投递当前页职位，投递后立即屏蔽。<br>
                            <span style="color:orange">⚠ 请保持页面前台运行</span>
                        </div>
                    </div>` : ''}
                    <div class="u-list-header">🚫 已屏蔽 (<span id="u-count">0</span>)</div>
                    <div id="u-list"></div>
                </div>`;
            document.body.appendChild(panel);

            // 绑定批量运行按钮事件
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

        // 渲染黑名单列表
        renderList: () => {
            const list = Storage.getBlacklist();
            document.getElementById('u-count').innerText = list.length;
            const container = document.getElementById('u-list');
            container.innerHTML = '';
            [...list].reverse().forEach(name => {
                const div = document.createElement('div');
                div.className = 'u-item';
                div.innerHTML = `<span>${name}</span><span class="u-remove">移除</span>`;
                div.querySelector('.u-remove').onclick = () => {
                    Storage.removeCompany(name);
                    UI.renderList();
                    Core.refresh(); // 更新当前页面元素的可见性
                };
                container.appendChild(div);
            });
        }
    };

    // --- 5. 自动化模块 (Automation Module) ---
    // 处理模拟用户交互、输入填充及批量流程控制
    const Automation = {
        /**
         * 绕过 React/Vue 框架限制设置输入框值。
         * 框架通常重写了 value 属性的 setter，直接赋值不会触发状态更新。
         * 此方法调用原生 setter 并分发 input 事件。
         */
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

        // 监听并自动处理弹窗 (如：打招呼确认窗)
        monitorDialog: () => {
            if (currentSiteConfig.key !== 'boss') return;

            const observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    if (m.addedNodes.length > 0) {
                        const dialog = document.querySelector(currentSiteConfig.dialogSelector);

                        if (dialog) {
                            // 1. 如果是默认打招呼弹窗，尝试留在当前页或关闭
                            if (dialog.classList.contains('greet-boss-dialog')) {
                                const stayBtn = dialog.querySelector(currentSiteConfig.dialogStaySelector);
                                if (stayBtn) stayBtn.click();
                                else {
                                    const closeBtn = dialog.querySelector('.close, .icon-close');
                                    if (closeBtn) closeBtn.click();
                                }
                            }

                            // 2. 如果是自定义沟通弹窗，自动填充并发送
                            if (!dialog.dataset.bossHelperProcessed) {
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
                                    return;
                                }

                                // 3. 兜底处理：寻找"关闭"或"取消"按钮
                                setTimeout(() => {
                                    const buttons = Array.from(dialog.querySelectorAll('button, .btn, a.default-btn'));
                                    let stayBtn = null;
                                    for (const btn of buttons) {
                                        if (btn.innerText.includes('留在此页') || btn.innerText.includes('取消')) {
                                            stayBtn = btn;
                                            break;
                                        }
                                    }
                                    if (!stayBtn) stayBtn = dialog.querySelector(currentSiteConfig.dialogStaySelector);

                                    if (stayBtn) stayBtn.click();
                                    else {
                                        const closeBtn = dialog.querySelector('.close, .icon-close');
                                        if (closeBtn) closeBtn.click();
                                    }
                                }, 200);
                            }
                        }
                    }
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        },

        // 执行单个职位的投递逻辑
        applyJob: (card) => {
            return new Promise((resolve) => {
                // 查找聊天按钮
                let chatBtn = null;
                for (const s of currentSiteConfig.chatBtnSelectors) {
                    chatBtn = card.querySelector(s);
                    if (chatBtn) break;
                }
                // 模糊匹配兜底
                if (!chatBtn) {
                    const candidates = card.querySelectorAll('a, button, div[role="button"]');
                    for (const el of candidates) {
                        if (el.innerText.includes('立即沟通') || el.innerText.includes('继续沟通')) {
                            chatBtn = el;
                            break;
                        }
                    }
                }

                // 如果列表页无按钮，尝试点击进入详情页 (兼容某些 UI 布局)
                if (!chatBtn) {
                    const detailPanel = document.querySelector(currentSiteConfig.detailPanelSelector);
                    if (detailPanel && detailPanel.offsetParent !== null) {
                        const clickTarget = card.querySelector('.job-info') || card;
                        clickTarget.click();

                        setTimeout(() => {
                            const detailBtn = detailPanel.querySelector(currentSiteConfig.dialogSubmitSelector) ||
                                            Array.from(detailPanel.querySelectorAll('a, button')).find(el => el.innerText.includes('沟通'));
                            if (detailBtn) {
                                detailBtn.click();
                                Automation.markApplied(card);
                                resolve(true);
                            } else {
                                resolve(false);
                            }
                        }, 800);
                        return;
                    }
                }

                if (!chatBtn) {
                    resolve(false);
                    return;
                }

                chatBtn.click();
                Automation.markApplied(card);

                setTimeout(() => resolve(true), 800);
            });
        },

        // 标记 UI 为已投递状态
        markApplied: (card) => {
            card.classList.add('boss-applied');
            const btn = card.querySelector('.boss-btn-apply');
            if (btn) {
                btn.innerText = '✅';
                btn.classList.add('boss-btn-applied');
            }
        },

        // 批量运行逻辑: 遍历 -> 检查屏蔽 -> 投递 -> 屏蔽 -> 随机延迟
        runBatch: async () => {
            if (State.isBatchRunning) return;
            State.isBatchRunning = true;
            State.stopBatchSignal = false;

            const btn = document.getElementById('u-batch-run');
            if(btn) { btn.innerText = '停止运行'; btn.classList.add('running'); }

            const selector = currentSiteConfig.cardSelectors.join(',');
            // 过滤掉已屏蔽和已投递的卡片
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

                // --- 关键防御：再次检查是否在黑名单中，防止 race condition ---
                if (companyName && Storage.isBlocked(companyName)) {
                    console.log(`[BossHelper] 跳过已屏蔽公司: ${companyName}`);
                    UI.updateProgress(State.processedCount, State.totalCount, `跳过已屏蔽: ${companyName}`);
                    Core.updateVisibility(card, Storage.getBlacklist());
                    continue;
                }

                // 滚动到视图中心，模拟人类浏览行为
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                UI.updateProgress(State.processedCount, State.totalCount, `投递中: ${companyName || '未知'}`);

                // 1. 执行投递
                await Automation.applyJob(card);

                // 2. 投递后立即加入黑名单 (实现"投递并屏蔽"需求)
                if (companyName) {
                    Storage.addCompany(companyName);
                    Core.updateVisibility(card, Storage.getBlacklist());
                }

                // 3. 随机延迟，避免触发反爬虫机制
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

    // --- 6. 核心逻辑 (Core Logic) ---
    // 负责 DOM 解析、数据提取和操作栏注入
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
                Core.updateVisibility(card, blacklist);
                return;
            }
            const companyName = Core.getCompanyName(card);
            if (!companyName) return;

            card.dataset.companyName = companyName;
            Core.injectActionBar(card, companyName);
            Core.updateVisibility(card, blacklist);
            card.dataset.uProcessed = 'true';
        },

        // 在职位卡片上注入 "投递" 和 "屏蔽" 按钮
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
                    Automation.applyJob(card).then(() => {
                         // 可以在此添加单次点击后的回调逻辑
                    });
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

        updateVisibility: (card, blacklist) => {
            if (blacklist.includes(card.dataset.companyName)) {
                card.classList.add('universal-blocked');
            } else {
                card.classList.remove('universal-blocked');
            }
        },

        refresh: () => {
            const list = Storage.getBlacklist();
            document.querySelectorAll(currentSiteConfig.cardSelectors.join(',')).forEach(c => Core.updateVisibility(c, list));
        },

        // 初始化 DOM 扫描器，支持 SPA (单页应用) 动态加载
        initScanner: () => {
            const run = () => {
                const list = Storage.getBlacklist();
                const selector = currentSiteConfig.cardSelectors.join(',');
                document.querySelectorAll(selector).forEach(c => Core.processCard(c, list));
            };
            // 使用 MutationObserver 监听 DOM 变化
            new MutationObserver(run).observe(document.body, { childList: true, subtree: true });
            // 定时器轮询作为 MutationObserver 的补充
            setInterval(run, CONFIG.REFRESH_INTERVAL_MS);
            run();
        }
    };

    // --- 7. 初始化 (Initialization) ---
    const App = {
        init: () => {
            console.log(`[BossHelper v21] Loaded for ${currentSiteConfig.key}`);
            UI.injectStyles();
            UI.init();
            Core.initScanner();
            Automation.monitorDialog();
        }
    };

    App.init();
})();