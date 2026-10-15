/**
 * 51job (前程无忧) 平台适配器 (src/platforms/job51_adapter.js)
 * 
 * 完整保留原版 job-helper.js 对前程无忧的核心支持：
 * 1. 站点识别 (51job.com 各子域名)
 * 2. 岗位卡片 DOM 扫描器 (MutationObserver + 定时器兜底)
 * 3. 公司名称准确提取
 * 4. 岗位卡片内联注入“🚫 屏蔽”操作按钮
 * 5. 命中黑名单卡片自动添加 .universal-blocked 样式隐藏
 */

class Job51Adapter {
    constructor(options = {}) {
        this.cardSelectors = options.cardSelectors || [
            '.joblist-item',
            '.j_joblist .e',
            '.el',
            '.job-list-item'
        ];
        this.nameSelectors = options.nameSelectors || [
            '.cname a',
            '.cname',
            '.t2 a',
            '.er a',
            '.company_name'
        ];
        this.observer = null;
        this.intervalId = null;
        this.scanIntervalMs = options.scanIntervalMs || 500;
    }

    /**
     * 判断当前是否为前程无忧站点
     * @param {string} [host]
     * @returns {boolean}
     */
    isMatched(host) {
        const targetHost = host || (typeof location !== 'undefined' ? location.host : '');
        return targetHost.includes('51job.com');
    }

    /**
     * 从卡片 DOM 中提取公司名称
     * @param {Element} card
     * @returns {string}
     */
    getCompanyName(card) {
        if (!card || typeof card.querySelector !== 'function') return '';
        for (const selector of this.nameSelectors) {
            const el = card.querySelector(selector);
            if (el) {
                const text = (el.innerText || el.textContent || '').trim();
                if (text) return text;
            }
        }
        return '';
    }

    /**
     * 更新卡片显隐状态
     * @param {Element} card
     * @param {Object} blacklist - BlacklistEngine 实例
     * @returns {boolean} 是否被屏蔽
     */
    updateVisibility(card, blacklist) {
        if (!card) return false;
        const companyName = card.dataset.companyName || this.getCompanyName(card);
        if (!companyName) return false;
        card.dataset.companyName = companyName;

        const isBlocked = blacklist && typeof blacklist.isBlocked === 'function'
            ? blacklist.isBlocked(companyName)
            : false;

        if (isBlocked) {
            if (!card.classList.contains('universal-blocked')) {
                card.classList.add('universal-blocked');
            }
        } else {
            card.classList.remove('universal-blocked');
        }
        return isBlocked;
    }

    /**
     * 为岗位卡片注入内联“🚫 屏蔽”操作按钮
     * @param {Element} card
     * @param {string} companyName
     * @param {Object} blacklist
     * @param {Function} [onBlocked]
     */
    injectActionBar(card, companyName, blacklist, onBlocked) {
        if (!card || typeof card.querySelector !== 'function') return;
        if (card.querySelector('.boss-action-bar')) return;

        if (typeof window !== 'undefined' && window.getComputedStyle) {
            try {
                if (window.getComputedStyle(card).position === 'static') {
                    card.style.position = 'relative';
                }
            } catch (_) {}
        }

        const doc = card.ownerDocument || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;

        const bar = doc.createElement('div');
        bar.className = 'boss-action-bar';

        const blockBtn = doc.createElement('div');
        blockBtn.className = 'boss-action-btn boss-btn-block';
        blockBtn.innerText = '🚫 屏蔽';
        blockBtn.setAttribute('title', `屏蔽公司【${companyName}】`);

        blockBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            const confirmed = typeof confirm === 'function'
                ? confirm(`确定要将【${companyName}】加入黑名单并隐藏吗？`)
                : true;

            if (confirmed) {
                if (blacklist && typeof blacklist.addCompany === 'function') {
                    blacklist.addCompany(companyName);
                }
                this.updateVisibility(card, blacklist);
                if (typeof onBlocked === 'function') {
                    onBlocked(companyName);
                }
            }
        };

        bar.appendChild(blockBtn);
        card.appendChild(bar);
    }

    /**
     * 处理单张卡片：提取名称、注入按钮、更新显隐
     * @param {Element} card
     * @param {Object} blacklist
     * @param {Function} [onBlocked]
     */
    processCard(card, blacklist, onBlocked) {
        if (!card || typeof card.querySelector !== 'function') return;
        if (card.dataset.uProcessed === 'true') {
            this.updateVisibility(card, blacklist);
            return;
        }

        const companyName = this.getCompanyName(card);
        if (!companyName) return;

        card.dataset.companyName = companyName;
        this.injectActionBar(card, companyName, blacklist, onBlocked);
        this.updateVisibility(card, blacklist);
        card.dataset.uProcessed = 'true';
    }

    /**
     * 刷新当前页面所有已渲染卡片显隐
     * @param {Object} blacklist
     * @param {Element} [root]
     */
    refresh(blacklist, root) {
        const doc = root || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;
        const selector = this.cardSelectors.join(',');
        const cards = doc.querySelectorAll(selector);
        cards.forEach(c => this.updateVisibility(c, blacklist));
    }

    /**
     * 启动 DOM 监听扫描器
     * @param {Object} config
     * @param {Object} config.blacklist
     * @param {Element} [config.root]
     * @param {Function} [config.onBlocked]
     */
    initScanner({ blacklist, root, onBlocked } = {}) {
        const doc = root || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;

        const run = () => {
            const selector = this.cardSelectors.join(',');
            const cards = doc.querySelectorAll(selector);
            cards.forEach(c => this.processCard(c, blacklist, onBlocked));
        };

        // 首次立即执行
        run();

        // MutationObserver 监听动态插入卡片
        if (typeof MutationObserver !== 'undefined' && doc.body) {
            this.observer = new MutationObserver((mutations) => {
                let shouldRun = false;
                for (const m of mutations) {
                    if (m.addedNodes && m.addedNodes.length > 0) {
                        shouldRun = true;
                        break;
                    }
                }
                if (shouldRun) run();
            });
            this.observer.observe(doc.body, { childList: true, subtree: true });
        }

        // 定时轮询兜底
        if (typeof setInterval !== 'undefined') {
            this.intervalId = setInterval(run, this.scanIntervalMs);
        }

        return () => this.destroy();
    }

    destroy() {
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Job51Adapter;
}
if (typeof window !== 'undefined') {
    window.Job51Adapter = Job51Adapter;
}
