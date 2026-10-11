class DeliveryPanel {
    constructor(scheduler, options = {}) {
        this.scheduler = scheduler;
        this.root = options.root || document.body;
        this.onEmergencyStop = options.onEmergencyStop || (() => scheduler.stop());
        this.element = null;
        this.unsubscribe = null;
    }
    mount() {
        if (this.element) return this;
        this.element = document.createElement('section');
        this.element.id = 'job-helper-panel';
        this.element.setAttribute('aria-live', 'polite');
        this.element.style.cssText = 'position:fixed;right:20px;bottom:82px;z-index:2147483647;width:240px;padding:14px;background:#fff;color:#1f2937;border:1px solid #d1d5db;border-radius:10px;box-shadow:0 8px 24px #0003;font:13px system-ui';
        this.element.innerHTML = '<strong>Job Helper</strong><div data-role="stats" style="line-height:1.8;margin:8px 0"></div><label>每日上限 <input data-role="limit" type="number" min="1" max="150" style="width:54px"></label><div style="display:flex;gap:6px;margin-top:10px"><button data-action="toggle"></button><button data-action="stop">急停</button></div>';
        this.element.querySelector('[data-action="toggle"]').addEventListener('click', () => this._toggle());
        this.element.querySelector('[data-action="stop"]').addEventListener('click', () => this.onEmergencyStop());
        this.element.querySelector('[data-role="limit"]').addEventListener('change', (event) => { this.scheduler.dailyLimit = Math.min(150, Math.max(1, Number(event.target.value) || 80)); });
        this.unsubscribe = this.scheduler.subscribe((view) => this.render(view));
        this.root.appendChild(this.element);
        return this;
    }
    _toggle() { return this.scheduler.state === 'running' ? this.scheduler.pause() : (this.scheduler.state === 'paused' ? this.scheduler.resume() : this.scheduler.start()); }
    render(view) {
        if (!this.element) return;
        const { stats, state, dailyLimit } = view;
        this.element.querySelector('[data-role="stats"]').innerHTML = `状态：${state}<br>已投递：${stats.delivered}<br>黑名单跳过：${stats.blacklistSkipped}<br>重复跳过：${stats.duplicateSkipped}<br>当前页：${stats.page || '-'}<br>限额：${stats.delivered}/${dailyLimit}${stats.limitReached ? '（已达）' : ''}`;
        this.element.querySelector('[data-role="limit"]').value = dailyLimit;
        this.element.querySelector('[data-action="toggle"]').textContent = state === 'running' ? '暂停' : '开始';
    }
    destroy() { this.unsubscribe?.(); this.element?.remove(); this.element = null; }
}
if (typeof module !== 'undefined' && module.exports) module.exports = DeliveryPanel;
if (typeof window !== 'undefined') window.DeliveryPanel = DeliveryPanel;
