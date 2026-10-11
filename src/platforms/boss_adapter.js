/**
 * Boss直聘 标准平台适配器 (BossPlatformAdapter)
 *
 * 核心职责：
 * 1. 契约实现：标准化 refresh_jobs(), next_page(), get_page_info(), initContext();
 * 2. 替代 job-helper 原版易卡死的 `u-scroll-bait` 滚轮模拟与假 DOM 元素注入逻辑；
 * 3. 驱动底层 Vue 运行时劫持，调用原生 `pageChangeAction` 或 `searchJobAction` 实现原生无感翻页；
 * 4. 实时解析与双向同步 `jobList`, `pageVo`, `hasMore`。
 */

let BossHooksModule;
if (typeof require !== 'undefined') {
    try {
        BossHooksModule = require('./boss_hooks.js');
    } catch (e) {
        // 环境兼容 fallback
    }
}
if (!BossHooksModule && typeof window !== 'undefined' && window.BossHooks) {
    BossHooksModule = window.BossHooks;
}

class BossPlatformAdapter {
    constructor(options = {}) {
        this.platformKey = 'boss';
        this.selectors = options.selectors || (BossHooksModule && BossHooksModule.DEFAULT_BOSS_JOB_SELECTORS) || '#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main';

        // 运行时状态与数据缓存
        this.jobVue = null;
        this.rawJobList = [];
        this.pageVo = { page: 1, pageSize: 15, total: 0 };
        this.hasMore = true;
        this.pageChangeFn = null;
        this.isInitialized = false;

        // 翻页锁，防止重复并发调用
        this._isNavigating = false;
        // 监听回调列表
        this._subscribers = new Set();
    }

    /**
     * 校验当前页面环境是否匹配 Boss 直聘
     * @returns {boolean}
     */
    isMatched() {
        if (typeof window === 'undefined') return true;
        const host = (window.location && window.location.hostname) || '';
        return /zhipin\.com/.test(host);
    }

    /**
     * 初始化适配器上下文，建立与 Vue 运行时的双向绑定
     * @param {object} [config]
     * @returns {Promise<void>}
     */
    async initContext(config = {}) {
        const hooks = config.hooks || BossHooksModule;
        if (!hooks) {
            throw new Error('未加载 BossHooks 依赖模块');
        }

        const timeout = config.timeout || 20000;

        // 1. 建立对 jobList 的数据劫持
        const hookJobList = hooks.useHookVueData(
            this.selectors,
            'jobList',
            { value: this.rawJobList },
            (newJobList) => {
                this.rawJobList = Array.isArray(newJobList) ? newJobList : [];
                this._notifySubscribers('jobList', this.rawJobList);
            },
            timeout
        );

        // 2. 建立对 pageVo 的数据劫持
        const hookPageVo = hooks.useHookVueData(
            this.selectors,
            'pageVo',
            { value: this.pageVo },
            (newPageVo) => {
                if (newPageVo && typeof newPageVo === 'object') {
                    this.pageVo = { ...this.pageVo, ...newPageVo };
                    this._notifySubscribers('pageVo', this.pageVo);
                }
            },
            timeout
        );

        // 3. 建立对 hasMore 的数据劫持
        const hookHasMore = hooks.useHookVueData(
            this.selectors,
            'hasMore',
            { value: this.hasMore },
            (newHasMore) => {
                this.hasMore = Boolean(newHasMore);
                this._notifySubscribers('hasMore', this.hasMore);
            },
            timeout
        );

        // 并行触发 Vue 实例等待与劫持注册
        const [targetVue] = await Promise.all([
            hookJobList(),
            hookPageVo(),
            hookHasMore()
        ]);
        this.jobVue = targetVue;

        // 4. 识别当前页面类型并提取原生翻页/搜索方法
        await this._initPageChangeFn(hooks, timeout);

        // 5. 自动清理已有的 u-scroll-bait 节点
        this.cleanupScrollBait();

        this.isInitialized = true;
    }

    /**
     * 内部方法：探测并绑定翻页处理函数
     * 区分推荐页 (/web/geek/job-recommend) 与搜索页 (/web/geek/jobs)
     */
    async _initPageChangeFn(hooks, timeout = 20000) {
        const isSearchOrRecommendPath = typeof location !== 'undefined' &&
            (location.href.includes('/web/geek/job-recommend') ||
             location.href.includes('/web/geek/jobs') ||
             location.href.includes('/web/geek/job'));

        // 优先探测搜索/推荐类动作，否则降级为通用 pageChangeAction
        if (isSearchOrRecommendPath) {
            const searchFn = await hooks.useHookVueFn(
                this.selectors,
                ['searchJobAction', 'onSearch', 'pageChangeAction'],
                timeout
            )();
            if (searchFn) {
                this.pageChangeFn = searchFn;
                return;
            }
        }

        // 默认匹配 pageChangeAction，降级候选包括 searchJobAction 与 onSearch
        const changeFn = await hooks.useHookVueFn(
            this.selectors,
            ['pageChangeAction', 'searchJobAction', 'onSearch'],
            timeout
        )();

        if (typeof changeFn === 'function') {
            this.pageChangeFn = changeFn;
        } else {
            throw new Error('未在 Boss Vue 组件上探测到可用的原生翻页方法 (pageChangeAction/searchJobAction/onSearch)');
        }
    }

    /**
     * 刷新并返回结构化的当前页岗位列表
     * @returns {Promise<Array<object>>} 标准岗位对象数组
     */
    async refresh_jobs() {
        if (!this.jobVue) {
            await this.initContext();
        }

        const sourceList = Array.isArray(this.rawJobList) && this.rawJobList.length > 0
            ? this.rawJobList
            : (Array.isArray(this.jobVue?.jobList) ? this.jobVue.jobList : []);

        return sourceList.map((item, index) => this._normalizeJobItem(item, index));
    }

    /**
     * 标准化单个岗位数据项
     * 契约规范：id, securityId, jobName, companyName, salaryDesc, contacted, rawNode 等
     */
    _normalizeJobItem(item, index = 0) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const id = item.encryptJobId || item.jobId || String(item.lid || index);
        const securityId = item.securityId || '';
        const jobName = item.jobName || item.positionName || '';
        const companyName = item.brandName || item.companyName || '';
        const hrName = item.bossName || '';
        const salaryDesc = item.salaryDesc || item.salary || '';
        const contacted = Boolean(item.contact || item.bothTalked);

        // 拼接地理位置
        const cityDistrict = [
            item.cityName,
            item.areaDistrict,
            item.businessDistrict
        ].filter(Boolean).join('-') || item.cityDistrict || '';

        // 尝试映射对应的 DOM 卡片节点（用于高亮、加标或屏蔽）
        const rawNode = this._findJobCardNode(id, item.lid);

        return {
            id,
            securityId,
            jobName,
            companyName,
            hrName,
            salaryDesc,
            cityDistrict,
            contacted,
            rawNode,
            // 扩展原始字段，供更深业务（如技能比对、活跃度评估）使用
            skills: Array.isArray(item.skills) ? item.skills : (item.jobLabels || []),
            jobLabels: Array.isArray(item.jobLabels) ? item.jobLabels : [],
            activeTime: item.lastModifyTime,
            bossTitle: item.bossTitle || '',
            encryptBrandId: item.encryptBrandId || '',
            encryptBossId: item.encryptBossId || '',
            rawData: item
        };
    }

    /**
     * 查找页面对应的 DOM 岗位卡片
     */
    _findJobCardNode(encryptJobId, lid) {
        if (typeof document === 'undefined') return null;

        if (encryptJobId) {
            const link = document.querySelector(`a[href*="${encryptJobId}"]`);
            if (link) {
                const card = link.closest('.job-card-wrapper, .job-card-box, li');
                if (card) return card;
            }
        }

        if (lid) {
            const cardByLid = document.querySelector(`[data-lid="${lid}"]`);
            if (cardByLid) return cardByLid;
        }

        return null;
    }

    /**
     * 获取当前分页信息
     * @returns {{ current: number, pageSize: number, total: number, hasMore: boolean }}
     */
    get_page_info() {
        const page = this.pageVo ? Number(this.pageVo.page || 1) : 1;
        const pageSize = this.pageVo ? Number(this.pageVo.pageSize || 15) : 15;
        const total = this.pageVo ? Number(this.pageVo.total || 0) : 0;
        const hasMore = this.hasMore !== undefined ? Boolean(this.hasMore) : true;

        return {
            current: page,
            pageSize,
            total,
            hasMore
        };
    }

    /**
     * 原生无感切页：直接调用 Vue 内部翻页方法拉取下一页
     * @param {object} [options]
     * @param {number} [options.timeout=10000] 等待新数据到达的超时时间
     * @returns {Promise<boolean>} 是否成功翻到下一页且拿到新数据
     */
    async next_page(options = {}) {
        if (this._isNavigating) {
            return false;
        }

        const pageInfo = this.get_page_info();
        if (!pageInfo.hasMore) {
            return false;
        }

        if (!this.pageChangeFn) {
            await this.initContext();
        }

        if (typeof this.pageChangeFn !== 'function') {
            throw new Error('未就绪的翻页方法');
        }

        this._isNavigating = true;
        const timeout = options.timeout || 10000;
        const targetPage = pageInfo.current + 1;
        const initialFirstId = this.rawJobList[0]?.encryptJobId || '';
        const initialListLength = this.rawJobList.length;

        try {
            // 触发下一页调用
            const callResult = this.pageChangeFn(targetPage);
            if (callResult && typeof callResult.then === 'function') {
                await callResult;
            }

            // 等待数据变化：通过 Vue 响应式 setter 更新或轮询确认
            const updateSuccess = await new Promise((resolve) => {
                const startTime = Date.now();
                const timer = setInterval(() => {
                    const currentFirstId = this.rawJobList[0]?.encryptJobId || '';
                    const currentPage = this.pageVo?.page || 1;

                    // 标志1：页码推进
                    // 标志2：首条岗位变更（常规切页）
                    // 标志3：列表长度改变且非空
                    const hasPageIncremented = currentPage >= targetPage;
                    const hasDataChanged = (currentFirstId !== '' && currentFirstId !== initialFirstId) ||
                        (this.rawJobList.length > 0 && this.rawJobList.length !== initialListLength);

                    if (hasPageIncremented || hasDataChanged) {
                        clearInterval(timer);
                        resolve(true);
                    } else if (Date.now() - startTime >= timeout) {
                        clearInterval(timer);
                        // 超时但如果有 hasMore 变化也可能到底
                        resolve(false);
                    }
                }, 100);
            });

            return updateSuccess;
        } finally {
            this._isNavigating = false;
        }
    }

    /**
     * 替换并彻底消除 job-helper 原版易卡死的 `u-scroll-bait` 滚轮模拟逻辑
     * @param {object} jobHelperLoader 原版 job-helper 的 Loader 模块引用
     * @param {object} [jobHelperState] 原版 job-helper 的 State 模块引用
     */
    replaceScrollLoader(jobHelperLoader, jobHelperState) {
        // 1. 彻底清除注入的假 DOM 节点
        this.cleanupScrollBait();

        if (!jobHelperLoader) return;

        // 2. 废除原有的滚轮与重绘触发，避免引起浏览器卡顿与假死
        jobHelperLoader.triggerTrueReflow = () => {
            // 已由 Vue 响应式更新接管，无需重绘探测
        };
        jobHelperLoader.triggerSmartScroll = () => {
            // 彻底去除滚轮模拟
        };

        // 3. 将原版的 checkAndLoad 替换为原生适配器驱动
        const originalCheck = jobHelperLoader.checkAndLoad;
        jobHelperLoader.checkAndLoad = async () => {
            if (jobHelperState && (jobHelperState.isPaused || jobHelperState.isAutoLoading)) {
                return;
            }

            const pageInfo = this.get_page_info();
            if (!pageInfo.hasMore) {
                if (jobHelperState) jobHelperState.hasReachedLimit = true;
                return;
            }

            if (jobHelperState) jobHelperState.isAutoLoading = true;
            try {
                await this.next_page();
            } finally {
                if (jobHelperState) jobHelperState.isAutoLoading = false;
            }
        };

        return originalCheck;
    }

    /**
     * 查找并移除页面中的 `#u-scroll-bait` 元素
     */
    cleanupScrollBait() {
        if (typeof document === 'undefined') return;
        const bait = document.getElementById('u-scroll-bait');
        if (bait && bait.parentNode) {
            bait.parentNode.removeChild(bait);
        }
    }

    /**
     * 订阅适配器数据变化
     */
    subscribe(callback) {
        if (typeof callback === 'function') {
            this._subscribers.add(callback);
            return () => this._subscribers.delete(callback);
        }
        return () => {};
    }

    _notifySubscribers(type, data) {
        for (const cb of this._subscribers) {
            try {
                cb(type, data);
            } catch (err) {
                // 捕获回调异常，避免阻塞适配器
            }
        }
    }
}

// 统一导出兼容 Node.js (CommonJS) / ES Module / 浏览器环境
if (typeof module !== 'undefined' && module.exports) {
    module.exports = BossPlatformAdapter;
}
if (typeof window !== 'undefined') {
    window.BossPlatformAdapter = BossPlatformAdapter;
}
