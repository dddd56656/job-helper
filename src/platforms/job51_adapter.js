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
            '.sensors_exposure_jobitem',
            '[sensorsname="jobitem"]',
            '[sensors_exposure_jobitem]',
            '.job-item',
            '.joblist .item',
            '.j_joblist .e',
            '.el',
            '.job-list-item'
        ];
        this.nameSelectors = options.nameSelectors || [
            '.cname a',
            '.cname',
            'a.cname',
            '.company-name a',
            '.company-name',
            '.com-name',
            '.com_name',
            'a[href*="/company/"]',
            'a[href*="jobs.51job.com/all/co"]',
            'a[href*="51job.com/company"]',
            '[sensorsname="company_name"]',
            '[sensorsname="com_name"]',
            '.t2 a',
            '.er a',
            '.company_name'
        ];
        this.observer = null;
        this.intervalId = null;
        this.scanIntervalMs = options.scanIntervalMs || 500;
    }

    isMatched(host) {
        const targetHost = host || (typeof location !== 'undefined' ? location.host : '');
        return targetHost.includes('51job.com');
    }

    getCompanyName(card) {
        if (!card || typeof card.querySelector !== 'function') return '';
        for (const selector of this.nameSelectors) {
            const el = card.querySelector(selector);
            if (el) {
                const titleAttr = typeof el.getAttribute === 'function' ? el.getAttribute('title') : null;
                const childTitle = (!titleAttr && el.querySelector && typeof el.querySelector === 'function')
                    ? (el.querySelector('[title]')?.getAttribute('title'))
                    : null;
                const text = (titleAttr || childTitle || el.innerText || el.textContent || '').trim();
                const cleaned = text.replace(/[.。…]+$/, '').trim();
                if (cleaned) return cleaned;
            }
        }
        return '';
    }

    updateVisibility(card, blacklist) {
        if (!card) return false;
        const companyName = this.getCompanyName(card) || card.dataset.companyName;
        if (!companyName) return false;
        card.dataset.companyName = companyName;

        const isBlocked = blacklist && typeof blacklist.isBlocked === 'function'
            ? blacklist.isBlocked(companyName, { fuzzy: true })
            : false;

        if (isBlocked) {
            if (!card.classList.contains('universal-blocked')) {
                card.classList.add('universal-blocked');
            }
            if (card.style && typeof card.style.setProperty === 'function') {
                card.style.setProperty('display', 'none', 'important');
            } else if (card.style) {
                card.style.display = 'none';
            }
        } else {
            card.classList.remove('universal-blocked');
            if (card.style && typeof card.style.removeProperty === 'function') {
                if (card.style.display === 'none') {
                    card.style.removeProperty('display');
                }
            } else if (card.style && card.style.display === 'none') {
                card.style.display = '';
            }
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
                const currentDoc = card.ownerDocument || (typeof document !== 'undefined' ? document : null);
                this.refresh(blacklist, currentDoc);
                if (typeof onBlocked === 'function') {
                    onBlocked(companyName);
                }
            }
        };

        bar.appendChild(blockBtn);
        card.appendChild(bar);
    }

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

    refresh(blacklist, root) {
        const doc = root || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;
        const selector = this.cardSelectors.join(',');
        const cards = doc.querySelectorAll(selector);
        cards.forEach(c => this.updateVisibility(c, blacklist));
    }

    initScanner({ blacklist, root, onBlocked } = {}) {
        const doc = root || (typeof document !== 'undefined' ? document : null);
        if (!doc) return;

        const run = () => {
            const selector = this.cardSelectors.join(',');
            const cards = doc.querySelectorAll(selector);
            cards.forEach(c => this.processCard(c, blacklist, onBlocked));
        };

        run();

        const observeTarget = doc.body || doc.documentElement;
        if (typeof MutationObserver !== 'undefined' && observeTarget) {
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
            this.observer.observe(observeTarget, { childList: true, subtree: true });
        }

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
