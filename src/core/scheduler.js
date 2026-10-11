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
