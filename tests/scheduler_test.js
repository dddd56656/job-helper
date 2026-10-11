const assert = require('assert');
const { DeliveryScheduler, SCHEDULER_STATES } = require('../src/core/scheduler.js');

async function run() {
    const pages = [
        [{ id: '1', companyName: 'blocked' }, { id: '2', companyName: 'ok', securityId: 's2' }],
        [{ id: '3', companyName: 'ok', securityId: 's3', contacted: true }, { id: '4', companyName: 'ok', securityId: 's4' }]
    ];
    let index = 0;
    const delivered = [];
    const scheduler = new DeliveryScheduler({
        adapter: { refresh_jobs: async () => pages[index], get_page_info: () => ({ current: index + 1, hasMore: index < 1 }), next_page: async () => (++index, true) },
        blacklist: { batchFilter: (jobs) => ({ allowed: jobs.filter((job) => job.companyName !== 'blocked'), blocked: jobs.filter((job) => job.companyName === 'blocked') }) },
        limiter: { afterDelivery: async () => 0, afterPageChange: async () => 0 },
        api: { deliverJob: async (job) => delivered.push(job.id) },
        dailyLimit: 80
    });
    const final = await scheduler.start();
    assert.deepStrictEqual(delivered, ['2', '4']);
    assert.equal(final.stats.blacklistSkipped, 1);
    assert.equal(final.stats.contactedSkipped, 1);
    assert.equal(final.stats.page, 2);
    assert.equal(final.state, SCHEDULER_STATES.COMPLETED);
    console.log('scheduler pipeline test passed');
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
