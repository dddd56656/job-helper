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
                        .map(item => item.trim())
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

        const trimmed = companyName.trim();
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

        const trimmed = companyName.trim();
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

        const trimmed = companyName.trim();
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

            if (this.isBlocked(company, options)) {
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
