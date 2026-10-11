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
