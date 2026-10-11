class SchedulerFab {
    constructor(scheduler, options = {}) { this.scheduler = scheduler; this.root = options.root || document.body; this.element = null; this.unsubscribe = null; }
    mount() {
        if (this.element) return this;
        const button = this.element = document.createElement('button');
        button.type = 'button'; button.title = 'Job Helper：点击急停'; button.textContent = 'JD';
        button.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;width:48px;height:48px;border:0;border-radius:50%;color:#fff;font-weight:700;box-shadow:0 4px 12px #0004;cursor:pointer';
        button.addEventListener('click', () => this.scheduler.stop('Emergency stop from floating control'));
        this.unsubscribe = this.scheduler.subscribe((view) => this.render(view)); this.root.appendChild(button); return this;
    }
    render({ state }) { if (this.element) this.element.style.background = state === 'running' ? '#16a34a' : state === 'paused' ? '#eab308' : state === 'circuit_broken' ? '#dc2626' : '#64748b'; }
    destroy() { this.unsubscribe?.(); this.element?.remove(); this.element = null; }
}
if (typeof module !== 'undefined' && module.exports) module.exports = SchedulerFab;
if (typeof window !== 'undefined') window.SchedulerFab = SchedulerFab;
