/**
 * 全能助手悬浮球 (src/ui/fab.js)
 * 
 * 还原原版 job-helper.js 经典悬浮球设计：
 * 1. 经典 48px 圆形盾牌 (🛡️) 悬浮球 (#universal-helper-fab)
 * 2. 点击展开/折叠全能助手主面板
 * 3. 动态状态感知 (结合调度器状态动态切换颜色：运行绿 / 暂停黄 / 熔断红 / 空闲蓝)
 */

class UniversalFab {
    constructor(panelOrScheduler, options = {}) {
        // 兼容两种传参：(panel, { scheduler }) 或 (scheduler, options)
        if (panelOrScheduler && typeof panelOrScheduler.toggle === 'function') {
            this.panel = panelOrScheduler;
            this.scheduler = options.scheduler || null;
        } else {
            this.scheduler = panelOrScheduler || null;
            this.panel = options.panel || null;
        }

        this.root = options.root || (typeof document !== 'undefined' ? document.body : null);
        this.element = null;
        this.unsubscribe = null;
    }

    mount() {
        if (this.element || !this.root) return this;

        const button = this.element = document.createElement('button');
        button.type = 'button';
        button.id = 'universal-helper-fab';
        button.title = '全能助手：点击展开控制面板';
        button.textContent = '🛡️';

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this.panel && typeof this.panel.toggle === 'function') {
                this.panel.toggle();
            } else if (typeof window !== 'undefined' && window.JobHelperPipeline && window.JobHelperPipeline.panel) {
                window.JobHelperPipeline.panel.toggle();
            }
        });

        if (this.scheduler && typeof this.scheduler.subscribe === 'function') {
            this.unsubscribe = this.scheduler.subscribe((view) => this.render(view));
        }

        this.root.appendChild(button);
        return this;
    }

    render({ state } = {}) {
        if (!this.element) return;
        const currentState = state || (this.scheduler ? this.scheduler.state : 'idle');

        this.element.classList.remove('running', 'paused', 'circuit_broken');

        if (currentState === 'running') {
            this.element.classList.add('running');
            this.element.style.background = '#16a34a';
            this.element.title = '🚀 自动投递中 - 点击打开面板';
        } else if (currentState === 'paused') {
            this.element.classList.add('paused');
            this.element.style.background = '#eab308';
            this.element.title = '⏸️ 投递已暂停 - 点击打开面板';
        } else if (currentState === 'circuit_broken') {
            this.element.classList.add('circuit_broken');
            this.element.style.background = '#dc2626';
            this.element.title = '🛑 平台限制/已熔断 - 点击打开面板';
        } else {
            this.element.style.background = '#4285f4';
            this.element.title = '🛡️ 全能助手 - 点击打开面板';
        }
    }

    destroy() {
        if (this.unsubscribe) this.unsubscribe();
        if (this.element) this.element.remove();
        this.element = null;
    }
}

// 兼容别名导出
const SchedulerFab = UniversalFab;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { UniversalFab, SchedulerFab };
}
if (typeof window !== 'undefined') {
    window.UniversalFab = UniversalFab;
    window.SchedulerFab = SchedulerFab;
}
