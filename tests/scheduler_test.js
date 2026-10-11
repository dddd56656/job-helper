const assert = require('assert');
const { DeliveryScheduler, SCHEDULER_STATES } = require('../src/core/scheduler.js');

const noDelay = { afterDelivery: async () => 0, afterPageChange: async () => 0 };
const passthroughBlacklist = { batchFilter: (jobs) => ({ allowed: jobs.filter((job) => job.companyName !== 'blocked'), blocked: jobs.filter((job) => job.companyName === 'blocked') }) };

async function testPipelineAndDeduplication() {
    const pages = [
        [{ id: '1', companyName: 'blocked' }, { id: '2', companyName: 'ok', securityId: 's2' }],
        [{ id: '2', companyName: 'ok', securityId: 's2' }, { id: '3', companyName: 'ok', securityId: 's3', contacted: true }, { id: '4', companyName: 'ok', securityId: 's4' }]
    ];
    let index = 0;
    const delivered = [];
    const scheduler = new DeliveryScheduler({
        adapter: { refresh_jobs: async () => pages[index], get_page_info: () => ({ current: index + 1, hasMore: index < 1 }), next_page: async () => (++index, true) },
        blacklist: passthroughBlacklist, limiter: noDelay, api: { deliverJob: async (job) => delivered.push(job.id) }
    });
    const final = await scheduler.start();
    assert.deepStrictEqual(delivered, ['2', '4']);
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

Promise.resolve()
    .then(testPipelineAndDeduplication)
    .then(testPauseCanResume)
    .then(testConsecutiveFailuresBreak)
    .then(() => console.log('scheduler pipeline tests passed'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
