const assert = require('assert');
const Job51Adapter = require('../src/platforms/job51_adapter.js');
const { BlacklistEngine } = require('../src/core/blacklist.js');

const mockBody = createMockElement('body');
global.document = {
    body: mockBody,
    createElement: (tag) => createMockElement(tag),
    querySelectorAll: (selector) => mockBody.querySelectorAll(selector)
};

function createMockElement(tagName, initialClassName = '', text = '') {
    const classListSet = new Set(initialClassName.split(' ').filter(Boolean));
    const children = [];
    const listeners = {};
    const dataset = {};
    const attrs = {};
    const style = {
        setProperty: (k, v) => { style[k] = v; },
        removeProperty: (k) => { delete style[k]; }
    };
    let _className = initialClassName;

    const el = {
        tagName: tagName.toUpperCase(),
        get className() { return _className; },
        set className(val) {
            _className = val;
            classListSet.clear();
            val.split(' ').filter(Boolean).forEach(c => classListSet.add(c));
        },
        classList: {
            add: (c) => classListSet.add(c),
            remove: (c) => classListSet.delete(c),
            contains: (c) => classListSet.has(c),
            get length() { return classListSet.size; }
        },
        dataset,
        style,
        innerText: text,
        textContent: text,
        children,
        parentElement: null,
        appendChild(child) {
            child.parentElement = el;
            children.push(child);
            return child;
        },
        querySelector(selector) {
            const trimmed = selector.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                const attrMatch = trimmed.slice(1, -1).split('=');
                const attrKey = attrMatch[0];
                const attrVal = attrMatch[1] ? attrMatch[1].replace(/['"]/g, '') : null;
                for (const child of children) {
                    const val = child.getAttribute(attrKey);
                    if (val !== null && (attrVal === null || val === attrVal)) {
                        return child;
                    }
                    const found = child.querySelector && child.querySelector(selector);
                    if (found) return found;
                }
                return null;
            }

            const targetClass = trimmed.replace(/^\./, '').split(' ')[0];
            const targetTag = trimmed.split(' ').pop().toLowerCase();
            
            for (const child of children) {
                if (child.classList && child.classList.contains(targetClass)) return child;
                if (child.tagName && child.tagName.toLowerCase() === targetTag) return child;
                const found = child.querySelector && child.querySelector(selector);
                if (found) return found;
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            const parts = selector.split(',').map(s => s.trim().replace(/^\./, ''));
            for (const child of children) {
                if (parts.some(s => child.classList && child.classList.contains(s))) {
                    results.push(child);
                }
                if (child.querySelectorAll) {
                    results.push(...child.querySelectorAll(selector));
                }
            }
            return results;
        },
        setAttribute(k, v) { attrs[k] = v; el[k] = v; },
        getAttribute(k) { return attrs[k] !== undefined ? attrs[k] : (el[k] !== undefined ? el[k] : null); },
        addEventListener(evt, fn) { listeners[evt] = fn; },
        dispatchEvent(evt) { if (listeners[evt.type]) listeners[evt.type](evt); }
    };
    return el;
}

async function runTests() {
    console.log('🧪 开始执行 Job51Adapter (前程无忧) 平台适配器全链路单测...');

    const adapter = new Job51Adapter();

    // 1. 域名判定
    assert.strictEqual(adapter.isMatched('we.51job.com'), true);
    assert.strictEqual(adapter.isMatched('search.51job.com'), true);
    assert.strictEqual(adapter.isMatched('www.zhipin.com'), false);
    console.log('  ✅ 1. 51job 域名识别测试通过');

    // 2. 公司名称提取 (支持标准 DOM)
    const card = createMockElement('div', 'joblist-item');
    const cnameEl = createMockElement('div', 'cname');
    const linkEl = createMockElement('a', '', '上海某某信息科技有限公司');
    cnameEl.appendChild(linkEl);
    card.appendChild(cnameEl);

    const extractedName = adapter.getCompanyName(card);
    assert.strictEqual(extractedName, '上海某某信息科技有限公司');
    console.log('  ✅ 2. 公司名称提取测试通过');

    // 3. title 属性优先与省略号清洗
    const truncatedCard = createMockElement('div', 'joblist-item');
    const truncatedLink = createMockElement('a', 'cname text-cut', '上海汉得信息技术...');
    truncatedLink.setAttribute('title', '上海汉得信息技术股份有限公司');
    truncatedCard.appendChild(truncatedLink);

    const fullTitleName = adapter.getCompanyName(truncatedCard);
    assert.strictEqual(fullTitleName, '上海汉得信息技术股份有限公司');
    console.log('  ✅ 3. title 属性提取与文本截断修复测试通过');

    // 4. 无 title 时的省略号清洗
    const rawDotCard = createMockElement('div', 'joblist-item');
    const dotLink = createMockElement('a', 'company-name', '中软国际科技服务有限公司…');
    rawDotCard.appendChild(dotLink);
    assert.strictEqual(adapter.getCompanyName(rawDotCard), '中软国际科技服务有限公司');
    console.log('  ✅ 4. 尾部省略号清理测试通过');

    // 5. 模糊子串匹配验证 (解决用户黑名单中的公司依然显示在屏幕上的根因)
    const mockStore = new Map();
    const provider = {
        get: (k, def) => mockStore.has(k) ? mockStore.get(k) : def,
        set: (k, v) => mockStore.set(k, v)
    };
    const realBlacklist = new BlacklistEngine({ storageKey: 'test_51job_fuzzy', storageProvider: provider });
    realBlacklist.clear();
    realBlacklist.addCompany('中软国际'); // 用户仅拉黑简称/关键词

    const jobCard = createMockElement('div', 'joblist-item');
    const jobLink = createMockElement('a', 'cname', '中软国际科技服务有限公司');
    jobCard.appendChild(jobLink);

    adapter.processCard(jobCard, realBlacklist);
    assert.strictEqual(jobCard.classList.contains('universal-blocked'), true, '卡片应被赋予 universal-blocked 类名');
    assert.strictEqual(jobCard.style.display, 'none', '卡片内联样式应被强制设置为 none !important');
    console.log('  ✅ 5. 黑名单模糊匹配与 DOM 强制隐藏测试通过');

    // 6. 白名单卡片不被屏蔽
    const okCard = createMockElement('div', 'joblist-item');
    const okCname = createMockElement('div', 'cname');
    okCname.appendChild(createMockElement('a', '', '非黑名单正常公司'));
    okCard.appendChild(okCname);

    adapter.processCard(okCard, realBlacklist);
    assert.strictEqual(okCard.classList.contains('universal-blocked'), false);
    assert.notStrictEqual(okCard.style.display, 'none');
    console.log('  ✅ 6. 正常公司卡片展示测试通过');

    // 7. 现代 51job 选择器支持 (.sensors_exposure_jobitem 等)
    const modernCard = createMockElement('div', 'sensors_exposure_jobitem');
    const modernName = createMockElement('a', 'com-name', '北京中软国际信息技术有限公司');
    modernCard.appendChild(modernName);

    adapter.processCard(modernCard, realBlacklist);
    assert.strictEqual(modernCard.classList.contains('universal-blocked'), true);
    console.log('  ✅ 7. 现代 51job 选择器兼容测试通过');

    // 8. 点击内联屏蔽按钮，全页面同公司卡片批量隐藏
    const container = createMockElement('div', 'search-container');
    const cardA = createMockElement('div', 'joblist-item');
    cardA.appendChild(createMockElement('a', 'cname', '某某外包公司'));
    const cardB = createMockElement('div', 'joblist-item');
    cardB.appendChild(createMockElement('a', 'cname', '某某外包公司'));

    container.appendChild(cardA);
    container.appendChild(cardB);
    mockBody.appendChild(container);

    adapter.processCard(cardA, realBlacklist);
    adapter.processCard(cardB, realBlacklist);

    assert.strictEqual(cardA.classList.contains('universal-blocked'), false);
    assert.strictEqual(cardB.classList.contains('universal-blocked'), false);

    const btn = cardA.querySelector('.boss-btn-block');
    assert.ok(btn, '内联屏蔽按钮应当被成功注入');
    global.confirm = () => true;

    // 触发屏蔽按钮点击
    btn.onclick({ stopPropagation: () => {}, preventDefault: () => {} });

    assert.strictEqual(realBlacklist.isBlocked('某某外包公司'), true);
    assert.strictEqual(cardA.classList.contains('universal-blocked'), true);
    assert.strictEqual(cardB.classList.contains('universal-blocked'), true, '同公司其它卡片应当联动隐藏');
    console.log('  ✅ 8. 点击内联屏蔽按钮全局联级隐藏测试通过');

    console.log('🎉 Job51Adapter 全部测试 100% 通过！');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
