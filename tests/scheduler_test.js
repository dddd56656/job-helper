const assert = require('assert');
const { DeliveryScheduler, SCHEDULER_STATES } = require('../src/core/scheduler.js');

const noDelay = { afterDelivery: async () => 0, afterPageChange: async () => 0 };
const passthroughBlacklist = { batchFilter: (jobs) => ({ allowed: jobs.filter((job) => job.companyName !== 'blocked'), blocked: jobs.filter((job) => job.companyName === 'blocked') }) };

async function testPipelineAndDeduplication() {
    const pages = [
        [{ id: '1', companyName: 'blocked' }, { id: '2', companyName: 'ok_comp_2', securityId: 's2' }],
        [{ id: '2', companyName: 'ok_comp_2', securityId: 's2' }, { id: '3', companyName: 'ok_comp_3', securityId: 's3', contacted: true }, { id: '4', companyName: 'ok_comp_4', securityId: 's4' }]
    ];
    let index = 0;
    const delivered = [];
    const autoBlocked = [];
    const mockBlacklist = {
        batchFilter: (jobs) => ({ allowed: jobs.filter((job) => job.companyName !== 'blocked'), blocked: jobs.filter((job) => job.companyName === 'blocked') }),
        addCompany: (comp) => autoBlocked.push(comp)
    };
    const scheduler = new DeliveryScheduler({
        adapter: { refresh_jobs: async () => pages[index], get_page_info: () => ({ current: index + 1, hasMore: index < 1 }), next_page: async () => (++index, true) },
        blacklist: mockBlacklist, limiter: noDelay, api: { deliverJob: async (job) => delivered.push(job.id) }
    });
    const final = await scheduler.start();
    assert.deepStrictEqual(delivered, ['2', '4']);
    assert.deepStrictEqual(autoBlocked, ['ok_comp_2', 'ok_comp_4']);
    assert.equal(final.stats.blacklistSkipped, 1);
    assert.equal(final.stats.duplicateSkipped, 1);
    assert.equal(final.stats.contactedSkipped, 1);
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
}

async function testPauseCanResume() {
    let resolveDelay;
    const scheduler = new DeliveryScheduler({
        adapter: { refresh_jobs: async () => [{ id: '1', securityId: 's' }], get_page_info: () => ({ current: 1, hasMore: false }), next_page: async () => false },
        blacklist: passthroughBlacklist,
        limiter: { afterDelivery: () => new Promise((resolve) => { resolveDelay = resolve; }), afterPageChange: async () => 0 },
        api: { deliverJob: async () => {} }
    });
    const running = scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    scheduler.pause();
    resolveDelay();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduler.state, SCHEDULER_STATES.PAUSED);
    scheduler.resume();
    const final = await running;
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
}

async function testConsecutiveFailuresBreak() {
    const scheduler = new DeliveryScheduler({
        adapter: { refresh_jobs: async () => [{ id: '1', securityId: '1' }, { id: '2', securityId: '2' }, { id: '3', securityId: '3' }], get_page_info: () => ({ current: 1, hasMore: false }), next_page: async () => false },
        blacklist: passthroughBlacklist, limiter: noDelay,
        api: { deliverJob: async () => { throw new Error('network unavailable'); } }, maxConsecutiveFailures: 3
    });
    const final = await scheduler.start();
    assert.equal(final.state, SCHEDULER_STATES.CIRCUIT_BROKEN);
    assert.match(final.stats.reason, /连续 3 次/);
}

async function testCustomGreetingInterpolation() {
    const receivedGreetings = [];
    const scheduler = new DeliveryScheduler({
        adapter: {
            refresh_jobs: async () => [{ id: '1', jobName: 'Node后端工程师', companyName: '极速科技', securityId: 's1' }],
            get_page_info: () => ({ current: 1, hasMore: false }),
            next_page: async () => false
        },
        blacklist: passthroughBlacklist,
        limiter: noDelay,
        api: {
            deliverJob: async (job, options) => {
                receivedGreetings.push(options?.greetingText);
            }
        },
        customGreeting: {
            enabled: true,
            text: '您好！应聘贵司【{companyName}】的【{jobName}】岗位！'
        }
    });

    const final = await scheduler.start();
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
    assert.deepStrictEqual(receivedGreetings, ['您好！应聘贵司【极速科技】的【Node后端工程师】岗位！']);
}

async function testEmptyPageRetryAndPaginationRecovery() {
    let refreshCalls = 0;
    let page = 1;
    const delivered = [];
    const scheduler = new DeliveryScheduler({
        adapter: {
            refresh_jobs: async () => {
                refreshCalls++;
                // 模拟第 1 次抓取为空（延迟），第 2 次重试才拿到数据
                if (refreshCalls === 1) return [];
                if (refreshCalls === 2) return [{ id: 'job_p1', securityId: 's1' }];
                return [{ id: 'job_p2', securityId: 's2' }];
            },
            get_page_info: () => ({ current: page, hasMore: page < 2 }),
            next_page: async () => {
                page++;
                return true;
            }
        },
        blacklist: passthroughBlacklist,
        limiter: noDelay,
        api: {
            deliverJob: async (job) => { delivered.push(job.id); }
        }
    });

    const final = await scheduler.start();
    assert.deepStrictEqual(delivered, ['job_p1', 'job_p2'], '空列表重试后应继续完成投递与翻页');
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
}

async function testAdvancedGreetingTextMessageDelivery() {
    let sentMessage = null;
    let sentBossData = null;
    let sentJob = null;
    const mockChatManager = {
        connect: async () => true,
        sendMessage: async (bossData, text, job) => {
            sentBossData = bossData;
            sentMessage = text;
            sentJob = job;
            return true;
        }
    };

    const scheduler = new DeliveryScheduler({
        adapter: {
            refresh_jobs: async () => [{ id: 'job_100', jobName: '架构师', companyName: '未来科技', securityId: 'sec_100' }],
            get_page_info: () => ({ current: 1, hasMore: false }),
            next_page: async () => false
        },
        blacklist: passthroughBlacklist,
        limiter: noDelay,
        chatManager: mockChatManager,
        greetingDelay: 0,
        api: {
            deliverJob: async () => {},
            getBossData: async (job) => ({ data: { bossId: 123456, bossSource: 0 } })
        },
        customGreeting: {
            enabled: true,
            text: '您好！我对贵司【{companyName}】的【{jobName}】非常感兴趣！'
        }
    });

    const final = await scheduler.start();
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
    assert.equal(sentMessage, '您好！我对贵司【未来科技】的【架构师】非常感兴趣！');
    assert.deepStrictEqual(sentBossData, { data: { bossId: 123456, bossSource: 0 } });
    assert.equal(sentJob.id, 'job_100');
}

Promise.resolve()
    .then(testPipelineAndDeduplication)
    .then(testPauseCanResume)
    .then(testConsecutiveFailuresBreak)
    .then(testCustomGreetingInterpolation)
    .then(testEmptyPageRetryAndPaginationRecovery)
    .then(testAdvancedGreetingTextMessageDelivery)
    .then(() => console.log('scheduler pipeline tests passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
