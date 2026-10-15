/**
 * 全能助手统一入口 (src/entry.js)
 * 
 * 1. 初始化跨平台共享黑名单引擎 (Key: universal_job_blacklist)
 * 2. 识别宿主环境并自动挂载对应平台能力：
 *    - 前程无忧 (51job.com): DOM 实时卡片扫描 + 悬浮“🚫 屏蔽”操作条 + 全能助手管理面板
 *    - BOSS直聘 (zhipin.com): 共享黑名单 + 岗位卡片内联屏蔽 + Vue Hook 翻页劫持 + 全链路自动化投递调度器 + 实时监控面板与变色悬浮球
 * 3. 跨标签页、跨平台黑名单数据实时双向响应
 */

(function bootstrap() {
    if (typeof window === 'undefined') return;

    // 1. 初始化全局共享黑名单单例
    const BlacklistClass = window.BlacklistEngine || (typeof require !== 'undefined' ? require('./core/blacklist.js').BlacklistEngine : null);
    const blacklist = window.blacklist || (BlacklistClass ? new BlacklistClass() : null);
    if (!window.blacklist && blacklist) window.blacklist = blacklist;

    const host = window.location ? window.location.host : '';
    const isBoss = host.includes('zhipin.com');
    const is51Job = host.includes('51job.com');

    // 2. 前程无忧 (51job) 运行环境
    if (is51Job) {
        const Job51Class = window.Job51Adapter || (typeof require !== 'undefined' ? require('./platforms/job51_adapter.js') : null);
        const adapter = Job51Class ? new Job51Class() : null;

        const panel = new window.UniversalPanel(null, { blacklist }).mount();
        const fab = new window.UniversalFab(panel).mount();

        if (adapter && blacklist) {
            adapter.initScanner({
                blacklist,
                onBlocked: (name) => {
                    panel.renderBlacklist();
                    panel.showToast(`已屏蔽【${name}】并隐藏卡片`, 2000);
                }
            });

            // 监听跨标签页变更，实时重绘当前页面卡片显隐
            blacklist.subscribe(() => {
                adapter.refresh(blacklist);
            });
        }

        window.JobHelperPipeline = { blacklist, adapter, panel, fab, platform: '51job' };
        console.log('[JobHelper] 前程无忧平台适配完成，黑名单实时互通已激活');
        return;
    }

    // 3. BOSS直聘 (zhipin.com) 运行环境
    if (isBoss) {
        const scheduler = window.DeliveryScheduler ? new window.DeliveryScheduler({ blacklist }) : null;
        if (scheduler?.chatManager && typeof scheduler.chatManager.connect === 'function') {
            scheduler.chatManager.connect().catch((e) => {
                console.warn('[JobHelper] 高级打招呼通道长连接预热提示:', e?.message || e);
            });
        }
        const panel = new window.UniversalPanel(scheduler, { blacklist }).mount();
        const fab = new window.UniversalFab(panel, { scheduler }).mount();

        // 为 BOSS 直聘卡片同样挂载内联“🚫 屏蔽”交互与自动隐藏
        const bossCardSelectors = ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'];
        const bossNameSelectors = ['.boss-name', '.company-name a', '.company-name', '.job-company span.company-text', '.company-text h3'];

        const processBossCard = (card) => {
            if (!card || card.dataset.uProcessed === 'true') {
                updateBossCardVisibility(card);
                return;
            }
            let companyName = '';
            for (const sel of bossNameSelectors) {
                const el = card.querySelector(sel);
                if (el && el.innerText) { companyName = el.innerText.trim(); break; }
            }
            if (!companyName) return;
            card.dataset.companyName = companyName;

            // 注入内联屏蔽按钮
            if (!card.querySelector('.boss-action-bar')) {
                if (window.getComputedStyle(card).position === 'static') card.style.position = 'relative';
                const bar = document.createElement('div');
                bar.className = 'boss-action-bar';
                const btn = document.createElement('div');
                btn.className = 'boss-action-btn boss-btn-block';
                btn.innerText = '🚫 屏蔽';
                btn.title = `屏蔽【${companyName}】`;
                btn.onclick = (e) => {
                    e.stopPropagation(); e.preventDefault();
                    if (confirm(`确定要将【${companyName}】加入黑名单并隐藏吗？`)) {
                        blacklist.addCompany(companyName);
                        updateBossCardVisibility(card);
                        panel.renderBlacklist();
                        panel.showToast(`已屏蔽【${companyName}】`, 2000);
                    }
                };
                bar.appendChild(btn);
                card.appendChild(bar);
            }

            updateBossCardVisibility(card);
            card.dataset.uProcessed = 'true';
        };

        const updateBossCardVisibility = (card) => {
            const name = card.dataset.companyName;
            if (!name) return;
            if (blacklist && blacklist.isBlocked(name)) {
                card.classList.add('universal-blocked');
            } else {
                card.classList.remove('universal-blocked');
            }
        };

        const scanBossCards = () => {
            document.querySelectorAll(bossCardSelectors.join(',')).forEach(processBossCard);
        };

        scanBossCards();
        const obs = new MutationObserver((mutations) => {
            let shouldRun = false;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) { shouldRun = true; break; }
            }
            if (shouldRun) scanBossCards();
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setInterval(scanBossCards, 600);

        // 监听跨标签页变更，实时更新卡片显隐
        if (blacklist) {
            blacklist.subscribe(() => {
                document.querySelectorAll(bossCardSelectors.join(',')).forEach(updateBossCardVisibility);
            });
        }

        window.JobHelperPipeline = { blacklist, scheduler, panel, fab, platform: 'boss' };
        console.log('[JobHelper] BOSS直聘平台适配完成，全链路自动投递调度器已就绪');
        return;
    }

    // 4. 其他兜底环境 (直接挂载管理面板)
    const panel = new window.UniversalPanel(null, { blacklist }).mount();
    const fab = new window.UniversalFab(panel).mount();
    window.JobHelperPipeline = { blacklist, panel, fab, platform: 'generic' };
})();
