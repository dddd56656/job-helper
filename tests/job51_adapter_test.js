const assert = require('assert');
const Job51Adapter = require('../src/platforms/job51_adapter.js');

global.document = {
    createElement: (tag) => createMockElement(tag)
};

function createMockElement(tagName, initialClassName = '', text = '') {
    const classListSet = new Set(initialClassName.split(' ').filter(Boolean));
    const children = [];
    const listeners = {};
    const dataset = {};
    const style = {};
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
            // Simplified selector matcher for testing
            const targetClass = selector.replace(/^\./, '').split(' ')[0];
            const targetTag = selector.split(' ').pop().toLowerCase();
            
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
            for (const child of children) {
                if (selector.split(',').some(s => child.classList && child.classList.contains(s.trim().replace(/^\./, '')))) {
                    results.push(child);
                }
            }
            return results;
        },
        setAttribute(k, v) { el[k] = v; },
        addEventListener(evt, fn) { listeners[evt] = fn; },
        dispatchEvent(evt) { if (listeners[evt.type]) listeners[evt.type](evt); }
    };
    return el;
}

async function runTests() {
    console.log('🧪 开始执行 Job51Adapter (前程无忧) 平台适配器单测...');

    const adapter = new Job51Adapter();

    // 1. 域名判定
    assert.strictEqual(adapter.isMatched('we.51job.com'), true);
    assert.strictEqual(adapter.isMatched('search.51job.com'), true);
    assert.strictEqual(adapter.isMatched('www.zhipin.com'), false);
    console.log('  ✅ 1. 51job 域名识别测试通过');

    // 2. 公司名称提取
    const card = createMockElement('div', 'joblist-item');
    const cnameEl = createMockElement('div', 'cname');
    const linkEl = createMockElement('a', '', '上海某某信息科技有限公司');
    cnameEl.appendChild(linkEl);
    card.appendChild(cnameEl);

    const extractedName = adapter.getCompanyName(card);
    assert.strictEqual(extractedName, '上海某某信息科技有限公司');
    console.log('  ✅ 2. 公司名称提取测试通过');

    // 3. 黑名单显隐判定与样式注入
    const blockedSet = new Set(['上海某某信息科技有限公司']);
    const mockBlacklist = {
        isBlocked: (name) => blockedSet.has(name),
        addCompany: (name) => blockedSet.add(name)
    };

    adapter.processCard(card, mockBlacklist);
    assert.strictEqual(card.classList.contains('universal-blocked'), true);
    assert.strictEqual(card.dataset.uProcessed, 'true');
    console.log('  ✅ 3. 卡片命中黑名单后自动标记 universal-blocked 测试通过');

    // 4. 白名单卡片不被屏蔽
    const okCard = createMockElement('div', 'joblist-item');
    const okCname = createMockElement('div', 'cname');
    okCname.appendChild(createMockElement('a', '', '非黑名单正常公司'));
    okCard.appendChild(okCname);

    adapter.processCard(okCard, mockBlacklist);
    assert.strictEqual(okCard.classList.contains('universal-blocked'), false);
    console.log('  ✅ 4. 正常公司卡片展示测试通过');

    // 5. 点击内联屏蔽按钮
    const btn = okCard.querySelector('.boss-btn-block');
    assert.ok(btn, '内联屏蔽按钮应当被成功注入');
    global.confirm = () => true;
    btn.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
    assert.strictEqual(blockedSet.has('非黑名单正常公司'), true);
    assert.strictEqual(okCard.classList.contains('universal-blocked'), true);
    console.log('  ✅ 5. 点击卡片内联屏蔽条立即拉黑并隐藏测试通过');

    console.log('🎉 Job51Adapter 全部测试通过！');
}

runTests().catch((err) => {
    console.error(err);
    process.exit(1);
});
