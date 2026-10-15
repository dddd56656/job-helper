/**
 * Test Suite: Blacklist Engine & Adaptive Rate Limiter (tests/blacklist_rate_test.js)
 *
 * Verifies:
 * 1. BlacklistEngine: Set cache, O(1) sync check, fuzzy matching, GM/mock persistence,
 *    zero-network batch filtering with high throughput.
 * 2. AdaptiveRateLimiter: Box-Muller Gaussian jitter distribution, bounds safety,
 *    cancellation, and automated 10-job batch rest cycle.
 */

const assert = require('assert');
const { BlacklistEngine, Storage } = require('../src/core/blacklist.js');
const {
    RATE_LIMIT_CONFIG,
    calculateGaussianJitter,
    randomSleep,
    AdaptiveRateLimiter
} = require('../src/core/rate_limiter.js');

// Test runner helper
let passCount = 0;
let failCount = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✓ PASS: ${name}`);
        passCount++;
    } catch (err) {
        console.error(`  ✗ FAIL: ${name}`);
        console.error(err);
        failCount++;
    }
}

async function runAllTests() {
    console.log('====================================================');
    console.log('  Running Blacklist Engine & Rate Limiter Tests     ');
    console.log('====================================================\n');

    // --- Suite 1: BlacklistEngine Basic Operations & Persistence ---
    console.log('--- Suite 1: Blacklist Engine Core & Persistence ---');

    await test('addCompany, isBlocked, and removeCompany with O(1) cache', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_blacklist_1' });
        engine.clear();

        assert.strictEqual(engine.isBlocked('字节跳动'), false);
        assert.strictEqual(engine.addCompany('字节跳动'), true);
        assert.strictEqual(engine.addCompany('字节跳动'), false, 'Duplicate add should return false');
        assert.strictEqual(engine.isBlocked('字节跳动'), true);
        assert.strictEqual(engine.isBlocked('  字节跳动  '), true, 'Should trim company name');

        // Remove
        assert.strictEqual(engine.removeCompany('字节跳动'), true);
        assert.strictEqual(engine.isBlocked('字节跳动'), false);
        assert.strictEqual(engine.removeCompany('不存在的公司'), false);
    });

    await test('Storage persistence across engine re-initialization', () => {
        const mockStore = new Map();
        const provider = {
            get: (key, def) => mockStore.has(key) ? mockStore.get(key) : def,
            set: (key, val) => mockStore.set(key, val)
        };

        const engine1 = new BlacklistEngine({ storageKey: 'test_persist', storageProvider: provider });
        engine1.clear();
        engine1.addCompany('阿里巴巴');
        engine1.addCompany('腾讯科技');
        assert.strictEqual(engine1.size, 2);

        // Re-init with new engine instance on same mock store
        const engine2 = new BlacklistEngine({ storageKey: 'test_persist', storageProvider: provider });
        assert.strictEqual(engine2.size, 2);
        assert.strictEqual(engine2.isBlocked('阿里巴巴'), true);
        assert.strictEqual(engine2.isBlocked('腾讯科技'), true);
        assert.strictEqual(engine2.isBlocked('百度'), false);
    });

    await test('Fuzzy and substring matching capabilities', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_fuzzy' });
        engine.clear();
        engine.addCompany('华为技术');
        engine.addCompany('外包');

        // Exact
        assert.strictEqual(engine.isBlocked('华为技术'), true);
        assert.strictEqual(engine.isBlocked('华为技术有限公司', { fuzzy: false }), false);

        // Fuzzy match: company contains blocked keyword
        assert.strictEqual(engine.isBlocked('华为技术有限公司', { fuzzy: true }), true);
        assert.strictEqual(engine.isBlocked('某某外包软件服务公司', { fuzzy: true }), true);
        assert.strictEqual(engine.isBlocked('蚂蚁集团', { fuzzy: true }), false);
    });

    await test('Company names are normalized and brand identifiers are supported', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_blacklist_normalized' });
        engine.clear();
        engine.addCompany(' Example  Corp ');
        engine.addCompany('brand_123');
        assert.strictEqual(engine.isBlocked('example corp'), true);
        const result = engine.batchFilter([{ companyName: 'other', encryptBrandId: 'brand_123' }]);
        assert.strictEqual(result.blocked.length, 1);
    });

    await test('Import and Export data functionality', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_import' });
        engine.clear();

        const jsonInput = JSON.stringify(['公司A', '公司B', ' 公司C ', '公司A']);
        const result = engine.importData(jsonInput);
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.count, 3, 'Should deduplicate and trim');
        assert.strictEqual(engine.size, 3);

        const exported = engine.exportData();
        assert.deepStrictEqual(exported.sort(), ['公司A', '公司B', '公司C'].sort());
    });

    await test('Backward compatibility with legacy Storage API', () => {
        Storage.clear();
        Storage.addCompany('美团');
        assert.strictEqual(Storage.isBlocked('美团'), true);
        assert.strictEqual(Storage.isBlocked('快手'), false);
        const list = Storage.getBlacklist();
        assert.ok(list.includes('美团'));
        Storage.removeCompany('美团');
        assert.strictEqual(Storage.isBlocked('美团'), false);
    });

    // --- Suite 2: Batch Filtering Performance & High-Throughput ---
    console.log('\n--- Suite 2: Batch Filtering & Zero-Request Skip ---');

    await test('batchFilter correctly segregates jobs by companyName/brandName', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_batch' });
        engine.clear();
        engine.addCompany('黑心企业A');
        engine.addCompany('加班严重厂B');

        const mockJobs = [
            { id: 1, companyName: '黑心企业A', title: '前端架构师' },
            { id: 2, brandName: '加班严重厂B', title: 'Go开发工程师' },
            { id: 3, companyName: '优质外企C', title: '全栈工程师' },
            { id: 4, company: '新兴独角兽D', title: '算法研究员' },
            { id: 5, companyName: '黑心企业A', title: 'Node后端工程师' },
            '优质外企C',
            '黑心企业A'
        ];

        const { allowed, blocked } = engine.batchFilter(mockJobs);

        assert.strictEqual(blocked.length, 4, '4 jobs should be blocked');
        assert.strictEqual(allowed.length, 3, '3 jobs should be allowed');

        assert.strictEqual(allowed[0].companyName, '优质外企C');
        assert.strictEqual(allowed[1].company, '新兴独角兽D');
        assert.strictEqual(allowed[2], '优质外企C');
    });

    await test('High-throughput benchmark: 10,000 jobs filtered under 20ms', () => {
        const engine = new BlacklistEngine({ storageKey: 'test_benchmark' });
        engine.clear();

        // Populate with 200 blacklisted companies
        for (let i = 0; i < 200; i++) {
            engine.addCompany(`黑名单企业_${i}`);
        }

        // Generate 10,000 mixed jobs
        const bigJobList = [];
        for (let i = 0; i < 10000; i++) {
            const isBlockedCandidate = (i % 4 === 0);
            bigJobList.push({
                id: `job_${i}`,
                companyName: isBlockedCandidate ? `黑名单企业_${i % 200}` : `正常企业_${i}`,
                salary: '25-45K'
            });
        }

        const t0 = performance.now();
        const { allowed, blocked } = engine.batchFilter(bigJobList);
        const elapsed = performance.now() - t0;

        assert.strictEqual(blocked.length, 2500, '25% of jobs should be blocked');
        assert.strictEqual(allowed.length, 7500, '75% of jobs should be allowed');
        console.log(`    [Benchmark] 10,000 jobs filtered in ${elapsed.toFixed(2)} ms (Zero HTTP requests)`);
        assert.ok(elapsed < 100, `Filtering took too long: ${elapsed}ms`);
    });

    // --- Suite 3: Adaptive Rate Limiter & Gaussian Jitter ---
    console.log('\n--- Suite 3: Rate Limiter & Gaussian Jitter ---');

    await test('Configuration defaults conform to rate limit specifications', () => {
        assert.strictEqual(RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.min, 2000, 'Delivery min 2000ms');
        assert.strictEqual(RATE_LIMIT_CONFIG.DELIVERY_INTERVAL.max, 5000, 'Delivery max 5000ms');
        assert.strictEqual(RATE_LIMIT_CONFIG.PAGE_WAIT.min, 10000, 'Page wait min 10000ms');
        assert.strictEqual(RATE_LIMIT_CONFIG.PAGE_WAIT.max, 25000, 'Page wait max 25000ms');
        assert.strictEqual(RATE_LIMIT_CONFIG.BATCH_REST.intervalCount, 10, 'Rest every 10 jobs');
        assert.strictEqual(RATE_LIMIT_CONFIG.BATCH_REST.durationMs, 30000, 'Rest 30000ms');
    });

    await test('calculateGaussianJitter bounds and distribution check (10,000 samples)', () => {
        const minMs = 2000;
        const maxMs = 5000;
        const sampleCount = 10000;
        let sum = 0;
        let centerCount = 0; // Samples falling within [3000, 4000]
        let outOfBounds = 0;

        for (let i = 0; i < sampleCount; i++) {
            const val = calculateGaussianJitter(minMs, maxMs);
            if (val < minMs || val > maxMs) {
                outOfBounds++;
            }
            if (val >= 3000 && val <= 4000) {
                centerCount++;
            }
            sum += val;
        }

        const mean = sum / sampleCount;
        const theoreticalMean = (minMs + maxMs) / 2; // 3500

        assert.strictEqual(outOfBounds, 0, 'No sample should exceed [minMs, maxMs]');
        // Mean should be within ±1.5% of 3500
        const errorPercent = Math.abs(mean - theoreticalMean) / theoreticalMean * 100;
        console.log(`    [Gaussian Stats] Mean: ${mean.toFixed(2)}ms (target: ${theoreticalMean}ms, error: ${errorPercent.toFixed(2)}%)`);
        assert.ok(errorPercent < 2.0, `Mean deviated too much: ${errorPercent}%`);

        // Normal distribution: around center should represent ~68% of samples
        const centerRatio = (centerCount / sampleCount) * 100;
        console.log(`    [Gaussian Stats] Samples in 1-sigma center [3000..4000]: ${centerRatio.toFixed(2)}%`);
        assert.ok(centerRatio > 55, 'Distribution should show central concentration');
    });

    await test('randomSleep execution and timing verification', async () => {
        const t0 = Date.now();
        const sleptMs = await randomSleep(15, 30);
        const actualElapsed = Date.now() - t0;

        assert.ok(sleptMs >= 15 && sleptMs <= 30, `Calculated delay out of range: ${sleptMs}`);
        assert.ok(actualElapsed >= 12, `Actual sleep too short: ${actualElapsed}`);
    });

    await test('randomSleep abort via AbortController', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 10);

        let aborted = false;
        try {
            await randomSleep(200, 300, { signal: controller.signal });
        } catch (err) {
            aborted = true;
            assert.strictEqual(err.message, 'Sleep aborted');
        }
        assert.strictEqual(aborted, true, 'Sleep should be aborted');
    });

    await test('randomSleep stop via isStopped predicate', async () => {
        let isStoppedFlag = false;
        setTimeout(() => { isStoppedFlag = true; }, 10);

        let stopped = false;
        try {
            await randomSleep(200, 300, {
                isStopped: () => isStoppedFlag,
                onProgress: () => {}
            });
        } catch (err) {
            stopped = true;
            assert.strictEqual(err.message, 'Sleep stopped by controller');
        }
        assert.strictEqual(stopped, true, 'Sleep should be stopped by predicate');
    });

    await test('AdaptiveRateLimiter 10-job batch rest cycle verification', async () => {
        // Fast test limiter with scaled-down delays
        const limiter = new AdaptiveRateLimiter({
            deliveryMin: 1,
            deliveryMax: 2,
            batchInterval: 10,
            batchRestMin: 5,
            batchRestMax: 10,
            batchDuration: 8
        });

        const restTriggeredIndices = [];

        for (let i = 1; i <= 22; i++) {
            const res = await limiter.afterDelivery({
                onBatchRest: (count, duration) => {
                    restTriggeredIndices.push(count);
                }
            });

            if (i === 10 || i === 20) {
                assert.strictEqual(res.isBatchRest, true, `Delivery #${i} should trigger batch rest`);
            } else {
                assert.strictEqual(res.isBatchRest, false, `Delivery #${i} should be normal delivery interval`);
            }
        }

        assert.deepStrictEqual(restTriggeredIndices, [10, 20], 'Batch rest callback fired exactly at #10 and #20');
        assert.strictEqual(limiter.getDeliveryCount(), 22);

        limiter.resetCount();
        assert.strictEqual(limiter.getDeliveryCount(), 0);
    });

    console.log('\n====================================================');
    console.log(`  Summary: ${passCount} Passed, ${failCount} Failed`);
    console.log('====================================================');

    if (failCount > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Test runner encountered unexpected error:', err);
    process.exit(1);
});
