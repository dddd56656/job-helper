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
                if (jobKey) this._seenJobIds.add(jobKey);
                try {
                    const rawTemplate = (this.customGreeting?.text && this.customGreeting.text.trim())
                        ? this.customGreeting.text.trim()
                        : '您好！看到贵司正在招聘{jobName}，非常契合我的背景，希望能与您进一步沟通！';
                    const textToSend = this.renderGreeting(rawTemplate, job);

                    const deliverRes = await this.api.deliverJob(job, { greetingText: textToSend });
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

                                // 优先从投递成功的响应 zpData 中直接提取 Boss 信息（免多发一次网络请求）
                                const zpData = deliverRes?.data?.zpData || deliverRes?.zpData;
                                let bossData = null;
                                if (zpData && (zpData.bossId || zpData.uid)) {
                                    bossData = {
                                        bossId: zpData.bossId || zpData.uid,
                                        friendSource: zpData.friendSource ?? 0,
                                        encryptBossId: zpData.encryptBossId || job.encryptBossId || '',
                                    };
                                } else {
                                    const getBossFn = this.api?.getBossData || (SchedulerChat?.getBossData) || (typeof window !== 'undefined' ? window.getBossData : null) || (typeof unsafeWindow !== 'undefined' ? unsafeWindow.getBossData : null);
                                    if (typeof getBossFn === 'function') {
                                        bossData = await getBossFn(job, {
                                            encryptBossId: job.encryptBossId || job.bossId || '',
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
                    console.info(`[JobHelper] 岗位【${job.jobName || job.id} @ ${job.companyName || ''}】跳过投递/未成功: ${error?.message || error}`);
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
