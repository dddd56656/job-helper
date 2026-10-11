/**
 * Boss Vue 运行时劫持与原生翻页适配器 独立单体自测验证脚本
 *
 * 运行方式: node tests/boss_hooks_test.js
 * 纯原生 Node.js 驱动，零外部三方依赖。
 */

const assert = require('assert');
const BossHooks = require('../src/platforms/boss_hooks.js');
const BossPlatformAdapter = require('../src/platforms/boss_adapter.js');

// ==========================================
// 模拟浏览器与 DOM 环境
// ==========================================
class MockElement {
    constructor(tagName, id = '', className = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.children = [];
        this.parentNode = null;
        this.classList = {
            contains: (cls) => this.className.split(' ').includes(cls)
        };
        this.style = {};
        this.__vue__ = null;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }

    closest(selector) {
        let curr = this;
        while (curr) {
            if (curr._matches(selector)) return curr;
            curr = curr.parentNode;
        }
        return null;
    }

    _matches(selector) {
        const parts = selector.split(',').map(s => s.trim());
        for (const part of parts) {
            if (part.startsWith('#') && this.id === part.slice(1)) return true;
            if (part.startsWith('.') && this.classList.contains(part.slice(1))) return true;
            if (part.toLowerCase() === this.tagName.toLowerCase()) return true;
        }
        return false;
    }
}

class MockDocument {
    constructor() {
        this.body = new MockElement('body');
        this.elements = [];
    }

    createElement(tag) {
        return new MockElement(tag);
    }

    getElementById(id) {
        const find = (node) => {
            if (node.id === id) return node;
            for (const child of node.children) {
                const res = find(child);
                if (res) return res;
            }
            return null;
        };
        return find(this.body);
    }

    querySelector(selector) {
        const find = (node) => {
            const selectors = selector.split(',').map(s => s.trim());
            for (const sel of selectors) {
                if (sel === '#wrap .page-job-wrapper') {
                    if (node.id === 'wrap') {
                        for (const c of node.children) {
                            if (c.classList.contains('page-job-wrapper')) return c;
                        }
                    }
                } else if (sel.startsWith('#') && node.id === sel.slice(1)) {
                    return node;
                } else if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) {
                    return node;
                } else if (sel.startsWith('a[href*=') && node.tagName === 'A') {
                    const match = sel.match(/href\*="([^"]+)"/);
                    if (match && node.href && node.href.includes(match[1])) return node;
                } else if (sel.startsWith('[data-lid=') && node.lid) {
                    const match = sel.match(/data-lid="([^"]+)"/);
                    if (match && node.lid === match[1]) return node;
                }
            }

            for (const child of node.children) {
                const res = find(child);
                if (res) return res;
            }
            return null;
        };

        return find(this.body);
    }

    querySelectorAll(selector) {
        const results = [];
        const traverse = (node) => {
            const selectors = selector.split(',').map(s => s.trim());
            for (const sel of selectors) {
                if (sel.startsWith('.') && node.classList.contains(sel.slice(1))) {
                    results.push(node);
                    break;
                }
            }
            for (const child of node.children) {
                traverse(child);
            }
        };
        traverse(this.body);
        return results;
    }
}

// 注入模拟环境全局变量
global.document = new MockDocument();
global.window = {
    location: {
        hostname: 'www.zhipin.com',
        href: 'https://www.zhipin.com/web/geek/job-recommend'
    }
};
global.location = global.window.location;

// ==========================================
// 测试套件辅助函数
// ==========================================
let passedCount = 0;
let totalCount = 0;

async function test(name, fn) {
    totalCount++;
    try {
        await fn();
        console.log(`  ✅ [PASS] ${name}`);
        passedCount++;
    } catch (err) {
        console.error(`  ❌ [FAIL] ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

// ==========================================
// 执行测试用例
// ==========================================
async function runTests() {
    console.log('==================================================');
    console.log('🧪 开始执行 Boss直聘 Vue Hook 与原生翻页适配器单测');
    console.log('==================================================\n');

    // ------------------------------------------
    // 单元 1: boss_hooks.js 基础探测与劫持测试
    // ------------------------------------------
    console.log('--- 测试集 1: boss_hooks.js (Vue 探测与劫持) ---');

    await test('1.1 waitForElement: 立即命中与延迟挂载探测', async () => {
        const wrap = new MockElement('div', 'wrap');
        global.document.body.appendChild(wrap);

        // 立即命中
        const el = await BossHooks.waitForElement('#wrap', 1000);
        assert.strictEqual(el.id, 'wrap', '应正确找到 #wrap');

        // 异步挂载
        setTimeout(() => {
            const asyncEl = new MockElement('div', '', 'job-recommend-main');
            wrap.appendChild(asyncEl);
        }, 50);

        const elAsync = await BossHooks.waitForElement('.job-recommend-main', 1000);
        assert.ok(elAsync.classList.contains('job-recommend-main'), '应在异步挂载后成功捕获');
    });

    await test('1.2 waitForElement: 超时正确抛出错误', async () => {
        let errorCaught = false;
        try {
            await BossHooks.waitForElement('.not-exist-element', 150);
        } catch (e) {
            errorCaught = true;
            assert.ok(e.message.includes('未找到对应元素'), '应包含预期的超时错误信息');
        }
        assert.strictEqual(errorCaught, true, '超时未找到应抛出异常');
    });

    await test('1.3 useHookVueFn: 探测单一方法与绑定 this 上下文', async () => {
        const mockVue = {
            instanceId: 'vue_001',
            pageChangeAction(page) {
                return `navigated_${this.instanceId}_page_${page}`;
            }
        };

        const targetEl = global.document.querySelector('.job-recommend-main');
        targetEl.__vue__ = mockVue;

        const hookFn = BossHooks.useHookVueFn('.job-recommend-main', 'pageChangeAction', 1000);
        const pageChange = await hookFn();

        assert.strictEqual(typeof pageChange, 'function', '提取的方法应为函数');
        const res = pageChange(2);
        assert.strictEqual(res, 'navigated_vue_001_page_2', '函数应正确保持对 Vue 实例 this 上下文的绑定');
    });

    await test('1.4 useHookVueFn: 支持候选方法列表降级匹配 (searchJobAction / onSearch)', async () => {
        const mockVue = {
            onSearch(page) {
                return `searched_page_${page}`;
            }
        };

        const targetEl = global.document.querySelector('.job-recommend-main');
        targetEl.__vue__ = mockVue;

        const hookFn = BossHooks.useHookVueFn('.job-recommend-main', ['searchJobAction', 'onSearch'], 1000);
        const searchFn = await hookFn();

        assert.strictEqual(typeof searchFn, 'function', '应命中候选数组中的第二个方法');
        assert.strictEqual(searchFn(5), 'searched_page_5', '应正确执行降级方法');
    });

    await test('1.5 useHookVueData: 属性劫持、初始值同步与更新捕获 (Object.defineProperty)', async () => {
        let originalSetterCalled = false;
        let internalData = ['jobA', 'jobB'];

        const mockVue = {
            _data: { jobList: internalData }
        };
        // 模拟 Vue 2 的原有 getter 与 setter
        Object.defineProperty(mockVue, 'jobList', {
            configurable: true,
            enumerable: true,
            get() { return internalData; },
            set(val) {
                originalSetterCalled = true;
                internalData = val;
            }
        });

        const targetEl = global.document.querySelector('.job-recommend-main');
        targetEl.__vue__ = mockVue;

        let receivedUpdate = null;
        const holder = { value: null };

        const hookData = BossHooks.useHookVueData(
            '.job-recommend-main',
            'jobList',
            holder,
            (newVal) => { receivedUpdate = newVal; },
            1000
        );

        await hookData();

        // 验证初始值捕获
        assert.deepStrictEqual(holder.value, ['jobA', 'jobB'], '初始值应同步至 holder');
        assert.deepStrictEqual(receivedUpdate, ['jobA', 'jobB'], '初始值应触发 update 回调');

        // 验证后续数据变更
        const updatedList = ['jobA', 'jobB', 'jobC'];
        mockVue.jobList = updatedList;

        assert.deepStrictEqual(holder.value, updatedList, '更新后 holder.value 应同步');
        assert.deepStrictEqual(receivedUpdate, updatedList, '更新后应触发 update 回调');
        assert.strictEqual(originalSetterCalled, true, '原 Vue 内部 setter 应被正确透传调用');
        assert.deepStrictEqual(mockVue.jobList, updatedList, '读取 mockVue.jobList 仍能正常读取最新数据');
    });

    // ------------------------------------------
    // 单元 2: boss_adapter.js 平台适配器契约测试
    // ------------------------------------------
    console.log('\n--- 测试集 2: boss_adapter.js (标准平台适配器契约) ---');

    await test('2.1 isMatched: 正确判定 Boss直聘 平台域名', async () => {
        const adapter = new BossPlatformAdapter();
        assert.strictEqual(adapter.isMatched(), true, 'zhipin.com 应匹配成功');
    });

    await test('2.2 initContext & refresh_jobs: 结构化岗位数据标准化', async () => {
        const sampleJobs = [
            {
                encryptJobId: 'job_sec_01',
                securityId: 'sec_token_01',
                jobName: '资深逆向专家',
                brandName: '科技前沿公司',
                bossName: '张经理',
                salaryDesc: '35-50K',
                cityName: '北京',
                areaDistrict: '海淀区',
                businessDistrict: '中关村',
                contact: false,
                skills: ['JavaScript', 'Vue', 'Reverse'],
                jobLabels: ['5-10年', '本科'],
                lastModifyTime: 1710000000000,
                lid: 'lid_01'
            },
            {
                encryptJobId: 'job_sec_02',
                securityId: 'sec_token_02',
                jobName: '全栈架构师',
                brandName: '未来智能',
                bossName: '李总监',
                salaryDesc: '40-60K',
                cityName: '上海',
                areaDistrict: '浦东新区',
                contact: true,
                skills: ['Node.js', 'Go'],
                lastModifyTime: 1710000500000
            }
        ];

        let currentPage = 1;
        const mockVue = {
            jobList: sampleJobs,
            pageVo: { page: 1, pageSize: 15, total: 30 },
            hasMore: true,
            searchJobAction(page) {
                currentPage = page;
                mockVue.pageVo = { page, pageSize: 15, total: 30 };
                // 模拟网络请求返回下一页岗位
                setTimeout(() => {
                    mockVue.jobList = [
                        {
                            encryptJobId: 'job_sec_03',
                            securityId: 'sec_token_03',
                            jobName: 'DevOps 高级工程师',
                            brandName: '云端视界',
                            bossName: '王主管',
                            salaryDesc: '25-35K',
                            cityName: '深圳',
                            contact: false
                        }
                    ];
                }, 50);
            }
        };

        const targetEl = global.document.querySelector('.job-recommend-main');
        targetEl.__vue__ = mockVue;

        const adapter = new BossPlatformAdapter({ selectors: '.job-recommend-main' });
        await adapter.initContext();

        const normalizedJobs = await adapter.refresh_jobs();
        assert.strictEqual(normalizedJobs.length, 2, '岗位数量应为 2');

        const first = normalizedJobs[0];
        assert.strictEqual(first.id, 'job_sec_01', 'id 标准化');
        assert.strictEqual(first.securityId, 'sec_token_01', 'securityId 标准化');
        assert.strictEqual(first.jobName, '资深逆向专家', 'jobName 标准化');
        assert.strictEqual(first.companyName, '科技前沿公司', 'companyName 标准化');
        assert.strictEqual(first.hrName, '张经理', 'hrName 标准化');
        assert.strictEqual(first.salaryDesc, '35-50K', 'salaryDesc 标准化');
        assert.strictEqual(first.cityDistrict, '北京-海淀区-中关村', 'cityDistrict 拼接');
        assert.strictEqual(first.contacted, false, 'contacted 标识');
    });

    await test('2.3 get_page_info: 正确返回当前页码与底部状态', async () => {
        const adapter = new BossPlatformAdapter({ selectors: '.job-recommend-main' });
        adapter.pageVo = { page: 2, pageSize: 15, total: 60 };
        adapter.hasMore = true;

        const info = adapter.get_page_info();
        assert.strictEqual(info.current, 2);
        assert.strictEqual(info.pageSize, 15);
        assert.strictEqual(info.total, 60);
        assert.strictEqual(info.hasMore, true);

        adapter.hasMore = false;
        assert.strictEqual(adapter.get_page_info().hasMore, false, 'hasMore 为 false 时正确反馈');
    });

    await test('2.4 next_page: 调用底层翻页方法并成功感知数据更新', async () => {
        const adapter = new BossPlatformAdapter({ selectors: '.job-recommend-main' });
        await adapter.initContext();

        assert.strictEqual(adapter.get_page_info().current, 1);

        const navSuccess = await adapter.next_page({ timeout: 2000 });
        assert.strictEqual(navSuccess, true, '切页操作应返回 true');

        const newJobs = await adapter.refresh_jobs();
        assert.strictEqual(newJobs.length, 1, '新一页数据条数应为 1');
        assert.strictEqual(newJobs[0].jobName, 'DevOps 高级工程师', '应获取到第二页最新数据');
        assert.strictEqual(adapter.get_page_info().current, 2, '适配器页码状态应推进至 2');
    });

    await test('2.5 next_page: 到达底部 (hasMore = false) 拒绝翻页', async () => {
        const adapter = new BossPlatformAdapter({ selectors: '.job-recommend-main' });
        await adapter.initContext();
        adapter.hasMore = false;

        const result = await adapter.next_page();
        assert.strictEqual(result, false, '到底后应直接返回 false，禁止发起多余调用');
    });

    // ------------------------------------------
    // 单元 3: 替代 u-scroll-bait 机制测试
    // ------------------------------------------
    console.log('\n--- 测试集 3: 替代 u-scroll-bait 滚轮假死逻辑 ---');

    await test('3.1 replaceScrollLoader: 彻底移除 #u-scroll-bait 节点并接管 Loader', async () => {
        // 创建残存的 #u-scroll-bait 假 DOM 节点
        const bait = global.document.createElement('div');
        bait.id = 'u-scroll-bait';
        global.document.body.appendChild(bait);
        assert.ok(global.document.getElementById('u-scroll-bait'), '注入前应存在 scroll-bait 节点');

        const mockLoader = {
            triggerTrueReflowCalled: false,
            triggerSmartScrollCalled: false,
            triggerTrueReflow() { this.triggerTrueReflowCalled = true; },
            triggerSmartScroll() { this.triggerSmartScrollCalled = true; },
            checkAndLoad() { return 'legacy_scroll_based_loading'; }
        };
        const mockState = {
            isPaused: false,
            isAutoLoading: false,
            hasReachedLimit: false
        };

        const adapter = new BossPlatformAdapter({ selectors: '.job-recommend-main' });
        await adapter.initContext();
        adapter.hasMore = true;

        // 执行替换
        adapter.replaceScrollLoader(mockLoader, mockState);

        // 验证假 DOM 被移除
        assert.strictEqual(global.document.getElementById('u-scroll-bait'), null, '#u-scroll-bait 节点已被彻底清理');

        // 验证滚轮与重绘被废除
        mockLoader.triggerTrueReflow();
        mockLoader.triggerSmartScroll();
        assert.strictEqual(mockLoader.triggerTrueReflowCalled, false, '原版重绘函数应被中和');
        assert.strictEqual(mockLoader.triggerSmartScrollCalled, false, '原版智能滚轮应被中和');

        // 验证 Loader.checkAndLoad 由适配器原生接管
        let nextPageCalled = false;
        adapter.next_page = async () => {
            nextPageCalled = true;
            return true;
        };

        await mockLoader.checkAndLoad();
        assert.strictEqual(nextPageCalled, true, '调用 Loader.checkAndLoad 应直接触发适配器原生 next_page');
    });

    console.log('\n==================================================');
    console.log(`🎉 全部测试完成: ${passedCount}/${totalCount} 通过!`);
    console.log('==================================================\n');
}

runTests().catch((err) => {
    console.error('测试运行异常:', err);
    process.exit(1);
});
