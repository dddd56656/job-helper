/**
 * 全能助手控制面板 (src/ui/panel.js)
 * 
 * 以原版 job-helper.js UI 为主体：
 * 1. 经典 320px 全能助手抽屉面板结构 (标题栏、关闭按钮、黑名单列表、单项移除、导入/导出备份)
 * 2. 针对 BOSS直聘 环境自适应嵌入流水线调度控制 (开始/暂停/急停、实时计数、限额设置)
 * 3. 跨标签页黑名单实时同步监听 (响应 blacklist.subscribe 自动重绘)
 * 4. 内置原生样式注入与全局 Toast 提示条管理
 */

class UniversalPanel {
    constructor(scheduler = null, options = {}) {
        const browser = typeof window !== 'undefined' ? window : {};
        this.scheduler = scheduler;
        this.blacklist = options.blacklist || browser.blacklist;
        this.root = options.root || (typeof document !== 'undefined' ? document.body : null);
        this.element = null;
        this.toastElement = null;
        this.unsubscribeScheduler = null;
        this.unsubscribeBlacklist = null;
        this.onEmergencyStop = options.onEmergencyStop || (() => {
            if (this.scheduler && typeof this.scheduler.stop === 'function') {
                this.scheduler.stop('Emergency stop from panel');
            }
        });
    }

    injectStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('job-helper-universal-styles')) return;

        const styles = `
            .boss-action-bar { position: absolute; top: 0; right: 0; z-index: 999; display: none; border-bottom-left-radius: 8px; overflow: hidden; box-shadow: -2px 2px 8px rgba(0,0,0,0.15); background: white; }
            .joblist-item:hover .boss-action-bar, .j_joblist .e:hover .boss-action-bar, .el:hover .boss-action-bar, .job-list-item:hover .boss-action-bar,
            .job-card-box:hover .boss-action-bar, .job-card-wrapper:hover .boss-action-bar, li.job-primary:hover .boss-action-bar, .job-list-ul > li:hover .boss-action-bar, .job-card-body:hover .boss-action-bar { display: flex !important; }
            .boss-action-btn { padding: 6px 14px; font-size: 13px; cursor: pointer; font-weight: bold; color: white; display: flex; align-items: center; justify-content: center; }
            .boss-btn-block { background: #ff4d4f; }
            .boss-btn-block:hover { background: #d9363e; }
            .universal-blocked { display: none !important; }

            /* 悬浮球 */
            #universal-helper-fab { position: fixed; bottom: 100px; right: 30px; width: 48px; height: 48px; background: #4285f4; color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 2147483647; font-size: 22px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: 0.2s; user-select: none; border: none; outline: none; }
            #universal-helper-fab:hover { transform: scale(1.1); }
            #universal-helper-fab.paused { background: #eab308; }
            #universal-helper-fab.running { background: #16a34a; }
            #universal-helper-fab.circuit_broken { background: #dc2626; }

            /* 主面板 */
            #universal-panel { position: fixed; bottom: 160px; right: 30px; width: 320px; max-height: 600px; background: white; border: 1px solid #ddd; box-shadow: 0 8px 30px rgba(0,0,0,0.15); z-index: 2147483647; border-radius: 12px; display: none; flex-direction: column; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; font-size: 13px; color: #1f2937; }
            .u-header { padding: 12px 16px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; font-weight: bold; background: #f9f9f9; border-top-left-radius: 12px; border-top-right-radius: 12px; align-items: center; }
            .u-close { cursor: pointer; font-size: 18px; color: #888; }
            .u-close:hover { color: #333; }
            .u-content { flex: 1; overflow-y: auto; padding: 0; }
            .u-section { padding: 14px 16px; border-bottom: 8px solid #f5f5f5; }
            .u-data-btn { width: 48%; padding: 7px 0; font-size: 12px; cursor: pointer; border: 1px solid #ddd; background: #fff; border-radius: 4px; transition: background 0.2s; }
            .u-data-btn:hover { background: #f0f0f0; }
            .u-list-header { padding: 10px 16px; background: #f5f5f5; color: #666; font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
            .u-item { padding: 9px 16px; border-bottom: 1px solid #f1f3f4; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
            .u-remove { color: #ff4d4f; cursor: pointer; font-size: 12px; font-weight: 500; }
            .u-remove:hover { text-decoration: underline; }

            /* 调度器控制组件 */
            .u-scheduler-box { margin-bottom: 10px; background: #fafafa; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px; font-size: 12px; line-height: 1.8; }
            .u-btn-main { width: 100%; padding: 9px; margin-bottom: 8px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; transition: 0.2s; color: white; }
            .u-btn-running { background: #16a34a; }
            .u-btn-running:hover { background: #15803d; }
            .u-btn-paused { background: #eab308; }
            .u-btn-paused:hover { background: #ca8a04; }
            .u-btn-idle { background: #2563eb; }
            .u-btn-idle:hover { background: #1d4ed8; }
            .u-btn-stop { background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; font-size: 12px; cursor: pointer; font-weight: bold; }
            .u-btn-stop:hover { background: #dc2626; }

            /* 提示条 */
            #auto-load-toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.85); color: #fff; padding: 10px 22px; border-radius: 30px; font-size: 13px; z-index: 2147483647; opacity: 0; pointer-events: none; transition: opacity 0.3s; font-weight: 500; box-shadow: 0 4px 12px rgba(0,0,0,0.25); display: flex; align-items: center; gap: 8px; }
            #auto-load-toast.show { opacity: 1; pointer-events: auto; }
            #auto-load-toast.danger { background: #dc2626; }
        `;

        if (typeof GM_addStyle === 'function') {
            GM_addStyle(styles);
        } else {
            const el = document.createElement('style');
            el.id = 'job-helper-universal-styles';
            el.textContent = styles;
            document.head.appendChild(el);
        }
    }

    mount() {
        if (this.element || !this.root) return this;
        this.injectStyles();

        // 1. 创建主面板容器
        this.element = document.createElement('section');
        this.element.id = 'universal-panel';
        this.element.setAttribute('aria-live', 'polite');

        const hasScheduler = !!this.scheduler;

        this.element.innerHTML = `
            <div class="u-header">
                <span>全能助手 (前程无忧 / BOSS直聘)</span>
                <span class="u-close" data-action="close">×</span>
            </div>
            <div class="u-content">
                ${hasScheduler ? `
                <div class="u-section" id="u-scheduler-section">
                    <button id="u-toggle-delivery" class="u-btn-main u-btn-idle">🚀 开始自动投递</button>
                    <div class="u-scheduler-box">
                        <div data-role="stats">状态：空闲<br>已投递：0<br>黑名单跳过：0<br>重复跳过：0<br>当前页：-</div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
                            <label>每日上限: <input data-role="limit" type="number" min="1" max="99999" value="80" style="width:64px; padding:2px 4px; border:1px solid #ccc; border-radius:3px;"></label>
                            <button data-action="stop" class="u-btn-stop">🛑 急停</button>
                        </div>
                        <div style="margin-top:8px; border-top:1px dashed #e5e7eb; padding-top:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <label style="font-weight:600; cursor:pointer; font-size:12px;">
                                    <input data-role="greeting-enable" type="checkbox" checked> 💬 高级招呼语 (纯文本通道)
                                </label>
                                <a href="https://www.zhipin.com/web/geek/notify-set?type=greetSet" target="_blank" style="font-size:11px; color:#2563eb; text-decoration:none;" title="前往BOSS直聘设置关闭自带招呼">关闭自带招呼↗</a>
                            </div>
                            <textarea data-role="greeting-input" rows="2" style="width:100%; box-sizing:border-box; margin-top:4px; font-size:12px; border:1px solid #d1d5db; border-radius:4px; padding:4px;" placeholder="您好！看到贵司正在招聘{jobName}，非常契合我的背景，希望能与您进一步沟通！"></textarea>
                            <div style="font-size:11px; color:#6b7280; line-height:1.4; margin-top:2px;">
                                💡 因平台原生招呼语通道已失效，已全量采用高级招呼语纯文本通道直达；支持变量：{jobName}、{companyName}
                            </div>
                        </div>
                    </div>
                </div>
                ` : ''}
                <div class="u-section">
                    <div style="font-weight:600; margin-bottom:8px;">📁 黑名单数据管理 (双平台实时互通)</div>
                    <div style="display:flex; justify-content:space-between;">
                        <button id="u-btn-export" class="u-data-btn">📤 导出备份</button>
                        <button id="u-btn-import" class="u-data-btn">📥 导入数据</button>
                        <input type="file" id="u-file-input" style="display:none" accept=".json">
                    </div>
                </div>
                <div class="u-list-header">
                    <span>🚫 已屏蔽企业 (<span id="u-count">0</span>)</span>
                    <span style="font-size:11px; color:#888;">最近50条</span>
                </div>
                <div id="u-list" style="max-height: 220px; overflow-y: auto;"></div>
            </div>
        `;

        // 2. 绑定事件
        this.element.querySelector('[data-action="close"]').addEventListener('click', () => this.hide());
        
        if (hasScheduler) {
            const toggleBtn = this.element.querySelector('#u-toggle-delivery');
            toggleBtn.addEventListener('click', () => this._toggleScheduler());

            const stopBtn = this.element.querySelector('[data-action="stop"]');
            stopBtn.addEventListener('click', () => this.onEmergencyStop());

            const limitInput = this.element.querySelector('[data-role="limit"]');
            limitInput.addEventListener('change', (e) => {
                const val = Math.min(99999, Math.max(1, Number(e.target.value) || 80));
                this.scheduler.dailyLimit = val;
            });

            // 自定义招呼语持久化与状态同步
            const gmGet = typeof GM_getValue === 'function' ? GM_getValue : (typeof window !== 'undefined' && window.GM_getValue ? window.GM_getValue : null);
            const gmSet = typeof GM_setValue === 'function' ? GM_setValue : (typeof window !== 'undefined' && window.GM_setValue ? window.GM_setValue : null);

            const greetingEnable = this.element.querySelector('[data-role="greeting-enable"]');
            const greetingInput = this.element.querySelector('[data-role="greeting-input"]');

            const defaultGreetingText = '您好！看到贵司正在招聘{jobName}，非常契合我的背景，希望能与您进一步沟通！';
            const savedEnable = gmGet ? gmGet('universal_custom_greeting_enabled', true) : true;
            const savedText = gmGet ? gmGet('universal_custom_greeting', '') : '';
            const initialText = savedText || defaultGreetingText;

            if (greetingEnable) greetingEnable.checked = savedEnable !== false;
            if (greetingInput) greetingInput.value = initialText;

            this.scheduler.customGreeting = {
                enabled: savedEnable !== false,
                text: initialText
            };

            const syncGreeting = () => {
                const enabled = greetingEnable ? greetingEnable.checked : false;
                const text = greetingInput ? greetingInput.value.trim() : '';
                if (gmSet) {
                    gmSet('universal_custom_greeting_enabled', enabled);
                    gmSet('universal_custom_greeting', text);
                }
                this.scheduler.customGreeting = { enabled, text };
            };

            if (greetingEnable) greetingEnable.addEventListener('change', syncGreeting);
            if (greetingInput) greetingInput.addEventListener('input', syncGreeting);

            this.unsubscribeScheduler = this.scheduler.subscribe((view) => this.renderScheduler(view));
        }

        // 导出 / 导入
        const exportBtn = this.element.querySelector('#u-btn-export');
        exportBtn.addEventListener('click', () => this.exportBlacklist());

        const importBtn = this.element.querySelector('#u-btn-import');
        const fileInput = this.element.querySelector('#u-file-input');
        importBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (evt) => {
                this.importBlacklist(evt.target.result);
                e.target.value = '';
            };
            reader.readAsText(file);
        });

        // 3. 黑名单实时更新订阅
        if (this.blacklist && typeof this.blacklist.subscribe === 'function') {
            this.unsubscribeBlacklist = this.blacklist.subscribe(() => this.renderBlacklist());
        }

        this.root.appendChild(this.element);
        this.renderBlacklist();
        this._createToast();

        return this;
    }

    _createToast() {
        if (this.toastElement || typeof document === 'undefined') return;
        this.toastElement = document.createElement('div');
        this.toastElement.id = 'auto-load-toast';
        this.toastElement.onclick = () => {
            if (this.scheduler && this.scheduler.state === 'running') {
                this.scheduler.pause();
                this.showToast('⏸️ 已暂停自动投递', 2000);
            }
        };
        this.root.appendChild(this.toastElement);
    }

    showToast(message, durationMs = 2500, isDanger = false) {
        if (!this.toastElement) return;
        this.toastElement.textContent = message;
        this.toastElement.classList.add('show');
        if (isDanger) this.toastElement.classList.add('danger');
        else this.toastElement.classList.remove('danger');

        if (this.toastTimer) clearTimeout(this.toastTimer);
        if (durationMs > 0) {
            this.toastTimer = setTimeout(() => {
                this.toastElement.classList.remove('show');
                this.toastElement.classList.remove('danger');
            }, durationMs);
        }
    }

    _toggleScheduler() {
        if (!this.scheduler) return;
        if (this.scheduler.state === 'running') {
            this.scheduler.pause();
        } else if (this.scheduler.state === 'paused') {
            this.scheduler.resume();
        } else {
            this.scheduler.start();
        }
    }

    renderScheduler(view) {
        if (!this.element) return;
        const { stats, state, dailyLimit } = view;
        const statsEl = this.element.querySelector('[data-role="stats"]');
        const toggleBtn = this.element.querySelector('#u-toggle-delivery');
        const limitInput = this.element.querySelector('[data-role="limit"]');

        if (statsEl) {
            const stateLabels = {
                idle: '空闲待命',
                running: '<span style="color:#16a34a;font-weight:bold">运行中...</span>',
                paused: '<span style="color:#eab308;font-weight:bold">已暂停</span>',
                stopped: '<span style="color:#ef4444;font-weight:bold">已急停</span>',
                circuit_broken: `<span style="color:#dc2626;font-weight:bold">已熔断 (${stats.reason || '平台限制'})</span>`,
                completed: '<span style="color:#2563eb;font-weight:bold">已完成</span>'
            };
            statsEl.innerHTML = `状态：${stateLabels[state] || state}<br>` +
                `已投递：${stats.delivered} / ${dailyLimit}${stats.limitReached ? ' (已达上限)' : ''}<br>` +
                `黑名单跳过：${stats.blacklistSkipped}<br>` +
                `重复跳过：${stats.duplicateSkipped || 0}<br>` +
                `当前页码：${stats.page || '-'}`;
        }

        if (limitInput) limitInput.value = dailyLimit;

        if (toggleBtn) {
            if (state === 'running') {
                toggleBtn.className = 'u-btn-main u-btn-running';
                toggleBtn.textContent = '⏸️ 暂停自动投递';
            } else if (state === 'paused') {
                toggleBtn.className = 'u-btn-main u-btn-paused';
                toggleBtn.textContent = '▶️ 恢复投递';
            } else {
                toggleBtn.className = 'u-btn-main u-btn-idle';
                toggleBtn.textContent = '🚀 开始自动投递';
            }
        }
    }

    renderBlacklist() {
        if (!this.element) return;
        const list = this.blacklist && typeof this.blacklist.getBlacklist === 'function'
            ? this.blacklist.getBlacklist()
            : [];

        const countEl = this.element.querySelector('#u-count');
        if (countEl) countEl.textContent = list.length;

        const container = this.element.querySelector('#u-list');
        if (!container) return;
        container.innerHTML = '';

        if (list.length === 0) {
            container.innerHTML = '<div style="padding:16px;text-align:center;color:#999;">暂无屏蔽企业</div>';
            return;
        }

        // 仅渲染最近 50 条
        [...list].slice(-50).reverse().forEach(name => {
            const div = document.createElement('div');
            div.className = 'u-item';
            div.innerHTML = `<span>${name}</span><span class="u-remove" title="点击取消屏蔽">移除</span>`;
            div.querySelector('.u-remove').onclick = () => {
                if (this.blacklist && typeof this.blacklist.removeCompany === 'function') {
                    this.blacklist.removeCompany(name);
                    this.renderBlacklist();
                    this.showToast(`已将【${name}】从黑名单移除`, 2000);
                }
            };
            container.appendChild(div);
        });
    }

    exportBlacklist() {
        if (!this.blacklist) return;
        const list = this.blacklist.getBlacklist ? this.blacklist.getBlacklist() : [];
        const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `job_blacklist_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.showToast('📤 黑名单备份文件导出成功', 2000);
    }

    importBlacklist(jsonContent) {
        if (!this.blacklist) return;
        let imported = 0;
        try {
            const parsed = JSON.parse(jsonContent);
            if (this.blacklist.importData) {
                imported = this.blacklist.importData(parsed);
            } else if (Array.isArray(parsed)) {
                parsed.forEach(c => this.blacklist.addCompany(c));
                imported = parsed.length;
            }
            this.renderBlacklist();
            this.showToast(`📥 成功导入 ${imported} 条黑名单数据`, 2500);
        } catch (e) {
            this.showToast('❌ 导入失败：JSON 格式无效', 3000, true);
        }
    }

    toggle() {
        if (!this.element) this.mount();
        if (this.element.style.display === 'flex') {
            this.hide();
        } else {
            this.show();
        }
    }

    show() {
        if (!this.element) this.mount();
        this.element.style.display = 'flex';
        this.renderBlacklist();
    }

    hide() {
        if (this.element) this.element.style.display = 'none';
    }

    destroy() {
        if (this.unsubscribeScheduler) this.unsubscribeScheduler();
        if (this.unsubscribeBlacklist) this.unsubscribeBlacklist();
        if (this.element) this.element.remove();
        if (this.toastElement) this.toastElement.remove();
        this.element = null;
        this.toastElement = null;
    }
}

// 兼容别名导出
const DeliveryPanel = UniversalPanel;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UniversalPanel, DeliveryPanel };
}
if (typeof window !== 'undefined') {
    window.UniversalPanel = UniversalPanel;
    window.DeliveryPanel = DeliveryPanel;
}
