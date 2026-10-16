// ==UserScript==
// @name         招聘网站全能助手 (Job Helper Universal)
// @namespace    https://github.com/job-helper
// @version      34.0
// @description  全能招聘助手：前程无忧与BOSS直聘双平台黑名单实时互通共享、卡片一键屏蔽、BOSS直聘全链路流水线自动沟通、自定义MQTT招呼语与智能防封
// @match        *://www.zhipin.com/*
// @match        *://*.51job.com/*
// @match        *://search.51job.com/*
// @match        *://we.51job.com/*
// @require      https://cdn.jsdelivr.net/npm/protobufjs@7.2.6/dist/protobuf.min.js
// @require      https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
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
        this._listeners = new Set();
        this._valueListenerAttached = false;

        // Auto-initialize
        this.init();
    }

    /**
     * Subscribe to blacklist cache changes (local or cross-tab)
     * @param {Function} listener
     * @returns {Function} unsubscribe function
     */
    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    _notify() {
        const snapshot = Array.from(this.cache);
        this._listeners.forEach(fn => { try { fn(snapshot); } catch (_) {} });
    }

    _setupValueChangeListener() {
        if (this._valueListenerAttached) return;
        const addListener = typeof GM_addValueChangeListener === 'function'
            ? GM_addValueChangeListener
            : (typeof window !== 'undefined' && typeof window.GM_addValueChangeListener === 'function' ? window.GM_addValueChangeListener : null);
        if (typeof addListener === 'function') {
            this._valueListenerAttached = true;
            try {
                addListener(this.storageKey, (name, oldValue, newValue, remote) => {
                    if (Array.isArray(newValue)) {
                        this.cache = new Set(
                            newValue
                                .filter(item => typeof item === 'string')
                                .map(item => this.normalize(item))
                                .filter(Boolean)
                        );
                        this._notify();
                    }
                });
            } catch (_) {}
        }
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
            this._setupValueChangeListener();
        } catch (e) {
            console.error('[BlacklistEngine] Failed to initialize storage:', e);
            if (!this.cache) this.cache = new Set();
            this.initialized = true;
        }
    }

    /**
     * Force synchronization with external storage (e.g. cross-tab reload)
     */
    sync() {
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
                this._notify();
            }
        } catch (_) {}
        return Array.from(this.cache);
    }

    /**
     * Persist current in-memory cache to underlying storage
     */
    persist() {
        try {
            const storage = this._getStorage();
            storage.set(this.storageKey, Array.from(this.cache));
            this._notify();
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
 * Anti-ban rate limiting specifications:
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

/* src/platforms/boss_chat.js */
;(function () {
/**
 * @file boss_chat.js
 * @description BOSS直聘自定义打招呼长连接、MQTT通讯与Protobuf协议编解码层
 */

// 兼容 Node.js 与浏览器沙盒环境依赖引入
let globalProtobuf = typeof protobuf !== 'undefined' ? protobuf : null;
let globalMqtt = typeof mqtt !== 'undefined' ? mqtt : null;
if (typeof require !== 'undefined') {
  try { if (!globalProtobuf) globalProtobuf = require('protobufjs'); } catch (_) {}
  try { if (!globalMqtt) globalMqtt = require('mqtt'); } catch (_) {}
}

/**
 * 获取全局跨沙盒宿主页面运行环境与上下文参数 (适配 Tampermonkey unsafeWindow 与原生 window)
 */
function getGlobalPageContext() {
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (typeof window !== 'undefined' ? window : {});
  let page = win._PAGE || (typeof window !== 'undefined' ? window._PAGE : null);

  // 1. 若运行在沙盒中或 _PAGE 关键属性缺失，扫描页面内联 <script> 进行精准正则提取（杜绝 JSON.parse 原生 JS 字面量抛错）
  const inlineProps = {};
  if (typeof document !== 'undefined') {
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('window._PAGE') || txt.includes('_PAGE =') || txt.includes('encryptUserId')) {
          // 提取 token
          const mToken = txt.match(/["']?token["']?\s*:\s*["']([^"']+)["']/);
          if (mToken && !inlineProps.token) inlineProps.token = mToken[1];

          // 提取 encryptUserId
          const mEncUid = txt.match(/["']?encryptUserId["']?\s*:\s*["']([^"']+)["']/);
          if (mEncUid && !inlineProps.encryptUserId) inlineProps.encryptUserId = mEncUid[1];

          // 提取 uid / userId
          const mUid = txt.match(/["']?(?:userId|uid)["']?\s*:\s*["']?(\d+)["']?/);
          if (mUid && !inlineProps.uid) {
            inlineProps.uid = Number(mUid[1]);
            inlineProps.userId = Number(mUid[1]);
          }

          // 提取 name / showName
          const mName = txt.match(/["']?(?:showName|name)["']?\s*:\s*["']([^"']+)["']/);
          if (mName && !inlineProps.name) inlineProps.name = mName[1];
        }
      }
    } catch (_) {}
  }

  // 合并 page 对象与内联正则提取结果
  page = { ...(page || {}), ...inlineProps };

  // 2. HTTP 接口专用凭证: bst (Cookie 提取)
  const cookieObj = win.Cookie || (typeof window !== 'undefined' ? window.Cookie : null);
  let bstToken = null;
  if (cookieObj && typeof cookieObj.get === 'function') {
    try { bstToken = cookieObj.get('bst'); } catch (_) {}
  }
  if (!bstToken && typeof document !== 'undefined' && document.cookie) {
    const m = document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (m) bstToken = decodeURIComponent(m[1]);
  }
  if (!bstToken && win.document && typeof win.document.cookie === 'string') {
    const m = win.document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (m) bstToken = decodeURIComponent(m[1]);
  }

  // 3. WebSocket 长连接专用认证 token: page.token
  const wsToken = page.token || '';

  // 4. 当前求职者身份标识
  const uid = Number(page.uid || page.userId || 0);
  const encryptUserId = page.encryptUserId || '';

  return {
    win,
    page,
    token: bstToken || wsToken,
    bstToken: bstToken || '',
    wsToken: wsToken || '',
    uid,
    encryptUserId,
  };
}

/**
 * 随机 UUID 生成工具
 */
function getUuid(len = 16, radix = 16) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
  const uuid = [];
  radix = radix || chars.length;
  if (len) {
    for (let i = 0; i < len; i++) {
      uuid[i] = chars[(Math.random() * radix) | 0];
    }
  } else {
    uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
    uuid[14] = '4';
    for (let i = 0; i < 36; i++) {
      if (!uuid[i]) {
        const r = (Math.random() * 16) | 0;
        uuid[i] = chars[i === 19 ? (r & 3) | 8 : r];
      }
    }
  }
  return uuid.join('');
}

/**
 * 招呼语模板插值渲染
 * 支持 {{ jobName }}、{{ companyName }} 及 {jobName}、{companyName}
 */
function renderGreetingTemplate(template, data = {}) {
  if (!template || typeof template !== 'string') return '';
  const context = {
    jobName: data.jobName || data.title || data.job_name || '',
    companyName: data.companyName || data.brandName || data.company || '',
    bossName: data.bossName || data.bossTitle || '',
    ...data,
  };

  // 1. 替换 {{ key }} 风格
  let res = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const val = path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), context);
    return val !== undefined && val !== null ? String(val) : '';
  });

  // 2. 替换 {key} 风格
  res = res.replace(/\{(\w+)\}/g, (match, key) => {
    const val = context[key];
    return val !== undefined && val !== null ? String(val) : match;
  });

  return res;
}

/**
 * Protobuf 编码工具函数 (用于无外部 protobufjs 库时的稳固原生编码兜底)
 */
function writeVarint(buf, val) {
  let v = BigInt(val);
  while (v > 127n) {
    buf.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  buf.push(Number(v));
}

function encodeProtobufText(str) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(str));
  }
  return Array.from(Buffer.from(str, 'utf8'));
}

/**
 * 原生编码 TechwolfChatProtocol 消息报文
 */
function encodeChatProtocolBinary({ fromUid, toUid, text, mid, toName = '', toSource = 0 }) {
  const buf = [];

  // 1. TechwolfUser from
  const fromBytes = [];
  fromBytes.push((1 << 3) | 0); // tag 1: uid (varint)
  writeVarint(fromBytes, fromUid);
  fromBytes.push((7 << 3) | 0); // tag 7: source = 0
  writeVarint(fromBytes, 0);

  // 2. TechwolfUser to
  const toBytes = [];
  toBytes.push((1 << 3) | 0); // tag 1: uid (varint)
  writeVarint(toBytes, toUid);
  if (toName) {
    const nameBytes = encodeProtobufText(toName);
    toBytes.push((2 << 3) | 2); // tag 2: name (string) = encryptBossId
    writeVarint(toBytes, nameBytes.length);
    toBytes.push(...nameBytes);
  }
  toBytes.push((7 << 3) | 0); // tag 7: source = 0
  writeVarint(toBytes, toSource || 0);

  // 3. TechwolfMessageBody body
  const bodyBytes = [];
  bodyBytes.push((1 << 3) | 0); // tag 1: type = 1
  writeVarint(bodyBytes, 1);
  bodyBytes.push((2 << 3) | 0); // tag 2: templateId = 1
  writeVarint(bodyBytes, 1);
  const textBytes = encodeProtobufText(text);
  bodyBytes.push((3 << 3) | 2); // tag 3: text (string)
  writeVarint(bodyBytes, textBytes.length);
  bodyBytes.push(...textBytes);

  // 4. TechwolfMessage
  const msgBytes = [];
  // field 1: from
  msgBytes.push((1 << 3) | 2);
  writeVarint(msgBytes, fromBytes.length);
  msgBytes.push(...fromBytes);
  // field 2: to
  msgBytes.push((2 << 3) | 2);
  writeVarint(msgBytes, toBytes.length);
  msgBytes.push(...toBytes);
  // field 3: type = 1
  msgBytes.push((3 << 3) | 0);
  writeVarint(msgBytes, 1);
  // field 4: mid
  msgBytes.push((4 << 3) | 0);
  writeVarint(msgBytes, mid);
  // field 5: time
  msgBytes.push((5 << 3) | 0);
  writeVarint(msgBytes, mid);
  // field 6: body
  msgBytes.push((6 << 3) | 2);
  writeVarint(msgBytes, bodyBytes.length);
  msgBytes.push(...bodyBytes);
  // field 11: cmid
  msgBytes.push((11 << 3) | 0);
  writeVarint(msgBytes, mid);

  // 5. TechwolfChatProtocol
  buf.push((1 << 3) | 0); // tag 1: type = 1
  writeVarint(buf, 1);
  buf.push((3 << 3) | 2); // tag 3: messages (repeated)
  writeVarint(buf, msgBytes.length);
  buf.push(...msgBytes);

  return new Uint8Array(buf);
}

/**
 * BOSS 直聘官方 Protobuf 模式定义
 */
const BOSS_PROTO_SCHEMA =
  'option java_package = "cn.techwolf.boss.chat";option java_outer_classname = "ChatProtocol";message TechwolfUser { required int64 uid = 1; optional string name = 2; optional string avatar = 3; optional string company = 4; optional int32 headImg = 5; optional int32 certification = 6; optional int32 source = 7;}message TechwolfSound { optional int64 sid = 1; optional string url = 2; optional int32 duration = 3; optional int32 templateId = 4; optional string extend = 5;}message TechwolfVideo { required int32 type = 1; required int32 status = 2; optional int32 duration = 3; optional string text = 4;}message TechwolfInterview { required int32 condition = 1; required string text = 2; optional string url = 3; optional string extend = 4; }message TechwolfImageInfo { required string url = 1; required int32 width = 2; required int32 height = 3;}message TechwolfImage { optional int64 iid = 1; optional TechwolfImageInfo tinyImage = 2; optional TechwolfImageInfo originImage = 3;}message TechwolfAction { required int32 aid = 1; optional string extend = 2;}message TechwolfArticle { required string title = 1; required string description = 2; required string picUrl = 3; required string url = 4; optional int32 templateId = 5; optional string bottomText = 6; optional int64 timeout = 7; optional string statisticParameters = 8; repeated TechwolfSlice highlightParts = 9; repeated TechwolfSlice dimParts = 10; optional string subTitle = 11; optional string extend = 12;}message TechwolfNotify { required string text = 1; optional string url = 2; optional string title = 3;}message TechwolfButton { required string text = 1; optional string url = 2; optional int32 templateId = 3;}message TechwolfDialog { required string text = 1; repeated TechwolfButton buttons = 2; required bool operated = 3; optional bool clickMore = 4; optional int32 type = 5; optional string backgroundUrl = 6; optional int64 timeout = 7; optional string statisticParameters = 8; optional string title = 9; optional string url = 10; optional int32 selectedIndex = 11; optional string extend = 12; optional string content = 13;}message TechwolfJobDesc { required string title = 1; required string company = 2; required string salary = 3; required string url = 4; required int64 jobId = 5; optional string positionCategory = 6; optional string experience = 7; optional string education = 8; optional string city = 9; optional string bossTitle = 10; optional TechwolfUser boss = 11; optional string lid = 12; optional string stage = 13; optional string bottomText = 14; optional string jobLabel = 15; optional int32 iconFlag = 16; optional string content = 17; repeated string labels = 18; optional int64 expectId = 19; optional string expectPosition = 20; optional string expectSalary = 21; optional string partTimeDesc = 22; optional TechwolfUser geek = 23; optional string latlon = 24; optional string distance = 25; optional string extend = 26;}message TechwolfResume { required TechwolfUser user = 1; optional string description = 2; optional string city = 3; optional string position = 4; repeated string keywords = 5; optional int64 expectId = 6; optional string lid = 7; optional int32 gender = 8; optional string salary = 9; optional string workYear = 10; optional string content1 = 11; optional string content2 = 12; optional string education = 13; optional string age = 14; repeated string labels = 15; repeated UserExperience experiences = 16; optional string positionCategory = 17; optional string jobSalary = 18; optional string bottomText = 19; optional string applyStatus = 20; optional int64 jobId = 21; optional string content3 = 22; optional string securityId = 23; optional TechwolfUser boss = 24; optional string brandName = 25; optional string extend = 26;}message TechwolfHyperLink {        required string text = 1;       required string url = 2; required int32 hyperLinkType = 3; optional string extraJson=4;}message TechwolfMessageBody { required int32 type = 1; required int32 templateId = 2; optional string headTitle = 11; optional string text = 3; optional TechwolfSound sound = 4; optional TechwolfImage image = 5; optional TechwolfAction action = 6; repeated TechwolfArticle articles = 7; optional TechwolfNotify notify = 8; optional TechwolfDialog dialog = 9; optional TechwolfJobDesc jobDesc = 10; optional TechwolfResume resume = 12; optional TechwolfRedEnvelope redEnvelope = 13; optional TechwolfOrderDetail orderDetail = 14; optional TechwolfHyperLink hyperLink = 15; optional TechwolfVideo video = 16; optional TechwolfInterview interview = 17; optional TechwolfJobShare jobShare = 18; optional TechwolfResumeShare resumeShare = 19; optional AtInfo atInfo = 20; optional TechwolfSticker sticker = 21; optional TechwolfChatShare chatShare = 22; optional TechwolfInterviewShare interviewShare = 23; optional TechwolfListCard listCard = 24; optional TechwolfStarRate starRate = 25; optional TechwolfFrame frame = 26; optional TechwolfMultiImage multiImage = 27; optional string extend = 28; optional int32 style = 29; optional TechwolfComDesc comDesc = 30; optional TechwolfUserCard userCard = 31;}message TechwolfMessage { required TechwolfUser from = 1; required TechwolfUser to = 2; required int32 type = 3; optional int64 mid = 4; optional int64 time = 5; required TechwolfMessageBody body = 6; optional bool offline = 7; optional bool received = 8; optional string pushText = 9; optional int64 taskId = 10; optional int64 cmid = 11; optional int32 status = 12; optional int32 uncount = 13; optional int32 pushSound = 14; optional int32 flag = 15; optional bytes encryptedBody = 16; optional string bizId = 17; optional int32 bizType = 18; optional string securityId = 19; optional int64 quoteId = 20;}message TechwolfClientInfo { optional string version = 1; optional string system = 2; optional string systemVersion = 3; optional string model = 4; optional string uniqid = 5; optional string network = 6; optional int32 appid = 7; optional string platform = 8; optional string channel = 9; optional string ssid = 10; optional string bssid = 11; optional double longitude = 12; optional double latitude = 13;}message TechwolfClientTime { optional int64 startTime = 1; optional int64 resumeTime = 2; optional int64 locateTime = 3;}message TechwolfPresence { required int32 type = 1; required int32 uid = 2; optional TechwolfClientInfo clientInfo = 3; optional TechwolfClientTime clientTime = 4; optional int64 lastMessageId = 5; optional int64 lastGroupMessageId = 6; optional int64 userId = 7;}message TechwolfKVEntry {        required string key = 1;        required string value = 2;}message TechwolfIq { required int64 qid = 1; required string query = 2; repeated TechwolfKVEntry params = 3;}message TechwolfIqResponse { required int64 qid = 1; required string query = 2; repeated TechwolfKVEntry results = 3;}message TechwolfMessageSync {       required int64 clientMid = 1;    required int64 serverMid = 2;}message TechwolfMessageRead {     required int64 userId = 1;      required int64 messageId = 2;   required int64 readTime = 3;     optional bool sync = 4 [default = false];       optional int32 userSource = 5;}message TechwolfChatProtocol { required int32 type = 1; optional string version = 2; repeated TechwolfMessage messages = 3; optional TechwolfPresence presence = 4; optional TechwolfIq iq = 5; optional TechwolfIqResponse iqResponse = 6; repeated TechwolfMessageSync messageSync = 7; repeated TechwolfMessageRead messageRead = 8; optional TechwolfDataSync dataSync = 9; optional int32 domain = 10;}message TechwolfRedEnvelope { required int64 redId = 1; required string redText = 2; required string redTitle = 3; required string clickUrl = 4;}message TechwolfOrderDetail { required string title = 1; required string subTitle = 2; optional string url = 3; repeated TechwolfOrderDetailEntry orderDetailEntryList = 4;}message TechwolfOrderDetailItem { required string name = 1; required int32 templateId = 2;}message TechwolfOrderDetailEntry { required TechwolfOrderDetailItem key = 1; required TechwolfOrderDetailItem value = 2;}message TechwolfUserSync { required int64 uid = 1; required int32 identity = 2; optional string extraJson = 3; optional int32 userSource = 4;}message TechwolfDataSync { required int32 type = 1; optional TechwolfUserSync userSync = 2; optional TechwolfGroupSync groupSync = 3;}message TechwolfSlice { required int32 startIndex = 1; required int32 endIndex = 2;}message UserExperience { required string organization = 1; required string occupation = 2; optional string startDate = 3; optional string endDate = 4; required int32 type = 5;}message TechwolfJobShare { required TechwolfUser user = 1; required int64 jobId = 2; required string position = 3; required string salary = 4; optional string location = 5; required string company = 6; optional string stage = 7; optional string experience = 8; optional string education = 9; optional string url = 10; optional string lid = 11; optional string price = 12; optional string description = 13; optional int64 bossId = 14; optional string extend = 15;}message TechwolfResumeShare { required TechwolfUser user = 1; required int64 expectId = 2; required string position = 3; required string salary = 4; optional string location = 5; optional string applyStatus = 6; optional string age = 7; optional string experience = 8; optional string education = 9; optional string url = 10; optional string lid = 11; optional int32 gender = 12; optional bool blurred = 13; optional int32 source = 14;}message AtInfo { required int32 flag = 1; repeated int64 uids = 2;}message TechwolfGroupSync { required int64 gid = 1; optional int32 version = 2; optional string encGid = 3; optional string extraJson = 4;}message TechwolfSticker { required int64 sid = 1; optional int64 packId = 2; optional TechwolfImage image = 3; optional string format = 4; optional string name = 5; optional string encSid = 6;}message TechwolfChatShare { required int64 shareId = 1; required string title = 2; repeated string records = 3; optional string bottomText = 4; optional string url = 5; required TechwolfUser from = 6; required TechwolfUser to = 7; required TechwolfUser user = 8;}message TechwolfInterviewShare { required int64 interviewId = 1; required TechwolfUser user = 2; required string title = 3; required string bottomText = 4; optional string url = 5; optional string interviewTime = 6; optional string interviewAddress = 7; optional string jobName = 8;}message TechwolfListItem { optional string title = 1; optional int32 icon = 2; optional string url = 3; optional string text = 4;}message TechwolfListCard { optional string title = 1; repeated TechwolfListItem items = 2; optional int32 pageSize = 3; optional string extend = 4;}message TechwolfStar { required int64 starId = 1; optional string starDesc = 2; repeated TechwolfListItem options = 3;}message TechwolfStarRate { optional string title = 1; repeated TechwolfStar stars = 2; required int32 rateStatus = 3; optional TechwolfStar rateStar = 4; optional TechwolfButton submitButton = 5;}message TechwolfFrame { required string href = 1;}message TechwolfMultiImage { repeated TechwolfImageInfo images = 1;}message TechwolfComDesc { required string picUrl = 1; required string name = 2; optional string stage = 3; optional string scale = 4; optional string industry = 5; repeated string welfareLabels = 6; optional string introduce = 7; optional string url = 8; optional string extend = 9;}message TechwolfUserCard { required string name = 1; required string tiny = 2; optional int32 gender = 3; optional string comment = 4; optional string description = 5; repeated string labels = 6; optional string url = 7; optional string extend = 8;}';

/**
 * Protobuf 消息序列化与构建器
 */
class ProtoBufferMessage {
  constructor(config = {}) {
    this.config = config;
    this.protoRoot = null;
    this.ChatProtocol = null;
    this.isInitialized = false;
    const ctx = getGlobalPageContext();
    this.protobufLib = config.protobufLib || globalProtobuf || ctx.win.protobuf || (typeof window !== 'undefined' ? window.protobuf : null);
    this.toObjectOptions = {
      enums: String,
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true,
      oneofs: true,
    };
    this.init();
  }

  init() {
    if (this.isInitialized) return;
    if (!this.protobufLib || typeof this.protobufLib.parse !== 'function') {
      return;
    }
    try {
      this.protoRoot = this.protobufLib.parse(BOSS_PROTO_SCHEMA, { keepCase: false }).root;
      this.ChatProtocol = this.protoRoot.lookupType('TechwolfChatProtocol');
      this.TechwolfMessage = this.protoRoot.lookupType('TechwolfMessage');
      this.TechwolfUser = this.protoRoot.lookupType('TechwolfUser');
      this.TechwolfMessageBody = this.protoRoot.lookupType('TechwolfMessageBody');
      this.isInitialized = true;
    } catch (e) {
      console.warn('[JobHelper:Chat] Protobuf 加载异常，将使用内置原生编解码器:', e?.message || e);
    }
  }

  createTextMessage(stanza, options = {}) {
    const text = options.text || '';
    const now = Date.now();
    const fromUid = Number(this.config.userId || 0);
    const toUid = Number(stanza.uid || 0);

    const messagePayload = {
      type: 1,
      mid: stanza.clientMid || now,
      cmid: stanza.clientMid || now,
      time: now,
      from: {
        uid: fromUid,
        source: this.config.friendSource || 0,
      },
      to: {
        uid: toUid,
        name: stanza.encryptUid || '', // BOSS直聘官方协议：to.name 承载 encryptUid/encryptBossId
        encryptUid: stanza.encryptUid || '',
        source: stanza.friendSource || 0,
      },
      body: {
        type: 1,
        templateId: 1,
        text: text,
      },
    };

    if (this.isInitialized && this.ChatProtocol) {
      const chatProtocolMsg = this.ChatProtocol.create({
        type: 1,
        messages: [this.TechwolfMessage.create(messagePayload)],
      });
      return this.ChatProtocol.toObject(chatProtocolMsg, this.toObjectOptions);
    }

    return {
      type: 1,
      messages: [messagePayload],
    };
  }

  encode(messageObj) {
    if (this.isInitialized && this.ChatProtocol) {
      try {
        return this.ChatProtocol.encode(messageObj).finish();
      } catch (e) {
        console.warn('[JobHelper:Chat] protobufjs 编码异常，回退内置编码器:', e?.message || e);
      }
    }

    // 内置二进制标准 Varint/Tag 编码器兜底
    try {
      const msg = messageObj?.messages?.[0];
      const fromUid = msg?.from?.uid || this.config.userId || 0;
      const toUid = msg?.to?.uid || 0;
      const toName = msg?.to?.name || msg?.to?.encryptUid || '';
      const toSource = msg?.to?.source || 0;
      const text = msg?.body?.text || '';
      const mid = msg?.mid || Date.now();
      return encodeChatProtocolBinary({ fromUid, toUid, text, mid, toName, toSource });
    } catch (err) {
      console.error('[JobHelper:Chat] 原生二进制编码致命错误:', err);
      const jsonStr = JSON.stringify(messageObj);
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(jsonStr);
      }
      return Buffer.from(jsonStr);
    }
  }
}

/**
 * BOSS 直聘聊天客户端管理器
 */
class GeekChatClientManager {
  constructor(options = {}) {
    this.options = options;
    this.client = null;
    this.msgBuilder = null;
    this.wt = null;
    this.token = null;
    this.uid = null;
    this.isConnected = false;
    this._connectPromise = null;
  }

  /**
   * 从当前运行环境中获取 wt 凭证 (GET https://www.zhipin.com/wapi/zppassport/get/wt)
   */
  async fetchWt(fetchFn = globalThis.fetch) {
    const url = 'https://www.zhipin.com/wapi/zppassport/get/wt';
    const res = await fetchFn(url, { credentials: 'include' }).then((r) => r.json());
    if (res?.code !== 0 || !res?.zpData?.wt2) {
      throw new Error(`获取 wt 凭证失败: ${res?.message || '未知错误'}`);
    }
    return res.zpData.wt2;
  }

  /**
   * 建立 MQTT 长连接与初始化 Protobuf 构建器
   */
  async connect(params = {}) {
    if (this.isConnected && this.client) return this;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      const ctx = getGlobalPageContext();
      const win = ctx.win;
      const fetchFn = params.fetchFn || this.options.fetchFn || globalThis.fetch;
      const mqttLib = params.mqttLib || this.options.mqttLib || (typeof mqtt !== 'undefined' ? mqtt : null) || globalMqtt || win.mqtt || (typeof window !== 'undefined' ? window.mqtt : null);

      // 1. 获取 wt2 (支持自动重试 3 次)
      this.wt = params.wt || this.options.wt;
      if (!this.wt) {
        let wtError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            this.wt = await this.fetchWt(fetchFn);
            if (this.wt) {
              console.log('[JobHelper:Chat] 获取 wt 凭证成功');
              break;
            }
          } catch (e) {
            wtError = e;
            if (attempt < 3) await new Promise((r) => setTimeout(r, 600));
          }
        }
        if (!this.wt) {
          throw new Error(`无法获取 wt 认证凭证: ${wtError?.message || '未知错误'}`);
        }
      }

      // 2. 获取 token (WebSocket 专用) 与 uid、encryptUserId
      this.token = params.token || this.options.token || ctx.wsToken || '';
      if (!this.token) {
        throw new Error('未获取到 WebSocket 长连接认证 token (_PAGE.token)，请确认是否已登录BOSS直聘');
      }

      this.uid = Number(params.uid || this.options.uid || ctx.uid || 0);
      this.encryptUserId = params.encryptUserId || this.options.encryptUserId || ctx.encryptUserId || '';

      // 3. 初始化 Protobuf 消息构造器
      const protobufLib = params.protobufLib || this.options.protobufLib || (typeof protobuf !== 'undefined' ? protobuf : null) || globalProtobuf || win.protobuf || (typeof window !== 'undefined' ? window.protobuf : null);

      this.msgBuilder = new ProtoBufferMessage({
        userId: this.uid,
        token: this.token,
        platform: 'web',
        friendSource: 0,
        supportPush: true,
        wt: this.wt,
        protobufLib,
      });

      // 4. 连接 MQTT (wss://ws6.zhipin.com/chatws)
      if (!mqttLib || typeof mqttLib.connect !== 'function') {
        throw new Error('当前运行环境未检测到可用的 MQTT 库 (window.mqtt/mqtt)，无法建立聊天长连接');
      }

      const clientId = `ws-${getUuid(16, 16)}`;
      const wsUrl = 'wss://ws6.zhipin.com/chatws';
      const wtVal = this.wt;
      const WebSocketCtor = (win && win.WebSocket) || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      if (!WebSocketCtor) {
        throw new Error('当前环境缺少 WebSocket 构造函数');
      }

      this.client = mqttLib.connect(wsUrl, {
        clientId,
        username: `${this.token}|0`,
        password: wtVal,
        keepalive: 25,
        clean: true,
        reconnectPeriod: 1000,
        connectTimeout: 10000,
        protocolVersion: 4,
        createWebsocket: (url) => {
          const subProtocols = wtVal ? [wtVal] : ['mqtt'];
          return new WebSocketCtor(url, subProtocols);
        },
      });

      // 监听连接状态，离线时重置连接标记
      if (this.client && typeof this.client.on === 'function') {
        this.client.on('close', () => { this.isConnected = false; });
        this.client.on('offline', () => { this.isConnected = false; });
      }

      await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.isConnected = true;
            resolve();
          }
        }, 5000);

        if (this.client && typeof this.client.on === 'function') {
          this.client.on('connect', () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.isConnected = true;
              console.log('[JobHelper:Chat] ✅ MQTT 聊天长连接已建立');
              resolve();
            }
          });
          this.client.on('error', (err) => {
            if (!settled) {
              console.warn('[JobHelper:Chat] MQTT 连接告警:', err?.message || err);
            }
          });
        } else {
          this.isConnected = true;
          resolve();
        }
      });

      return this;
    })();

    try {
      await this._connectPromise;
      return this;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * 发送聊天文本消息 (基于高级打招呼长连接协议)
   * @param {object} bossData Boss元数据对象
   * @param {string} greetingText 待发送文本
   * @param {object} [job] 关联的岗位对象
   */
  async sendMessage(bossData, greetingText, job = null) {
    if (!bossData) {
      throw new Error('未提供 bossData，无法发送自定义招呼语');
    }
    if (!greetingText || typeof greetingText !== 'string' || !greetingText.trim()) {
      return false;
    }

    // 重点：解构 bossData 与 bossData.data 结构
    const innerData = bossData.data || bossData;
    const targetUid = Number(innerData.bossId || innerData.uid || bossData.bossId || 0);
    const friendSource = Number(
      innerData.bossSource ??
      bossData.bossSource ??
      job?.rawData?.detail?.bossInfo?.bossSource ??
      0
    );
    const encryptBossId = String(
      innerData.encryptBossId ||
      bossData.encryptBossId ||
      innerData.encryptUid ||
      bossData.encryptUid ||
      job?.encryptBossId ||
      job?.rawData?.encryptBossId ||
      job?.rawData?.jobitem?.encryptBossId ||
      ''
    );

    if (!targetUid || Number.isNaN(targetUid)) {
      console.error('[JobHelper:Chat] 无法解析到有效的 targetUid (bossId):', bossData);
      throw new Error('无法解析目标 Boss 的数字 UID，消息取消发送');
    }

    if (!this.isConnected || !this.client || !this.msgBuilder) {
      await this.connect();
    }

    const stanza = {
      uid: targetUid,
      friendSource: friendSource,
      encryptUid: encryptBossId,
      encryptGid: '',
      clientMid: Date.now(),
    };

    console.log('[JobHelper:Chat] 准备向 Boss 发送高级自定义打招呼:', {
      targetUid,
      friendSource,
      encryptBossId,
      text: greetingText.trim(),
    });

    const msgObj = this.msgBuilder.createTextMessage(stanza, {
      text: greetingText.trim(),
    });

    const encoded = this.msgBuilder.encode(msgObj);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn('[JobHelper:Chat] MQTT 发送等待响应超时，已放行');
          resolve(true);
        }
      }, 5000);

      try {
        this.client.publish('chat', encoded, { qos: 1, retain: true }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            console.warn('[JobHelper:Chat] MQTT 消息发送异常:', err);
            return reject(err);
          }
          console.log('[JobHelper:Chat] ✅ 高级自定义招呼语发送成功！');
          resolve(true);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.client && typeof this.client.end === 'function') {
      try { this.client.end(); } catch (_) {}
    }
    this.isConnected = false;
  }
}

/**
 * 获取 Boss 元数据 (数值型 UID 与通讯参数)
 */
async function getBossData(job, options = {}) {
  const ctx = getGlobalPageContext();
  const fetchFn = options.fetchFn || globalThis.fetch;
  const token = options.token || ctx.bstToken || ctx.token;

  if (!token) {
    throw new Error('未获取到有效凭证(bst/Zp_token)，请确认是否已登录BOSS直聘');
  }

  const retries = options.retries !== undefined ? options.retries : 3;
  if (retries <= 0) {
    throw new Error(options.errorMsg || '获取Boss信息重试多次失败');
  }

  const url = 'https://www.zhipin.com/wapi/zpchat/geek/getBossData';
  const targetSecurityId = job?.securityId || job?.security_id;

  if (!targetSecurityId) {
    throw new Error('缺少获取Boss信息的必要参数: securityId');
  }

  // 关键修复：bossId 必须是目标 Boss 的加密 ID，优先从 options.encryptBossId、job 属性或 rawData 中获取
  const targetBossId = options.encryptBossId ||
    job?.encryptBossId ||
    job?.encryptUserId ||
    job?.bossId ||
    job?.rawData?.encryptBossId ||
    job?.rawData?.detail?.bossInfo?.encryptBossId ||
    options.encryptUserId ||
    ctx.encryptUserId;

  if (!targetBossId) {
    throw new Error('缺少目标 Boss 的 ID 标识');
  }

  let lastError = null;
  try {
      let body;
      if (typeof FormData !== 'undefined') {
        body = new FormData();
        body.append('bossId', String(targetBossId));
        body.append('securityId', String(targetSecurityId));
        body.append('bossSrc', '0');
      } else {
        body = new URLSearchParams();
        body.append('bossId', String(targetBossId));
        body.append('securityId', String(targetSecurityId));
        body.append('bossSrc', '0');
      }

      const rawRes = await fetchFn(url, {
        method: 'POST',
        body: body,
        headers: {
          'Zp_token': token,
        },
        credentials: 'include',
      });

      const res = await rawRes.json();

      if (res?.code === 0 && res?.zpData) {
        return res.zpData;
      }

      if (res?.message === '非好友关系') {
        if (retries > 1) {
          await new Promise((r) => setTimeout(r, 600));
          return await getBossData(job, {
            ...options,
            retries: retries - 1,
            errorMsg: '非好友关系',
          });
        }
      }

      lastError = new Error(`获取Boss信息失败: ${res?.message || '未知状态'}`);
  } catch (err) {
    lastError = err;
  }

  throw lastError || new Error('获取Boss信息重试失败');
}

// 导出至 window 与 unsafeWindow 便于油猴与调试复用
if (typeof window !== 'undefined') {
  window.ProtoBufferMessage = ProtoBufferMessage;
  window.GeekChatClientManager = GeekChatClientManager;
  window.getBossData = getBossData;
  window.renderGreetingTemplate = renderGreetingTemplate;
  window.getUuid = getUuid;
  window.getGlobalPageContext = getGlobalPageContext;
}
if (typeof unsafeWindow !== 'undefined') {
  unsafeWindow.ProtoBufferMessage = ProtoBufferMessage;
  unsafeWindow.GeekChatClientManager = GeekChatClientManager;
  unsafeWindow.getBossData = getBossData;
  unsafeWindow.renderGreetingTemplate = renderGreetingTemplate;
  unsafeWindow.getUuid = getUuid;
  unsafeWindow.getGlobalPageContext = getGlobalPageContext;
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

function resolveVueInstance(el) {
    if (!el) return null;
    if (el.__vue__) return el.__vue__;
    const parent = el.__vueParentComponent;
    if (parent?.proxy) return parent.proxy;
    if (el.__vue_app__?.config?.globalProperties) return el.__vue_app__.config.globalProperties;
    return null;
}

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
        const immediateVue = resolveVueInstance(immediate);
        if (immediateVue) {
            return resolve(immediateVue);
        }

        const startTime = Date.now();
        const timer = setInterval(() => {
            const el = doc.querySelector(selectors);
            const vue = resolveVueInstance(el);
            if (vue) {
                clearInterval(timer);
                resolve(vue);
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
 * 纯原生 JS 劫持 Vue 实例的响应式数据：
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
                if (typeof newHasMore === 'boolean') {
                    this.hasMore = newHasMore;
                    this._notifySubscribers('hasMore', this.hasMore);
                }
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
     * @param {object} [options]
     * @param {number} [options.waitMs=3000] 等待数据就绪的最大轮询时间 (毫秒)
     * @returns {Promise<Array<object>>} 标准岗位对象数组
     */
    async refresh_jobs(options = {}) {
        if (!this.jobVue) {
            await this.initContext();
        }

        // 增加就绪轮询重试：如果列表刚进入页面尚在加载，等待最多 3 秒
        const maxWaitMs = options.waitMs !== undefined ? options.waitMs : 3000;
        const startTime = Date.now();
        while (Date.now() - startTime < maxWaitMs) {
            const list = Array.isArray(this.jobVue?.jobList) && this.jobVue.jobList.length > 0
                ? this.jobVue.jobList
                : (Array.isArray(this.rawJobList) && this.rawJobList.length > 0 ? this.rawJobList : null);
            if (list && list.length > 0) {
                this.rawJobList = list;
                break;
            }
            await new Promise((r) => setTimeout(r, 200));
        }

        const vueList = Array.isArray(this.jobVue?.jobList) ? this.jobVue.jobList : null;
        if (vueList) this.rawJobList = vueList;
        let sourceList = vueList || (Array.isArray(this.rawJobList) ? this.rawJobList : []);

        // 兜底：如果 Vue jobList 仍然为空，尝试从 DOM 中映射卡片数据
        if (sourceList.length === 0) {
            sourceList = this._scanDomJobItems();
        }

        return sourceList.map((item, index) => this._normalizeJobItem(item, index));
    }

    /**
     * 从 DOM 卡片节点解析兜底岗位数据 (当 Vue 实例暂未捕获或初始化延迟时)
     */
    _scanDomJobItems() {
        if (typeof document === 'undefined') return [];
        const cardSelectors = ['.job-card-box', '.job-card-wrapper', 'li.job-primary', '.job-list-ul > li', '.job-card-body'];
        const nodes = document.querySelectorAll(cardSelectors.join(','));
        const domItems = [];
        nodes.forEach((card, idx) => {
            const link = card.querySelector('a[href*="/job_detail/"]');
            const href = link ? link.getAttribute('href') : '';
            const match = href.match(/\/job_detail\/([^.]+)\.html/);
            const encryptJobId = match ? match[1] : (card.dataset.jobId || `dom_${idx}`);
            const titleEl = card.querySelector('.job-name, .job-title');
            const jobName = titleEl ? titleEl.innerText.trim() : '';
            const companyEl = card.querySelector('.company-name a, .company-name');
            const companyName = companyEl ? companyEl.innerText.trim() : '';
            const salaryEl = card.querySelector('.salary');
            const salaryDesc = salaryEl ? salaryEl.innerText.trim() : '';
            const secMatch = href.match(/securityId=([^&]+)/);
            const securityId = card.dataset.securityId || card.dataset.securityid || card.getAttribute('securityId') || card.getAttribute('data-security-id') || (secMatch ? decodeURIComponent(secMatch[1]) : '');
            const bossEl = card.querySelector('.boss-name');
            const bossName = bossEl ? bossEl.innerText.trim() : '';
            const encBossMatch = href.match(/encryptBossId=([^&]+)/);
            const encryptBossId = card.dataset.encryptBossId || card.dataset.bossId || card.getAttribute('data-boss-id') || (encBossMatch ? decodeURIComponent(encBossMatch[1]) : '');
            const lidMatch = href.match(/lid=([^&]+)/);
            const lid = card.dataset.lid || (lidMatch ? decodeURIComponent(lidMatch[1]) : '');
            const contactBtn = card.querySelector('.btn-startchat, .btn, .op-btn, .has-contact, .chat-btn');
            const btnText = contactBtn ? (contactBtn.innerText || contactBtn.textContent || '').trim() : '';
            const isDomContacted = card.querySelector('.has-contact') !== null ||
                /继续沟通|已沟通|已打招呼|聊一聊已满/i.test(btnText);
            if (encryptJobId || jobName) {
                domItems.push({
                    encryptJobId,
                    jobName,
                    companyName,
                    salaryDesc,
                    securityId,
                    bossName,
                    encryptBossId,
                    lid,
                    contact: isDomContacted,
                });
            }
        });
        return domItems;
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
        const bossInfo = item.bossInfo || item.rawData?.bossInfo || {};
        const hrName = item.bossName || bossInfo.name || '';
        const bossTitle = item.bossTitle || bossInfo.title || '';
        const salaryDesc = item.salaryDesc || item.salary || '';
        const contacted = Boolean(
            item.contact ||
            item.bothTalked ||
            item.hasContact ||
            item.friendStatus === 1 ||
            item.friendStatus === 2 ||
            item.status === 1
        );

        // 拼接地理位置
        const cityDistrict = [
            item.cityName,
            item.areaDistrict,
            item.businessDistrict
        ].filter(Boolean).join('-') || item.cityDistrict || '';

        // 尝试映射对应的 DOM 卡片节点（用于高亮、加标或屏蔽）
        const rawNode = this._findJobCardNode(id, item.lid);

        const isHunter = Boolean(
            item.goldHunter === 1 ||
            item.isHeadhunter ||
            bossInfo.goldHunter === 1 ||
            (rawNode && rawNode.querySelector('.gold-hunter, .hunter-icon, .icon-hunter, .job-hunter') !== null)
        );

        const encryptBossId = item.encryptBossId ||
            bossInfo.encryptBossId ||
            bossInfo.encryptUserId ||
            item.encryptUserId ||
            '';
        const bossId = Number(item.bossId || bossInfo.bossId || 0);
        const bossSource = Number(item.bossSource ?? bossInfo.bossSource ?? 0);

        return {
            id,
            securityId,
            jobName,
            companyName,
            hrName,
            salaryDesc,
            cityDistrict,
            contacted,
            isHunter,
            rawNode,
            // 扩展原始字段，供更深业务（如技能比对、活跃度评估）使用
            skills: Array.isArray(item.skills) ? item.skills : (item.jobLabels || []),
            jobLabels: Array.isArray(item.jobLabels) ? item.jobLabels : [],
            activeTime: item.lastModifyTime,
            bossTitle,
            encryptBrandId: item.encryptBrandId || item.brandId || '',
            encryptBossId,
            bossId,
            bossSource,
            lid: item.lid || item.rawData?.lid || '',
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
        const currentPageVo = this.jobVue?.pageVo && typeof this.jobVue.pageVo === 'object'
            ? this.jobVue.pageVo
            : this.pageVo;
        const page = currentPageVo ? Number(currentPageVo.page || 1) : 1;
        const pageSize = currentPageVo ? Number(currentPageVo.pageSize || 15) : 15;
        const total = currentPageVo ? Number(currentPageVo.total || 0) : 0;

        let hasMore = true;
        if (typeof this.hasMore === 'boolean') {
            hasMore = this.hasMore;
        } else if (typeof this.jobVue?.hasMore === 'boolean') {
            hasMore = this.jobVue.hasMore;
        } else if (total > 0 && pageSize > 0) {
            hasMore = page * pageSize < total;
        }

        return {
            current: page,
            pageSize,
            total,
            hasMore
        };
    }

    /**
     * 原生无感切页：优先调用 Vue 内部翻页方法拉取下一页，附带 DOM 按钮与滚动降级
     * @param {object} [options]
     * @param {number} [options.timeout=10000] 等待新数据到达的超时时间
     * @returns {Promise<boolean>} 是否成功翻到下一页且拿到新数据
     */
    async next_page(options = {}) {
        if (this._isNavigating) {
            return false;
        }

        const pageInfo = this.get_page_info();
        if (pageInfo.total > 0 && pageInfo.hasMore === false) {
            return false;
        }

        if (!this.pageChangeFn) {
            try {
                await this.initContext();
            } catch (_) {}
        }

        this._isNavigating = true;
        const timeout = options.timeout || 10000;
        const targetPage = pageInfo.current + 1;
        const initialFirstId = this.rawJobList[0]?.encryptJobId || '';
        const initialListLength = this.rawJobList.length;

        try {
            // 1. 尝试调用 Vue 翻页方法
            if (typeof this.pageChangeFn === 'function') {
                try {
                    const callResult = this.pageChangeFn(targetPage);
                    if (callResult && typeof callResult.then === 'function') {
                        await callResult;
                    }
                } catch (e) {
                    console.warn('[JobHelper:Adapter] 原生翻页方法执行告警，将启用 DOM 降级:', e?.message || e);
                }
            }

            // 2. 等待数据变化：通过 Vue 响应式 setter 更新或轮询确认
            const updateSuccess = await new Promise((resolve) => {
                const startTime = Date.now();
                let domFallbacked = false;
                const timer = setInterval(() => {
                    const vueList = Array.isArray(this.jobVue?.jobList) ? this.jobVue.jobList : null;
                    if (vueList) this.rawJobList = vueList;
                    const currentFirstId = this.rawJobList[0]?.encryptJobId || '';
                    const currentPageVo = this.jobVue?.pageVo || this.pageVo;
                    const currentPage = currentPageVo?.page || 1;

                    // 标志1：页码推进
                    // 标志2：首条岗位变更（常规切页）
                    // 标志3：列表长度改变且非空
                    const hasPageIncremented = currentPage >= targetPage;
                    const hasDataChanged = (currentFirstId !== '' && currentFirstId !== initialFirstId) ||
                        (this.rawJobList.length > 0 && this.rawJobList.length !== initialListLength);

                    if (hasPageIncremented || hasDataChanged) {
                        clearInterval(timer);
                        resolve(true);
                        return;
                    }

                    // 兜底降级：若等待 2 秒未感知到新数据，尝试通过点击 DOM 翻页按钮或下滚触发页面原生拉取
                    if (!domFallbacked && Date.now() - startTime >= 2000 && typeof document !== 'undefined') {
                        domFallbacked = true;
                        const nextBtn = document.querySelector('.options-pages a.next:not(.disabled), .page-job-wrapper .next:not(.disabled), a.page-next:not(.disabled), .ui-icon-arrow-right');
                        if (nextBtn) {
                            nextBtn.click();
                        } else if (typeof window !== 'undefined' && (location.href.includes('recommend') || location.href.includes('jobs'))) {
                            window.scrollTo(0, document.body.scrollHeight);
                        }
                    }

                    if (Date.now() - startTime >= timeout) {
                        clearInterval(timer);
                        // 超时兜底：检测 DOM 中卡片数量是否增加
                        if (typeof document !== 'undefined') {
                            const domCount = document.querySelectorAll('.job-card-box, .job-card-wrapper, li.job-primary').length;
                            if (domCount > 0 && domCount !== initialListLength) {
                                resolve(true);
                                return;
                            }
                        }
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

/**
 * BOSS直聘相关 API 端点
 */
const BOSS_ENDPOINTS = {
  FRIEND_ADD: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
  CHAT_REMIND: 'https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json',
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

  const pageWindow = typeof unsafeWindow !== 'undefined'
    ? unsafeWindow
    : (typeof window !== 'undefined' ? window : null);

  // 1. 从宿主页面 Cookie 获取（Tampermonkey 沙盒的 window 不一定拥有页面对象）
  if (pageWindow?.Cookie && typeof pageWindow.Cookie.get === 'function') {
    try {
      const token = pageWindow.Cookie.get('bst');
      if (token) return token;
    } catch (_) {}
  }

  // 2. 从 document.cookie 中提取 bst 键值
  const cookie = typeof document !== 'undefined' && typeof document.cookie === 'string'
    ? document.cookie
    : (pageWindow?.document && typeof pageWindow.document.cookie === 'string' ? pageWindow.document.cookie : '');
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  // 3. 从 window 页面全局状态尝试获取
  if (pageWindow) {
    if (pageWindow._PAGE?.token) return pageWindow._PAGE.token;
    if (pageWindow._PAGE?.zpToken) return pageWindow._PAGE.zpToken;
    if (pageWindow.Zp_token) return pageWindow.Zp_token;
  }

  return null;
}

/**
 * 向 actionLog 发送 120 人限额提醒解除上报
 * @param {Object} params
 * @param {string} [params.ba] - 弹窗回传的校验 ba 凭据
 * @param {string} [params.token] - Zp_token 凭据
 * @param {Function} [params.fetchFn] - 可注入的 fetch 实现
 * @returns {Promise<Response>}
 */
async function confirmChatRemindLimit({ ba, token, fetchFn = globalThis.fetch } = {}) {
  const url = new URL(BOSS_ENDPOINTS.CHAT_REMIND);
  if (ba) {
    url.searchParams.set('ba', String(ba));
  }
  url.searchParams.set('action', 'addf-limit-popup-c');

  const headers = {};
  if (token) {
    headers['Zp_token'] = token;
  }

  return await fetchFn(url.toString(), {
    method: 'POST',
    headers,
    credentials: 'include',
  });
}

/**
 * 发送单笔投递请求 (核心底层网络请求方法)
 * @param {Object} data - 岗位参数
 * @param {string} data.securityId - BOSS直聘安全凭证 securityId
 * @param {string} [data.jobId] - 岗位加密 ID
 * @param {string} [data.encryptJobId] - 岗位加密 ID 兼容别名
 * @param {string} [data.id] - 岗位 ID 兼容别名
 * @param {Object|string} [optionsOrErrorMsg={}] - 配置项对象或重试失败默认提示
 * @param {number} [retries=3] - 网络重试次数
 * @param {Object} [_params={}] - 额外附加请求参数 (如 { cid: 1 })
 * @returns {Promise<Object>} 接口返回的原始 JSON 数据
 */
async function sendPublishReq(data, optionsOrErrorMsg = {}, retries = 3, _params = {}) {
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

  const currentRetries = options.retries !== undefined ? options.retries : 3;
  if (currentRetries <= 0) {
    throw new PublishError(options.errorMsg || '投递请求重试多次失败');
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

  const targetLid = data?.lid || data?.rawData?.lid;
  if (targetLid) {
    url.searchParams.set('lid', String(targetLid));
  }

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

      // 1. 命中 120 位软限额弹窗 -> 自动确认解除限制并携带 { cid: 1 } 重试
      if (content.includes('120位') || content.includes('已与120位BOSS沟通')) {
        // 防止携带 cid 仍反复返回 120 造成死循环
        if (extraParams.cid === 1) {
          throw new QuotaLimitError(`120位沟通限制确认后重试仍然受限: ${content}`, { response: res });
        }

        try {
          const ba = res?.zpData?.bizData?.chatRemindDialog?.ba;
          await confirmChatRemindLimit({ ba, token, fetchFn });

          // 解除成功后，自动携带 { cid: 1 } 重新发起投递
          return await sendPublishReq(data, {
            ...options,
            _params: { ...extraParams, cid: 1 },
          });
        } catch (err) {
          if (err instanceof BossApiError) throw err;
          throw new PublishError(`解除120位投递限制确认请求失败: ${err.message}`, {
            details: err,
            response: res,
          });
        }
      }

      // 2. 命中 150 位硬性上限 -> 抛出 QuotaLimitError 触发业务熔断
      if (content.includes('150位') || content.includes('已与150位BOSS沟通')) {
        throw new QuotaLimitError(content, { response: res });
      }

      // 3. 命中频控拦截 -> 抛出 RateLimitError
      if (content.includes('操作过于频繁')) {
        throw new RateLimitError(content, { response: res });
      }

      // 4. 命中“已沟通”响应，平滑转为已沟通状态放行
      if (/已与该Boss沟通|已有沟通记录|已向该Boss发起过沟通|今日已打招呼|已有沟通/i.test(content)) {
        return {
          code: 0,
          contacted: true,
          message: content,
          zpData: res?.zpData || {},
        };
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

    // 网络层抖动或超时，执行重试递减
    if (currentRetries > 1) {
      return await sendPublishReq(data, {
        ...options,
        retries: currentRetries - 1,
        errorMsg: err?.message,
      });
    }

    throw new PublishError(err?.message || '投递网络请求失败，已耗尽重试次数', { details: err });
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
      lid: job.lid || job.rawData?.lid,
      rawData: job.rawData,
    };
    options = optionsOrJobId || {};
  } else {
    throw new PublishError('无效的岗位参数，必须提供 securityId 与 jobId');
  }

  const res = await sendPublishReq(jobData, options);
  return {
    success: true,
    contacted: Boolean(res?.contacted),
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
      if (err instanceof QuotaLimitError) {
        circuitBroken = true;
        breakReason = `命中每日上限硬性限制 (150位): ${err.message}`;
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
        onBreak?.({ reason: 'quota_exhausted', error: err, job, index: i });
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

let bossChatModule;
if (typeof require !== 'undefined') {
  try { bossChatModule = require('./boss_chat.js'); } catch (_) {}
}

/**
 * 获取 Boss 元数据 (数值型 UID 与通讯参数)
 */
async function getBossData(job, options = {}) {
  const fn = bossChatModule?.getBossData || (typeof window !== 'undefined' ? window.getBossData : null);
  if (typeof fn === 'function') {
    return await fn(job, options);
  }
  throw new PublishError('当前环境未找到 getBossData 实现');
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
    BOSS_ENDPOINTS,
    extractBstToken,
    confirmChatRemindLimit,
    sendPublishReq,
    deliverJob,
    batchDeliverJobs,
    deliverBatch,
    getBossData,
  };
}


})();

/* src/platforms/job51_adapter.js */
;(function () {
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

})();

/* src/core/scheduler.js */
;(function () {
/**
 * End-to-end delivery state machine. Dependencies are injectable so that the
 * state transitions can be tested without a BOSS page or live network calls.
 */
let SchedulerBlacklist;
let SchedulerLimiter;
let SchedulerChat;
if (typeof require !== 'undefined') {
    try { SchedulerBlacklist = require('./blacklist.js'); } catch (_) { /* browser bundle */ }
    try { SchedulerLimiter = require('./rate_limiter.js'); } catch (_) { /* browser bundle */ }
    try { SchedulerChat = require('../platforms/boss_chat.js'); } catch (_) { /* browser bundle */ }
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
        this.chatManager = options.chatManager || (SchedulerChat ? new SchedulerChat.GeekChatClientManager() : (browser.GeekChatClientManager && new browser.GeekChatClientManager()));
        this.dailyLimit = this._normalizeDailyLimit(options.dailyLimit);
        this.maxConsecutiveFailures = Number.isFinite(options.maxConsecutiveFailures) ? Math.max(1, Math.floor(options.maxConsecutiveFailures)) : 3;
        const isBrowser = typeof window !== 'undefined';
        this.greetingDelay = options.greetingDelay !== undefined ? options.greetingDelay : (isBrowser ? 1500 : 0);
        this.state = SCHEDULER_STATES.IDLE;
        this.stats = { delivered: 0, blacklistSkipped: 0, contactedSkipped: 0, duplicateSkipped: 0, failed: 0, page: 0, limitReached: false, reason: null };
        this._listeners = new Set();
        this._runPromise = null;
        this._pauseWaiters = [];
        this._abortController = null;
        this.customGreeting = options.customGreeting || { enabled: isBrowser, text: '' };
        this._seenJobIds = new Set();
        this._consecutiveFailures = 0;
    }

    renderGreeting(template, job) {
        if (SchedulerChat?.renderGreetingTemplate) {
            return SchedulerChat.renderGreetingTemplate(template, job);
        }
        if (typeof window !== 'undefined' && typeof window.renderGreetingTemplate === 'function') {
            return window.renderGreetingTemplate(template, job);
        }
        if (!template || typeof template !== 'string') return '';
        const jobName = job?.jobName || job?.title || job?.job_name || '';
        const companyName = job?.companyName || job?.brandName || job?.company || '';
        return template
            .replace(/\{\{\s*jobName\s*\}\}/g, jobName)
            .replace(/\{\{\s*companyName\s*\}\}/g, companyName)
            .replace(/\{jobName\}/g, jobName)
            .replace(/\{companyName\}/g, companyName);
    }


    subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        this._listeners.add(listener);
        listener(this.snapshot());
        return () => this._listeners.delete(listener);
    }

    snapshot() { return { state: this.state, stats: { ...this.stats }, dailyLimit: this.dailyLimit }; }
    _normalizeDailyLimit(value) { return Number.isFinite(value) ? Math.min(99999, Math.max(1, Math.floor(value))) : 80; }
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
        if (this.customGreeting?.enabled !== false && this.chatManager && typeof this.chatManager.connect === 'function') {
            try {
                await this.chatManager.connect();
            } catch (connErr) {
                console.warn('长连接预热提示 (将在投递时尝试自动重连):', connErr?.message);
            }
        }
        while (await this._checkpoint()) {
            const rawJobs = await this.adapter.refresh_jobs();
            let jobs = (Array.isArray(rawJobs) ? rawJobs : []).filter(Boolean);
            let pageInfo = this.adapter.get_page_info ? this.adapter.get_page_info() : {};

            // 职位列表防空重试：若列表为空但尚未标记到底，等待片刻进行 1 次重试
            if (jobs.length === 0 && pageInfo.hasMore !== false) {
                await new Promise((r) => setTimeout(r, 800));
                if (!(await this._checkpoint())) return this.snapshot();
                const retryJobs = await this.adapter.refresh_jobs();
                jobs = (Array.isArray(retryJobs) ? retryJobs : []).filter(Boolean);
                pageInfo = this.adapter.get_page_info ? this.adapter.get_page_info() : {};
            }

            this.stats.page = Number(pageInfo.current || this.stats.page || 1); this._emit();
            const { allowed, blocked } = this.blacklist.batchFilter(jobs);
            this.stats.blacklistSkipped += blocked.length; this._emit();
            for (const job of allowed) {
                if (!(await this._checkpoint())) return this.snapshot();
                if (this.stats.delivered >= this.dailyLimit) { this.stats.limitReached = true; this._setState(SCHEDULER_STATES.COMPLETED, 'Daily delivery limit reached'); return this.snapshot(); }
                const jobKey = job.id || job.encryptJobId || job.securityId;
                if (jobKey && this._seenJobIds.has(jobKey)) { this.stats.duplicateSkipped++; this._emit(); continue; }
                if (job.contacted) { this.stats.contactedSkipped++; this._emit(); continue; }
                if (job.isHunter) {
                    this.stats.contactedSkipped++;
                    this._emit();
                    console.info(`[JobHelper] 岗位【${job.jobName || job.id} @ ${job.companyName || ''}】为猎头顾问岗位，已自动过滤跳过`);
                    continue;
                }
                if (jobKey) this._seenJobIds.add(jobKey);
                try {
                    const rawTemplate = (this.customGreeting?.text && this.customGreeting.text.trim())
                        ? this.customGreeting.text.trim()
                        : '您好！看到贵司正在招聘{jobName}，非常契合我的背景，希望能与您进一步沟通！';
                    const textToSend = this.renderGreeting(rawTemplate, job);

                    const deliverRes = await this.api.deliverJob(job, { greetingText: textToSend });
                    if (deliverRes?.contacted) {
                        this.stats.contactedSkipped++;
                        this._emit();
                        console.info(`[JobHelper] 岗位【${job.jobName || job.id} @ ${job.companyName || ''}】此前已沟通过，已自动排重跳过`);
                        continue;
                    }

                    this.stats.delivered++; this._emit();
                    this._consecutiveFailures = 0;

                    // 1. 打完招呼后将公司加入黑名单并全域广播
                    const companyToBlock = job.companyName || job.brandName || job.company;
                    if (companyToBlock && this.blacklist && typeof this.blacklist.addCompany === 'function') {
                        this.blacklist.addCompany(companyToBlock);
                    }

                    // 2. 发送高级打招呼消息 (通过 MQTT Protobuf 纯文本直达通道)
                    // 因 BOSS 直聘官方普通通道(friend/add.json)已不再下发开场白，默认全量使用高级招呼语文本通道
                    if (this.customGreeting?.enabled !== false && this.chatManager) {
                        if (textToSend && textToSend.trim()) {
                            try {
                                if (this.greetingDelay > 0) {
                                    await new Promise((r) => setTimeout(r, this.greetingDelay));
                                }

                                // 优先从岗位自带的 bossInfo 或 deliverRes 的 zpData 获取数字 bossId，无需额外网络请求
                                const zpData = deliverRes?.data?.zpData || deliverRes?.zpData;
                                const targetUid = Number(
                                    zpData?.bossId ||
                                    zpData?.uid ||
                                    job.bossId ||
                                    job.rawData?.bossInfo?.bossId ||
                                    0
                                );
                                const encBossId = String(
                                    zpData?.encryptBossId ||
                                    job.encryptBossId ||
                                    job.rawData?.bossInfo?.encryptBossId ||
                                    ''
                                );
                                const friendSource = Number(
                                    zpData?.friendSource ??
                                    job.bossSource ??
                                    job.rawData?.bossInfo?.bossSource ??
                                    0
                                );

                                let bossData = null;
                                if (targetUid > 0) {
                                    bossData = {
                                        bossId: targetUid,
                                        encryptBossId: encBossId,
                                        friendSource,
                                    };
                                } else {
                                    const getBossFn = this.api?.getBossData || (SchedulerChat?.getBossData) || (typeof window !== 'undefined' ? window.getBossData : null) || (typeof unsafeWindow !== 'undefined' ? unsafeWindow.getBossData : null);
                                    if (typeof getBossFn === 'function') {
                                        const freshSecId = zpData?.securityId || job.securityId;
                                        bossData = await getBossFn({ ...job, securityId: freshSecId }, {
                                            encryptBossId: encBossId,
                                        });
                                    }
                                }

                                if (bossData && typeof this.chatManager.sendMessage === 'function') {
                                    await this.chatManager.sendMessage(bossData, textToSend.trim(), job);
                                }
                            } catch (greetErr) {
                                console.warn('[JobHelper:Chat] 高级招呼语发送告警:', greetErr?.message);
                            }
                        }
                    }
                } catch (error) {
                    const isBusinessSkip = /该Boss今日沟通|沟通人数已达上限|沟通已达上限|不满足Boss|职位已关闭|暂停招聘|猎头职位/i.test(error?.message || '');
                    if (isBusinessSkip) {
                        console.info(`[JobHelper] ℹ️ 岗位【${job.jobName || job.id} @ ${job.companyName || ''}】平台限制跳过: ${error?.message || error}`);
                        this.stats.contactedSkipped++;
                        this._emit();
                        continue;
                    }

                    console.warn(`[JobHelper] ⚠️ 岗位【${job.jobName || job.id} @ ${job.companyName || ''}】投递异常: ${error?.message || error}`);
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
            if (pageInfo.hasMore === false) {
                this._setState(SCHEDULER_STATES.COMPLETED, 'No more pages');
                return this.snapshot();
            }
            if (this.pageBuffer) await this.limiter.afterPageChange({ signal: this._abortController.signal });
            if (!(await this._checkpoint())) return this.snapshot();
            if (!await this.adapter.next_page()) {
                // 翻页重试保护：避免因网络微波动过早终止流水线
                await new Promise((r) => setTimeout(r, 1000));
                if (!await this.adapter.next_page()) {
                    this._setState(SCHEDULER_STATES.COMPLETED, 'No next page available');
                    return this.snapshot();
                }
            }
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

})();

/* src/ui/fab.js */
;(function () {
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

})();

/* src/entry.js */
;(function () {
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

})();
