// ==UserScript==
// @name         Job Helper Delivery Pipeline
// @namespace    https://github.com/job-helper
// @version      1.0.0
// @description  Blacklist-aware BOSS job delivery assistant
// @match        https://www.zhipin.com/web/geek/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

/* src/core/blacklist.js */
;(function () {
/**
 * Blacklist Engine (src/core/blacklist.js)
 *
 * High-performance, O(1) in-memory Set cache backed by GM_getValue / GM_setValue persistence.
 * Provides pre-flight fast filtering to achieve "zero network request skipping" for blacklisted employers.
 *
 * Upgraded from original job-helper Storage module with backward compatibility.
 */

const STORAGE_KEY_DEFAULT = 'universal_job_blacklist';

class BlacklistEngine {
    /**
     * @param {Object} [options]
     * @param {string} [options.storageKey] - GM_getValue key
     * @param {boolean} [options.enableFuzzy] - default fuzzy match flag
     * @param {Object} [options.storageProvider] - custom { get: (key, def) => val, set: (key, val) => void }
     */
    constructor(options = {}) {
        this.storageKey = options.storageKey || STORAGE_KEY_DEFAULT;
        this.enableFuzzy = !!options.enableFuzzy;
        this.cache = new Set();
        this.initialized = false;
        this.storageProvider = options.storageProvider || null;

        // Auto-initialize
        this.init();
    }

    /**
     * Resolve GM or custom storage provider
     * @private
     */
    _getStorage() {
        if (this.storageProvider) {
            return this.storageProvider;
        }

        const hasGMGet = typeof GM_getValue === 'function';
        const hasGMSet = typeof GM_setValue === 'function';

        if (hasGMGet && hasGMSet) {
            return {
                get: (key, def) => GM_getValue(key, def),
                set: (key, val) => GM_setValue(key, val)
            };
        }

        // Global window fallback for UserScript environments
        if (typeof window !== 'undefined' && typeof window.GM_getValue === 'function' && typeof window.GM_setValue === 'function') {
            return {
                get: (key, def) => window.GM_getValue(key, def),
                set: (key, val) => window.GM_setValue(key, val)
            };
        }

        // In-memory fallback (e.g. Node.js testing without mock)
        if (!this._memoryStorage) {
            this._memoryStorage = new Map();
        }
        return {
            get: (key, def) => (this._memoryStorage.has(key) ? this._memoryStorage.get(key) : def),
            set: (key, val) => this._memoryStorage.set(key, val)
        };
    }

    /**
     * Set custom storage provider (e.g. for testing or localStorage adaptation)
     * @param {{ get: Function, set: Function } | null} provider
     */
    setStorageProvider(provider) {
        this.storageProvider = provider;
        this.initialized = false;
        this.init();
    }

    /**
     * Initialize / re-sync cache from persistent storage
     */
    init() {
        try {
            const storage = this._getStorage();
            const rawList = storage.get(this.storageKey, []);
            if (Array.isArray(rawList)) {
                this.cache = new Set(
                    rawList
                        .filter(item => typeof item === 'string')
                        .map(item => this.normalize(item))
                        .filter(Boolean)
                );
            } else {
                this.cache = new Set();
            }
            this.initialized = true;
        } catch (e) {
            console.error('[BlacklistEngine] Failed to initialize storage:', e);
            if (!this.cache) this.cache = new Set();
            this.initialized = true;
        }
    }

    /**
     * Persist current in-memory cache to underlying storage
     */
    persist() {
        try {
            const storage = this._getStorage();
            storage.set(this.storageKey, Array.from(this.cache));
        } catch (e) {
            console.error('[BlacklistEngine] Failed to persist blacklist:', e);
        }
    }

    /**
     * Get snapshot array of all blacklisted companies
     * @returns {string[]}
     */
    getBlacklist() {
        if (!this.initialized) this.init();
        return Array.from(this.cache);
    }

    /**
     * Check if a company name is blocked
     * @param {string} companyName - Target company name
     * @param {Object} [options]
     * @param {boolean} [options.fuzzy] - Whether to perform fuzzy substring matching
     * @returns {boolean}
     */
    isBlocked(companyName, options = {}) {
        if (!companyName || typeof companyName !== 'string') return false;
        if (!this.initialized) this.init();

        const trimmed = this.normalize(companyName);
        if (!trimmed) return false;

        // Fast-path: O(1) exact match
        if (this.cache.has(trimmed)) {
            return true;
        }

        const useFuzzy = typeof options.fuzzy === 'boolean' ? options.fuzzy : this.enableFuzzy;
        if (useFuzzy && this.cache.size > 0) {
            const lowerTarget = trimmed.toLowerCase();
            for (const item of this.cache) {
                const lowerItem = item.toLowerCase();
                if (lowerTarget.includes(lowerItem) || lowerItem.includes(lowerTarget)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Add a company to blacklist
     * @param {string} companyName
     * @returns {boolean} True if newly added, false if already present or invalid
     */
    addCompany(companyName) {
        if (!companyName || typeof companyName !== 'string') return false;
        if (!this.initialized) this.init();

        const trimmed = this.normalize(companyName);
        if (!trimmed) return false;

        if (!this.cache.has(trimmed)) {
            this.cache.add(trimmed);
            this.persist();
            return true;
        }
        return false;
    }

    /**
     * Remove a company from blacklist
     * @param {string} companyName
     * @returns {boolean} True if removed, false if not found
     */
    removeCompany(companyName) {
        if (!companyName || typeof companyName !== 'string') return false;
        if (!this.initialized) this.init();

        const trimmed = this.normalize(companyName);
        if (this.cache.delete(trimmed)) {
            this.persist();
            return true;
        }
        return false;
    }

    /**
     * Clear all blacklist records
     */
    clear() {
        this.cache.clear();
        this.persist();
    }

    /**
     * Number of blacklisted items
     * @returns {number}
     */
    get size() {
        if (!this.initialized) this.init();
        return this.cache.size;
    }

    normalize(companyName) {
        return String(companyName || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '').trim();
    }

    /**
     * High-throughput pre-flight batch filter.
     * Segregates jobs into allowed and blocked lists without any network calls.
     *
     * Supports job objects with `companyName`, `brandName`, `company`, or raw string company names.
     *
     * @param {Array<Object|string>} jobs
     * @param {Object} [options]
     * @param {boolean} [options.fuzzy]
     * @returns {{ allowed: any[], blocked: any[] }}
     */
    batchFilter(jobs, options = {}) {
        if (!Array.isArray(jobs) || jobs.length === 0) {
            return { allowed: [], blocked: [] };
        }

        if (!this.initialized) this.init();

        const allowed = [];
        const blocked = [];

        for (let i = 0; i < jobs.length; i++) {
            const job = jobs[i];
            let company = '';

            if (typeof job === 'string') {
                company = job;
            } else if (job && typeof job === 'object') {
                company = job.companyName || job.brandName || job.company || '';
            }

            const identifiers = typeof job === 'object' && job !== null
                ? [company, job.encryptBrandId, job.brandId].filter(Boolean)
                : [company];
            if (identifiers.some((identifier) => this.isBlocked(identifier, options))) {
                blocked.push(job);
            } else {
                allowed.push(job);
            }
        }

        return { allowed, blocked };
    }

    /**
     * Import JSON string or Array of strings
     * @param {string|Array<string>} data
     * @returns {{ success: boolean, count: number, total: number, error?: string }}
     */
    importData(data) {
        try {
            let list = data;
            if (typeof data === 'string') {
                list = JSON.parse(data);
            }

            if (!Array.isArray(list)) {
                return { success: false, count: 0, total: this.cache.size, error: 'Data must be an array' };
            }

            if (!this.initialized) this.init();

            let addedCount = 0;
            for (const item of list) {
                if (item && typeof item === 'string') {
                    const trimmed = item.trim();
                    if (trimmed && !this.cache.has(trimmed)) {
                        this.cache.add(trimmed);
                        addedCount++;
                    }
                }
            }

            if (addedCount > 0) {
                this.persist();
            }

            return {
                success: true,
                count: addedCount,
                total: this.cache.size
            };
        } catch (e) {
            return {
                success: false,
                count: 0,
                total: this.cache.size,
                error: e.message || 'JSON parse error'
            };
        }
    }

    /**
     * Export data as array
     * @returns {string[]}
     */
    exportData() {
        return this.getBlacklist();
    }
}

// Default singleton instance
const blacklistInstance = new BlacklistEngine();

/**
 * Backward-compatible Storage adapter matching job-helper original API
 */
const Storage = {
    get cache() { return blacklistInstance.cache; },
    get initialized() { return blacklistInstance.initialized; },
    init: () => blacklistInstance.init(),
    getBlacklist: () => blacklistInstance.getBlacklist(),
    addCompany: (name) => blacklistInstance.addCompany(name),
    removeCompany: (name) => blacklistInstance.removeCompany(name),
    isBlocked: (name, options) => blacklistInstance.isBlocked(name, options),
    batchFilter: (jobs, options) => blacklistInstance.batchFilter(jobs, options),
    persist: () => blacklistInstance.persist(),
    importData: (jsonString) => blacklistInstance.importData(jsonString),
    clear: () => blacklistInstance.clear(),
    get size() { return blacklistInstance.size; },
    setStorageProvider: (provider) => blacklistInstance.setStorageProvider(provider)
};

// Export for CommonJS, ES Module, and Browser global environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        BlacklistEngine,
        blacklist: blacklistInstance,
        Storage,
        default: blacklistInstance
    };
}

if (typeof window !== 'undefined') {
    window.BlacklistEngine = BlacklistEngine;
    window.blacklist = blacklistInstance;
    window.Storage = Storage;
}

})();

/* src/core/rate_limiter.js */
;(function () {
/**
 * Adaptive Rate Limiter & Jittered Delay (src/core/rate_limiter.js)
 *
 * Provides human-like timing variations using Box-Muller Gaussian jitter.
 * Extracted and standardized from boss-helper anti-ban guidelines:
 *  - Single delivery interval: 2,000ms ~ 5,000ms (Gaussian mean ~3,500ms)
 *  - Page navigation buffer: 10,000ms ~ 25,000ms (Gaussian mean ~17,500ms)
 *  - Batch rest interval: Every 10 deliveries, force rest for 30,000ms (30s)
 */

/**
 * Default timing configurations (in milliseconds)
 */
const RATE_LIMIT_CONFIG = {
    // Single delivery interval (2s ~ 5s)
    DELIVERY_INTERVAL: {
        min: 2000,
        max: 5000,
        name: 'delivery_interval'
    },
    // Page change / browsing buffer (10s ~ 25s)
    PAGE_WAIT: {
        min: 10000,
        max: 25000,
        name: 'page_wait'
    },
    // Batch resting interval (every 10 jobs rest 30s)
    BATCH_REST: {
        intervalCount: 10,
        durationMs: 30000,
        min: 29000,
        max: 31000,
        name: 'batch_rest'
    }
};

/**
 * Generate a standard Gaussian (normal) random number using Box-Muller transform
 * @param {number} mean
 * @param {number} stdDev
 * @returns {number}
 */
function gaussianRandom(mean = 0, stdDev = 1) {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random(); // Converting [0, 1) to (0, 1)
    while (v === 0) v = Math.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z0 * stdDev + mean;
}

/**
 * Calculate jittered delay within [minMs, maxMs] using Gaussian perturbation
 * (3-sigma rule: ~99.73% of values naturally fall into [minMs, maxMs])
 *
 * @param {number} minMs - Minimum milliseconds
 * @param {number} maxMs - Maximum milliseconds
 * @returns {number} Clamped integer milliseconds
 */
function calculateGaussianJitter(minMs, maxMs) {
    if (minMs >= maxMs) return Math.round(minMs);
    const mean = (minMs + maxMs) / 2;
    const stdDev = (maxMs - minMs) / 6;
    const rawValue = gaussianRandom(mean, stdDev);
    return Math.min(maxMs, Math.max(minMs, Math.round(rawValue)));
}

/**
 * High-precision jittered sleep function with Gaussian perturbation
 * Supports cancellation via AbortSignal or custom isStopped predicate.
 *
 * @param {number} minMs - Minimum delay in milliseconds
 * @param {number} maxMs - Maximum delay in milliseconds
 * @param {Object} [options]
 * @param {AbortSignal} [options.signal] - AbortController signal
 * @param {() => boolean} [options.isStopped] - Stop predicate function (e.g. from UI pause)
 * @param {(remainingMs: number, totalMs: number) => void} [options.onProgress] - Optional progress callback
 * @returns {Promise<number>} Resolves with the actual milliseconds slept
 */
function randomSleep(minMs, maxMs, options = {}) {
    const targetMs = calculateGaussianJitter(minMs, maxMs);
    const { signal, isStopped, onProgress } = options;

    if (signal && signal.aborted) {
        return Promise.reject(new Error('Sleep aborted'));
    }
    if (typeof isStopped === 'function' && isStopped()) {
        return Promise.reject(new Error('Sleep stopped by controller'));
    }

    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        let timerId = null;
        let progressIntervalId = null;

        const cleanup = () => {
            if (timerId !== null) clearTimeout(timerId);
            if (progressIntervalId !== null) clearInterval(progressIntervalId);
            if (signal) signal.removeEventListener('abort', handleAbort);
        };

        const handleAbort = () => {
            cleanup();
            reject(new Error('Sleep aborted'));
        };

        if (signal) {
            signal.addEventListener('abort', handleAbort);
        }

        if (typeof onProgress === 'function') {
            const checkInterval = 200;
            progressIntervalId = setInterval(() => {
                if (typeof isStopped === 'function' && isStopped()) {
                    cleanup();
                    reject(new Error('Sleep stopped by controller'));
                    return;
                }
                const elapsed = Date.now() - startTime;
                const remaining = Math.max(0, targetMs - elapsed);
                onProgress(remaining, targetMs);
            }, checkInterval);
        }

        timerId = setTimeout(() => {
            cleanup();
            if (typeof isStopped === 'function' && isStopped()) {
                reject(new Error('Sleep stopped by controller'));
            } else {
                resolve(targetMs);
            }
        }, targetMs);
    });
}

/**
 * Sleep for standard single delivery interval (2s ~ 5s)
 * @param {Object} [options]
 * @returns {Promise<number>}
 */
function sleepDelivery(options = {}) {
    return randomSleep(RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.min, RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.max, options);
}

/**
 * Sleep for standard page change browsing interval (10s ~ 25s)
 * @param {Object} [options]
 * @returns {Promise<number>}
 */
function sleepPageNext(options = {}) {
    return randomSleep(RATE_LIMIT_CONFIG.PAGE_WAIT.min, RATE_LIMIT_CONFIG.PAGE_WAIT.max, options);
}

/**
 * Sleep for standard batch resting duration (30s ± 1s Gaussian jitter)
 * @param {Object} [options]
 * @returns {Promise<number>}
 */
function sleepBatchRest(options = {}) {
    return randomSleep(RATE_LIMIT_CONFIG.BATCH_REST.min, RATE_LIMIT_CONFIG.BATCH_REST.max, options);
}

/**
 * Stateful Adaptive Rate Limiter to coordinate delivery frequency and cooldowns
 */
class AdaptiveRateLimiter {
    /**
     * @param {Object} [customConfig]
     */
    constructor(customConfig = {}) {
        this.config = {
            delivery: {
                min: customConfig.deliveryMin || RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.min,
                max: customConfig.deliveryMax || RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.max
            },
            pageWait: {
                min: customConfig.pageWaitMin || RATE_LIMIT_CONFIG.PAGE_WAIT.min,
                max: customConfig.pageWaitMax || RATE_LIMIT_CONFIG.PAGE_WAIT.max
            },
            batchRest: {
                intervalCount: customConfig.batchInterval || RATE_LIMIT_CONFIG.BATCH_REST.intervalCount,
                min: customConfig.batchRestMin || RATE_LIMIT_CONFIG.BATCH_REST.min,
                max: customConfig.batchRestMax || RATE_LIMIT_CONFIG.BATCH_REST.max,
                durationMs: customConfig.batchDuration || RATE_LIMIT_CONFIG.BATCH_REST.durationMs
            }
        };

        this.deliveryCount = 0;
        this.totalSleptMs = 0;
    }

    /**
     * Call after each delivery action.
     * Automatically triggers 30s batch rest every 10 deliveries, or standard 2~5s interval.
     *
     * @param {Object} [options]
     * @param {Function} [options.onBatchRest] - Callback when entering batch rest (count, durationMs)
     * @param {AbortSignal} [options.signal]
     * @param {Function} [options.isStopped]
     * @returns {Promise<{ isBatchRest: boolean, delayMs: number, deliveryCount: number }>}
     */
    async afterDelivery(options = {}) {
        this.deliveryCount++;
        const isBatchRest = (this.deliveryCount % this.config.batchRest.intervalCount === 0);

        let delayMs = 0;
        if (isBatchRest) {
            if (typeof options.onBatchRest === 'function') {
                options.onBatchRest(this.deliveryCount, this.config.batchRest.durationMs);
            }
            delayMs = await randomSleep(this.config.batchRest.min, this.config.batchRest.max, options);
        } else {
            delayMs = await randomSleep(this.config.delivery.min, this.config.delivery.max, options);
        }

        this.totalSleptMs += delayMs;
        return {
            isBatchRest,
            delayMs,
            deliveryCount: this.deliveryCount
        };
    }

    /**
     * Call when moving to the next page
     * @param {Object} [options]
     * @returns {Promise<number>} Delay milliseconds
     */
    async afterPageChange(options = {}) {
        const delayMs = await randomSleep(this.config.pageWait.min, this.config.pageWait.max, options);
        this.totalSleptMs += delayMs;
        return delayMs;
    }

    /**
     * Reset delivery counter
     */
    resetCount() {
        this.deliveryCount = 0;
    }

    /**
     * Get current delivery count
     * @returns {number}
     */
    getDeliveryCount() {
        return this.deliveryCount;
    }
}

// Default singleton
const defaultLimiter = new AdaptiveRateLimiter();

// Export for CommonJS, ES Module, and Browser global
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        RATE_LIMIT_CONFIG,
        gaussianRandom,
        calculateGaussianJitter,
        randomSleep,
        sleepDelivery,
        sleepPageNext,
        sleepBatchRest,
        AdaptiveRateLimiter,
        rateLimiter: defaultLimiter,
        default: defaultLimiter
    };
}

if (typeof window !== 'undefined') {
    window.RATE_LIMIT_CONFIG = RATE_LIMIT_CONFIG;
    window.randomSleep = randomSleep;
    window.sleepDelivery = sleepDelivery;
    window.sleepPageNext = sleepPageNext;
    window.sleepBatchRest = sleepBatchRest;
    window.AdaptiveRateLimiter = AdaptiveRateLimiter;
    window.rateLimiter = defaultLimiter;
}

})();

/* src/platforms/boss_hooks.js */
;(function () {
/**
 * Boss直聘 Vue 2 运行时探测与劫持工具
 *
 * 核心职责：
 * 1. 纯原生 JavaScript 实现，完全剥离 Vue 3 (Ref / toValue) 依赖；
 * 2. 稳定探测页面 `#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main` 等容器上的 `.__vue__` 实例；
 * 3. 抽取与拦截 `jobList`, `pageVo`, `hasMore` 等核心响应式数据；
 * 4. 抽取 `pageChangeAction`（推荐页）与 `searchJobAction` / `onSearch`（搜索页）原生翻页方法。
 */

// 默认探测容器选择器列表
const DEFAULT_BOSS_JOB_SELECTORS = '#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main';
const DEFAULT_BOSS_ROOT_SELECTOR = '#wrap';

// 根 Vue 实例内存缓存
let cachedRootVue = null;

/**
 * 轮询等待 DOM 元素挂载
 * @param {string} selectors CSS选择器
 * @param {number} [timeout=20000] 超时时间（毫秒）
 * @param {number} [interval=50] 轮询间隔（毫秒）
 * @returns {Promise<Element>}
 */
function waitForElement(selectors, timeout = 20000, interval = 50) {
    return new Promise((resolve, reject) => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) {
            return reject(new Error('当前环境缺少 document 全局对象'));
        }

        const immediate = doc.querySelector(selectors);
        if (immediate) {
            return resolve(immediate);
        }

        const startTime = Date.now();
        const timer = setInterval(() => {
            const el = doc.querySelector(selectors);
            if (el) {
                clearInterval(timer);
                resolve(el);
            } else if (Date.now() - startTime >= timeout) {
                clearInterval(timer);
                reject(new Error(`未找到对应元素: ${selectors}`));
            }
        }, interval);
    });
}

/**
 * 轮询等待包含 `.__vue__` 实例的 DOM 节点
 * @param {string} selectors CSS选择器
 * @param {number} [timeout=20000] 超时时间（毫秒）
 * @param {number} [interval=50] 轮询间隔（毫秒）
 * @returns {Promise<any>} 返回 Vue 2 组件实例
 */
function waitForVueInstance(selectors, timeout = 20000, interval = 50) {
    return new Promise((resolve, reject) => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) {
            return reject(new Error('当前环境缺少 document 全局对象'));
        }

        const immediate = doc.querySelector(selectors);
        if (immediate && immediate.__vue__) {
            return resolve(immediate.__vue__);
        }

        const startTime = Date.now();
        const timer = setInterval(() => {
            const el = doc.querySelector(selectors);
            if (el && el.__vue__) {
                clearInterval(timer);
                resolve(el.__vue__);
            } else if (Date.now() - startTime >= timeout) {
                clearInterval(timer);
                reject(new Error(`未在元素 [${selectors}] 上找到 Vue 实例`));
            }
        }, interval);
    });
}

/**
 * 获取 Boss 直聘全局根 Vue 实例 (#wrap.__vue__)
 * @param {number} [timeout=20000]
 * @returns {Promise<any>}
 */
async function getRootVue(timeout = 20000) {
    if (cachedRootVue) {
        return cachedRootVue;
    }
    const rootVue = await waitForVueInstance(DEFAULT_BOSS_ROOT_SELECTOR, timeout);
    cachedRootVue = rootVue;
    return rootVue;
}

/**
 * 纯原生 JS 劫持 Vue 实例的响应式数据
 *
 * 替代 boss-helper 中对 Vue 3 Ref 的强依赖：
 * - dataHolder 可为包含 .value 的普通对象，或由 onUpdate 接收值；
 * - 劫持 property setter，确保 Boss 异步拉取新数据时自动触发通知；
 * - 完好保留原有 getter 与 setter，避免页面原有渲染逻辑异常。
 *
 * @param {string} selectors DOM 选择器
 * @param {string} key 劫持的 Vue 属性名（如 jobList, pageVo, hasMore）
 * @param {object|function} [dataHolder] 数据持有对象 { value: any } 或回调函数
 * @param {function} [onUpdate] 更新回调函数 (newVal) => void
 * @param {number} [timeout=20000]
 * @returns {() => Promise<any>} 返回异步执行函数
 */
function useHookVueData(selectors, key, dataHolder, onUpdate, timeout = 20000) {
    let updateCallback = onUpdate;
    let targetHolder = dataHolder;

    if (typeof dataHolder === 'function' && typeof onUpdate !== 'function') {
        updateCallback = dataHolder;
        targetHolder = null;
    }

    return async () => {
        const jobVue = await waitForVueInstance(selectors, timeout);

        let currentValue = jobVue[key];

        // 初始同步
        if (targetHolder && typeof targetHolder === 'object' && 'value' in targetHolder) {
            targetHolder.value = currentValue;
        }
        if (typeof updateCallback === 'function') {
            updateCallback(currentValue);
        }

        // 获取原有的 property descriptor 与 setter/getter
        const desc = Object.getOwnPropertyDescriptor(jobVue, key);
        const originalSet = (typeof jobVue.__lookupSetter__ === 'function' && jobVue.__lookupSetter__(key))
            || (desc && desc.set);
        const originalGet = (typeof jobVue.__lookupGetter__ === 'function' && jobVue.__lookupGetter__(key))
            || (desc && desc.get);

        // 劫持 setter，捕获后续每次页面数据更新
        Object.defineProperty(jobVue, key, {
            configurable: true,
            enumerable: true,
            get() {
                if (originalGet) {
                    return originalGet.call(this);
                }
                return currentValue;
            },
            set(val) {
                currentValue = val;
                if (targetHolder && typeof targetHolder === 'object' && 'value' in targetHolder) {
                    targetHolder.value = val;
                }
                if (typeof updateCallback === 'function') {
                    updateCallback(val);
                }
                if (originalSet) {
                    originalSet.call(this, val);
                }
            }
        });

        return jobVue;
    };
}

/**
 * 纯原生 JS 提取并绑定 Vue 实例上的方法
 *
 * 支持单一键名或数组键名降级匹配（如 ['searchJobAction', 'onSearch']）
 * 自动绑定 Vue 实例上下文，防止脱离实例后 this 指向丢失。
 *
 * @param {string} selectors DOM 选择器
 * @param {string|string[]} keys 目标方法名或候选方法名数组
 * @param {number} [timeout=20000]
 * @returns {() => Promise<Function|undefined>}
 */
function useHookVueFn(selectors, keys, timeout = 20000) {
    return async () => {
        const jobVue = await waitForVueInstance(selectors, timeout);
        const keyList = Array.isArray(keys) ? keys : [keys];

        for (const k of keyList) {
            if (jobVue && typeof jobVue[k] === 'function') {
                return jobVue[k].bind(jobVue);
            } else if (jobVue && jobVue[k] !== undefined) {
                return jobVue[k];
            }
        }
        return undefined;
    };
}

/**
 * 重置根 Vue 缓存（用于测试或页面硬刷新场景）
 */
function resetRootVueCache() {
    cachedRootVue = null;
}

// 统一导出兼容 Node.js (CommonJS) / ES Module / 浏览器环境
const BossHooks = {
    DEFAULT_BOSS_JOB_SELECTORS,
    DEFAULT_BOSS_ROOT_SELECTOR,
    waitForElement,
    waitForVueInstance,
    getRootVue,
    useHookVueData,
    useHookVueFn,
    resetRootVueCache
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BossHooks;
}
if (typeof window !== 'undefined') {
    window.BossHooks = BossHooks;
}

})();

/* src/platforms/boss_adapter.js */
;(function () {
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

})();

/* src/platforms/boss_api.js */
;(function () {
/**
 * @file boss_api.js
 * @description BOSS直聘原生投递请求、凭证复用与限额熔断平台驱动层
 * @author Google Senior Security & API Engineer
 */

/**
 * 平台通用 API 异常基类
 */
class BossApiError extends Error {
  /**
   * @param {string} message - 错误信息
   * @param {Object} [options] - 附加错误详情
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'BossApiError';
    this.details = options.details;
    this.response = options.response;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * 投递常规异常
 */
class PublishError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'PublishError';
  }
}

/**
 * 配额超限硬性熔断异常 (单日达 150 人硬封顶)
 */
class QuotaLimitError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'QuotaLimitError';
    this.limit = 150;
  }
}

/**
 * 平台风控频控异常 (操作过于频繁)
 */
class RateLimitError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'RateLimitError';
  }
}

class AuthenticationError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

class VerificationError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'VerificationError';
  }
}

/**
 * BOSS直聘相关 API 端点
 */
const BOSS_ENDPOINTS = {
  FRIEND_ADD: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
};

/**
 * 从当前运行环境 (Cookie / 全局对象 / 自定义参数) 中自动提取 bst 凭证
 * @param {string} [explicitToken] - 显式指定的 token
 * @returns {string|null}
 */
function extractBstToken(explicitToken) {
  if (explicitToken && typeof explicitToken === 'string') {
    return explicitToken.trim();
  }

  // 1. 从宿主页面 window.Cookie 获取
  if (typeof window !== 'undefined' && window.Cookie && typeof window.Cookie.get === 'function') {
    try {
      const token = window.Cookie.get('bst');
      if (token) return token;
    } catch (_) {}
  }

  // 2. 从 document.cookie 中提取 bst 键值
  if (typeof document !== 'undefined' && typeof document.cookie === 'string') {
    const match = document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  // 3. 从 window 页面全局状态尝试获取
  if (typeof window !== 'undefined') {
    if (window._PAGE?.token) return window._PAGE.token;
    if (window._PAGE?.zpToken) return window._PAGE.zpToken;
    if (window.Zp_token) return window.Zp_token;
  }

  return null;
}

/**
 * 发送单笔投递请求 (核心底层网络请求方法)
 * @param {Object} data - 岗位参数
 * @param {string} data.securityId - BOSS直聘安全凭证 securityId
 * @param {string} [data.jobId] - 岗位加密 ID
 * @param {string} [data.encryptJobId] - 岗位加密 ID 兼容别名
 * @param {string} [data.id] - 岗位 ID 兼容别名
 * @param {Object|string} [optionsOrErrorMsg={}] - 配置项对象或重试失败默认提示
 * @param {number} [retries=1] - 兼容保留；投递 POST 不会自动重试，避免重复沟通
 * @param {Object} [_params={}] - 额外附加请求参数 (如 { cid: 1 })
 * @returns {Promise<Object>} 接口返回的原始 JSON 数据
 */
async function sendPublishReq(data, optionsOrErrorMsg = {}, retries = 1, _params = {}) {
  // 规范化配置项，兼容对象参数与位置参数两种形式
  let options = {};
  if (typeof optionsOrErrorMsg === 'string') {
    options = {
      errorMsg: optionsOrErrorMsg,
      retries,
      _params,
    };
  } else if (typeof optionsOrErrorMsg === 'object' && optionsOrErrorMsg !== null) {
    options = { ...optionsOrErrorMsg };
  }

  const targetJobId = data?.jobId || data?.encryptJobId || data?.id;
  const targetSecurityId = data?.securityId;

  if (!targetJobId || !targetSecurityId) {
    throw new PublishError('缺少必要的投递参数: securityId 或 jobId');
  }

  // 凭证提取与复用
  const token = extractBstToken(options.token);
  if (!token) {
    throw new PublishError('未获取到有效凭证(bst/Zp_token)，请确认是否已登录BOSS直聘');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new PublishError('当前环境未找到可用的 fetch 实现');
  }

  // 构造请求 URL 与查询参数
  const url = new URL(BOSS_ENDPOINTS.FRIEND_ADD);
  url.searchParams.set('securityId', targetSecurityId);
  url.searchParams.set('jobId', targetJobId);

  const extraParams = options._params || {};
  for (const [key, val] of Object.entries(extraParams)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  const headers = {
    'Zp_token': token,
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {}),
  };

  try {
    const rawRes = await fetchFn(url.toString(), {
      method: 'POST',
      headers,
      credentials: 'include',
    });

    if (rawRes.status === 401 || rawRes.status === 403) {
      throw new AuthenticationError('登录状态已失效或无权访问，请重新登录后再试', { response: rawRes });
    }

    const res = await rawRes.json();

    // code === 0: 投递成功
    if (res.code === 0) {
      return res;
    }

    // code === 1: 业务异常与限额分流拦截
    if (res.code === 1) {
      const content = String(
        res?.zpData?.bizData?.chatRemindDialog?.content || res?.message || '未知错误',
      );

      if (/登录|未登录|身份失效|token失效/i.test(content)) {
        throw new AuthenticationError(content, { response: res });
      }

      if (/验证码|安全验证|行为验证|人机验证/i.test(content)) {
        throw new VerificationError(content, { response: res });
      }

      // 命中平台限额时停在当前页，交由用户在页面中手动处理。
      if (content.includes('120位') || content.includes('已与120位BOSS沟通')) {
        throw new QuotaLimitError(`命中平台沟通限额，请在页面中手动确认后再继续: ${content}`, { response: res });
      }

      // 2. 命中 150 位硬性上限 -> 抛出 QuotaLimitError 触发业务熔断
      if (content.includes('150位') || content.includes('已与150位BOSS沟通')) {
        throw new QuotaLimitError(content, { response: res });
      }

      // 3. 命中频控拦截 -> 抛出 RateLimitError
      if (content.includes('操作过于频繁')) {
        throw new RateLimitError(content, { response: res });
      }

      // 其他业务错误
      throw new PublishError(content, { response: res });
    }

    // 其它非 0 状态码
    throw new PublishError(res?.message || `未知错误状态码: ${res.code}`, { response: res });
  } catch (err) {
    // 凡是明确的业务/配额/频控异常，不可盲目网络重试，必须直接向上抛出
    if (err instanceof BossApiError) {
      throw err;
    }

    throw new PublishError(err?.message || '投递网络请求失败；为避免重复沟通，未自动重试', { details: err });
  }
}

/**
 * 封装单岗位投递核心方法
 * @param {Object|string} job - 岗位对象（含 securityId, jobId）或 securityId 字符串
 * @param {Object|string} [optionsOrJobId={}] - 配置项或 jobId 字符串
 * @param {Object} [maybeOptions={}] - 额外配置项
 * @returns {Promise<{ success: boolean, jobId: string, securityId: string, data: Object, message: string }>}
 */
async function deliverJob(job, optionsOrJobId = {}, maybeOptions = {}) {
  let jobData = {};
  let options = {};

  if (typeof job === 'string') {
    jobData = {
      securityId: job,
      jobId: optionsOrJobId,
    };
    options = maybeOptions || {};
  } else if (typeof job === 'object' && job !== null) {
    jobData = {
      securityId: job.securityId,
      jobId: job.jobId || job.encryptJobId || job.id,
    };
    options = optionsOrJobId || {};
  } else {
    throw new PublishError('无效的岗位参数，必须提供 securityId 与 jobId');
  }

  const res = await sendPublishReq(jobData, options);
  return {
    success: true,
    jobId: jobData.jobId,
    securityId: jobData.securityId,
    data: res,
    message: res?.message || '投递成功',
  };
}

/**
 * 批量投递核心方法 (带限额熔断与结构化统计报告)
 * @param {Array<Object>} jobs - 待投递岗位列表
 * @param {Object} [options={}] - 批量调度配置
 * @param {number|Function} [options.intervalMs=2500] - 单次投递安全间隔 (毫秒) 或动态延时函数
 * @param {Function} [options.onProgress] - 进度回调 ({ index, total, job, result, status }) => void
 * @param {Function} [options.onBreak] - 熔断触发回调 ({ reason, error, job, index }) => void
 * @param {AbortSignal} [options.signal] - 外部中止信号
 * @param {boolean} [options.stopOnError=false] - 遇常规错误是否立即停止
 * @param {string} [options.token] - 自定义凭据 token
 * @param {Function} [options.fetchFn] - 可注入的 fetch 实现
 * @returns {Promise<{
 *   total: number,
 *   successCount: number,
 *   failedCount: number,
 *   skippedCount: number,
 *   circuitBroken: boolean,
 *   breakReason: string|null,
 *   results: Array<Object>,
 *   errors: Array<Object>
 * }>}
 */
async function batchDeliverJobs(jobs, options = {}) {
  const {
    intervalMs = 2500,
    onProgress = null,
    onBreak = null,
    signal = null,
    stopOnError = false,
    token = null,
    fetchFn = globalThis.fetch,
  } = options;

  if (!Array.isArray(jobs)) {
    throw new PublishError('jobs 必须为岗位对象数组');
  }

  const results = [];
  const errors = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let circuitBroken = false;
  let breakReason = null;

  for (let i = 0; i < jobs.length; i++) {
    // 1. 检查外部取消信号
    if (signal && signal.aborted) {
      circuitBroken = true;
      breakReason = '任务被外部信号中止';
      break;
    }

    const job = jobs[i];

    // 2. 检查是否已经沟通过
    if (job?.contacted) {
      skippedCount++;
      const skipItem = {
        job,
        index: i,
        success: false,
        status: 'skipped_contacted',
        message: '该岗位已沟通，自动跳过',
      };
      results.push(skipItem);
      onProgress?.({ index: i, total: jobs.length, job, result: skipItem, status: 'skipped_contacted' });
      continue;
    }

    // 3. 执行单岗位投递
    try {
      const res = await deliverJob(job, { token, fetchFn });
      successCount++;
      const successItem = {
        job,
        index: i,
        success: true,
        status: 'delivered',
        result: res,
      };
      results.push(successItem);
      onProgress?.({ index: i, total: jobs.length, job, result: successItem, status: 'delivered' });
    } catch (err) {
      failedCount++;

      // 4. 限额 150 硬性熔断处理
      if (err instanceof QuotaLimitError || err instanceof AuthenticationError || err instanceof VerificationError) {
        circuitBroken = true;
        breakReason = `命中需要人工处理的平台限制: ${err.message}`;
        const errorItem = {
          job,
          index: i,
          success: false,
          status: 'quota_exhausted',
          error: err,
        };
        results.push(errorItem);
        errors.push({ job, error: err, isCircuitBreak: true });
        onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'quota_exhausted' });
        onBreak?.({ reason: 'platform_intervention_required', error: err, job, index: i });
        break; // 立即熔断，不再执行任何后续网络请求
      }

      // 5. 频控风控硬性熔断处理
      if (err instanceof RateLimitError) {
        circuitBroken = true;
        breakReason = `命中平台频控风控: ${err.message}`;
        const errorItem = {
          job,
          index: i,
          success: false,
          status: 'rate_limited',
          error: err,
        };
        results.push(errorItem);
        errors.push({ job, error: err, isCircuitBreak: true });
        onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'rate_limited' });
        onBreak?.({ reason: 'rate_limited', error: err, job, index: i });
        break; // 立即熔断，停止后续请求
      }

      // 6. 其他常规错误 (如单岗位已下线或未知失败)
      const errorItem = {
        job,
        index: i,
        success: false,
        status: 'failed',
        error: err,
      };
      results.push(errorItem);
      errors.push({ job, error: err, isCircuitBreak: false });
      onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'failed' });

      if (stopOnError) {
        circuitBroken = true;
        breakReason = `遇到投递错误已停止: ${err.message}`;
        break;
      }
    }

    // 7. 岗位之间随机/配置延时等待 (未熔断且非最后一个岗位时生效)
    if (i < jobs.length - 1 && !circuitBroken) {
      const delay = typeof intervalMs === 'function' ? intervalMs() : Number(intervalMs) || 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    total: jobs.length,
    successCount,
    failedCount,
    skippedCount,
    circuitBroken,
    breakReason,
    results,
    errors,
  };
}

/**
 * 批量投递兼容别名导出
 */
const deliverBatch = batchDeliverJobs;

// Browser entry point used by the production userscript bundle.  Keeping this
// explicit also lets the scheduler receive the API as a dependency in tests.
if (typeof window !== 'undefined') {
  window.BossApi = {
    BossApiError,
    PublishError,
    QuotaLimitError,
    RateLimitError,
    AuthenticationError,
    VerificationError,
    BOSS_ENDPOINTS,
    extractBstToken,
    sendPublishReq,
    deliverJob,
    batchDeliverJobs,
    deliverBatch,
  };
}

})();

/* src/core/scheduler.js */
;(function () {
/**
 * End-to-end delivery state machine. Dependencies are injectable so that the
 * state transitions can be tested without a BOSS page or live network calls.
 */
let SchedulerBlacklist;
let SchedulerLimiter;
if (typeof require !== 'undefined') {
    try { SchedulerBlacklist = require('./blacklist.js'); } catch (_) { /* browser bundle */ }
    try { SchedulerLimiter = require('./rate_limiter.js'); } catch (_) { /* browser bundle */ }
}

const SCHEDULER_STATES = Object.freeze({
    IDLE: 'idle', RUNNING: 'running', PAUSED: 'paused', STOPPED: 'stopped', CIRCUIT_BROKEN: 'circuit_broken', COMPLETED: 'completed'
});

class DeliveryScheduler {
    constructor(options = {}) {
        const browser = typeof window !== 'undefined' ? window : {};
        this.adapter = options.adapter || browser.BossPlatformAdapter && new browser.BossPlatformAdapter();
        this.blacklist = options.blacklist || SchedulerBlacklist?.blacklist || browser.blacklist;
        this.limiter = options.limiter || SchedulerLimiter?.rateLimiter || browser.rateLimiter;
        this.api = options.api || browser.BossApi;
        this.dailyLimit = this._normalizeDailyLimit(options.dailyLimit);
        this.maxConsecutiveFailures = Number.isFinite(options.maxConsecutiveFailures) ? Math.max(1, Math.floor(options.maxConsecutiveFailures)) : 3;
        this.pageBuffer = options.pageBuffer !== false;
        this.state = SCHEDULER_STATES.IDLE;
        this.stats = { delivered: 0, blacklistSkipped: 0, contactedSkipped: 0, duplicateSkipped: 0, failed: 0, page: 0, limitReached: false, reason: null };
        this._listeners = new Set();
        this._runPromise = null;
        this._pauseWaiters = [];
        this._abortController = null;
        this._seenJobIds = new Set();
        this._consecutiveFailures = 0;
    }

    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this._listeners.add(listener);
        listener(this.snapshot());
        return () => this._listeners.delete(listener);
    }

    snapshot() { return { state: this.state, stats: { ...this.stats }, dailyLimit: this.dailyLimit }; }
    _normalizeDailyLimit(value) { return Number.isFinite(value) ? Math.min(150, Math.max(1, Math.floor(value))) : 80; }
    _emit() { const view = this.snapshot(); this._listeners.forEach((fn) => { try { fn(view); } catch (_) {} }); }
    _setState(state, reason = null) { this.state = state; if (reason) this.stats.reason = reason; this._emit(); }
    _assertDependencies() {
        if (!this.adapter || typeof this.adapter.refresh_jobs !== 'function' || typeof this.adapter.next_page !== 'function') throw new Error('BossAdapter is not ready');
        if (!this.blacklist || typeof this.blacklist.batchFilter !== 'function') throw new Error('BlacklistFilter is not ready');
        if (!this.limiter || typeof this.limiter.afterDelivery !== 'function') throw new Error('RateLimiter is not ready');
        if (!this.api || typeof this.api.deliverJob !== 'function') throw new Error('BossApi is not ready');
    }

    start() {
        if (this.state === SCHEDULER_STATES.RUNNING) return this._runPromise;
        if (this.state === SCHEDULER_STATES.PAUSED) return this.resume();
        this._assertDependencies();
        this._abortController = new AbortController();
        this.stats.reason = null;
        this._setState(SCHEDULER_STATES.RUNNING);
        this._runPromise = this._run().catch((error) => {
            if (this.state !== SCHEDULER_STATES.STOPPED && this.state !== SCHEDULER_STATES.CIRCUIT_BROKEN) this._setState(SCHEDULER_STATES.CIRCUIT_BROKEN, error.message);
            return this.snapshot();
        });
        return this._runPromise;
    }

    pause() { if (this.state === SCHEDULER_STATES.RUNNING) this._setState(SCHEDULER_STATES.PAUSED); }
    resume() {
        if (this.state !== SCHEDULER_STATES.PAUSED) return this._runPromise;
        this._setState(SCHEDULER_STATES.RUNNING);
        this._pauseWaiters.splice(0).forEach((resolve) => resolve());
        return this._runPromise;
    }
    stop(reason = 'Emergency stop') {
        if (this._abortController) this._abortController.abort();
        this._pauseWaiters.splice(0).forEach((resolve) => resolve());
        this._setState(SCHEDULER_STATES.STOPPED, reason);
    }
    circuitBreak(reason = 'Circuit breaker triggered') {
        if (this._abortController) this._abortController.abort();
        this._pauseWaiters.splice(0).forEach((resolve) => resolve());
        this._setState(SCHEDULER_STATES.CIRCUIT_BROKEN, reason);
    }
    async _checkpoint() {
        if (this._abortController.signal.aborted) return false;
        if (this.state === SCHEDULER_STATES.PAUSED) await new Promise((resolve) => this._pauseWaiters.push(resolve));
        return this.state === SCHEDULER_STATES.RUNNING && !this._abortController.signal.aborted;
    }
    async _run() {
        while (await this._checkpoint()) {
            const jobs = (await this.adapter.refresh_jobs()).filter(Boolean);
            const pageInfo = this.adapter.get_page_info ? this.adapter.get_page_info() : {};
            this.stats.page = Number(pageInfo.current || this.stats.page || 1); this._emit();
            const { allowed, blocked } = this.blacklist.batchFilter(jobs);
            this.stats.blacklistSkipped += blocked.length; this._emit();
            for (const job of allowed) {
                if (!(await this._checkpoint())) return this.snapshot();
                if (this.stats.delivered >= this.dailyLimit) { this.stats.limitReached = true; this._setState(SCHEDULER_STATES.COMPLETED, 'Daily delivery limit reached'); return this.snapshot(); }
                const jobKey = job.id || job.encryptJobId || job.securityId;
                if (jobKey && this._seenJobIds.has(jobKey)) { this.stats.duplicateSkipped++; this._emit(); continue; }
                if (job.contacted) { this.stats.contactedSkipped++; this._emit(); continue; }
                if (jobKey) this._seenJobIds.add(jobKey);
                try {
                    await this.api.deliverJob(job);
                    this.stats.delivered++; this._emit();
                    this._consecutiveFailures = 0;
                } catch (error) {
                    this.stats.failed++; this._emit();
                    this._consecutiveFailures++;
                    if (this._isCircuitError(error) || this._consecutiveFailures >= this.maxConsecutiveFailures) {
                        const reason = this._isCircuitError(error) ? error.message : `连续 ${this._consecutiveFailures} 次投递失败: ${error.message}`;
                        this.circuitBreak(reason); return this.snapshot();
                    }
                }
                if (this.stats.delivered < this.dailyLimit && !(await this._checkpoint())) return this.snapshot();
                await this.limiter.afterDelivery({ signal: this._abortController.signal });
                if (!(await this._checkpoint())) return this.snapshot();
            }
            if (this.stats.delivered >= this.dailyLimit) { this.stats.limitReached = true; this._setState(SCHEDULER_STATES.COMPLETED, 'Daily delivery limit reached'); return this.snapshot(); }
            if (!pageInfo.hasMore || jobs.length === 0) { this._setState(SCHEDULER_STATES.COMPLETED, 'No more pages'); return this.snapshot(); }
            if (this.pageBuffer) await this.limiter.afterPageChange({ signal: this._abortController.signal });
            if (!(await this._checkpoint())) return this.snapshot();
            if (!await this.adapter.next_page()) { this._setState(SCHEDULER_STATES.COMPLETED, 'No next page available'); return this.snapshot(); }
        }
        return this.snapshot();
    }
    _isCircuitError(error) { return /QuotaLimitError|RateLimitError|AuthenticationError|VerificationError|quota|频控|150位/i.test(error?.name || '') || /quota|频控|150位|操作过于频繁|登录|验证/i.test(error?.message || ''); }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { DeliveryScheduler, SCHEDULER_STATES };
if (typeof window !== 'undefined') { window.DeliveryScheduler = DeliveryScheduler; window.SCHEDULER_STATES = SCHEDULER_STATES; }

})();

/* src/ui/panel.js */
;(function () {
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

})();

/* src/ui/fab.js */
;(function () {
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

})();

/* src/entry.js */
;(function () {
// Userscript bootstrap. The panel is intentionally opt-in through the floating
// control; it never starts a delivery run without a user click.
(function bootstrap() {
    if (typeof window === 'undefined' || !window.DeliveryScheduler) return;
    const scheduler = new window.DeliveryScheduler();
    const panel = new window.DeliveryPanel(scheduler).mount();
    new window.SchedulerFab(scheduler).mount();
    window.JobHelperPipeline = { scheduler, panel };
})();

})();
