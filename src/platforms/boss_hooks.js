/**
 * Boss直聘 Vue 2 运行时探测与劫持工具
 *
 * 核心职责：
 * 1. 纯原生 JavaScript 实现，完全剥离 Vue 3 (Ref / toValue) 依赖；
 * 2. 稳定探测页面 `#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main` 等容器上的 `.__vue__` 实例；
 * 3. 抽取与拦截 `jobList`, `pageVo`, `hasMore` 等核心响应式数据；
 * 4. 抽取 `pageChangeAction`（推荐页）与 `searchJobAction` / `onSearch`（搜索页）原生翻页方法。
 */

// 默认探测容器选择器列表
const DEFAULT_BOSS_JOB_SELECTORS = '#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main';
const DEFAULT_BOSS_ROOT_SELECTOR = '#wrap';

// 根 Vue 实例内存缓存
let cachedRootVue = null;

/**
 * 轮询等待 DOM 元素挂载
 * @param {string} selectors CSS选择器
 * @param {number} [timeout=20000] 超时时间（毫秒）
 * @param {number} [interval=50] 轮询间隔（毫秒）
 * @returns {Promise<Element>}
 */
function waitForElement(selectors, timeout = 20000, interval = 50) {
    return new Promise((resolve, reject) => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) {
            return reject(new Error('当前环境缺少 document 全局对象'));
        }

        const immediate = doc.querySelector(selectors);
        if (immediate) {
            return resolve(immediate);
        }

        const startTime = Date.now();
        const timer = setInterval(() => {
            const el = doc.querySelector(selectors);
            if (el) {
                clearInterval(timer);
                resolve(el);
            } else if (Date.now() - startTime >= timeout) {
                clearInterval(timer);
                reject(new Error(`未找到对应元素: ${selectors}`));
            }
        }, interval);
    });
}

/**
 * 轮询等待包含 `.__vue__` 实例的 DOM 节点
 * @param {string} selectors CSS选择器
 * @param {number} [timeout=20000] 超时时间（毫秒）
 * @param {number} [interval=50] 轮询间隔（毫秒）
 * @returns {Promise<any>} 返回 Vue 2 组件实例
 */
function waitForVueInstance(selectors, timeout = 20000, interval = 50) {
    return new Promise((resolve, reject) => {
        const doc = typeof document !== 'undefined' ? document : null;
        if (!doc) {
            return reject(new Error('当前环境缺少 document 全局对象'));
        }

        const immediate = doc.querySelector(selectors);
        if (immediate && immediate.__vue__) {
            return resolve(immediate.__vue__);
        }

        const startTime = Date.now();
        const timer = setInterval(() => {
            const el = doc.querySelector(selectors);
            if (el && el.__vue__) {
                clearInterval(timer);
                resolve(el.__vue__);
            } else if (Date.now() - startTime >= timeout) {
                clearInterval(timer);
                reject(new Error(`未在元素 [${selectors}] 上找到 Vue 实例`));
            }
        }, interval);
    });
}

/**
 * 获取 Boss 直聘全局根 Vue 实例 (#wrap.__vue__)
 * @param {number} [timeout=20000]
 * @returns {Promise<any>}
 */
async function getRootVue(timeout = 20000) {
    if (cachedRootVue) {
        return cachedRootVue;
    }
    const rootVue = await waitForVueInstance(DEFAULT_BOSS_ROOT_SELECTOR, timeout);
    cachedRootVue = rootVue;
    return rootVue;
}

/**
 * 纯原生 JS 劫持 Vue 实例的响应式数据
 *
 * 替代 boss-helper 中对 Vue 3 Ref 的强依赖：
 * - dataHolder 可为包含 .value 的普通对象，或由 onUpdate 接收值；
 * - 劫持 property setter，确保 Boss 异步拉取新数据时自动触发通知；
 * - 完好保留原有 getter 与 setter，避免页面原有渲染逻辑异常。
 *
 * @param {string} selectors DOM 选择器
 * @param {string} key 劫持的 Vue 属性名（如 jobList, pageVo, hasMore）
 * @param {object|function} [dataHolder] 数据持有对象 { value: any } 或回调函数
 * @param {function} [onUpdate] 更新回调函数 (newVal) => void
 * @param {number} [timeout=20000]
 * @returns {() => Promise<any>} 返回异步执行函数
 */
function useHookVueData(selectors, key, dataHolder, onUpdate, timeout = 20000) {
    let updateCallback = onUpdate;
    let targetHolder = dataHolder;

    if (typeof dataHolder === 'function' && typeof onUpdate !== 'function') {
        updateCallback = dataHolder;
        targetHolder = null;
    }

    return async () => {
        const jobVue = await waitForVueInstance(selectors, timeout);

        let currentValue = jobVue[key];

        // 初始同步
        if (targetHolder && typeof targetHolder === 'object' && 'value' in targetHolder) {
            targetHolder.value = currentValue;
        }
        if (typeof updateCallback === 'function') {
            updateCallback(currentValue);
        }

        // 获取原有的 property descriptor 与 setter/getter
        const desc = Object.getOwnPropertyDescriptor(jobVue, key);
        const originalSet = (typeof jobVue.__lookupSetter__ === 'function' && jobVue.__lookupSetter__(key))
            || (desc && desc.set);
        const originalGet = (typeof jobVue.__lookupGetter__ === 'function' && jobVue.__lookupGetter__(key))
            || (desc && desc.get);

        // 劫持 setter，捕获后续每次页面数据更新
        Object.defineProperty(jobVue, key, {
            configurable: true,
            enumerable: true,
            get() {
                if (originalGet) {
                    return originalGet.call(this);
                }
                return currentValue;
            },
            set(val) {
                currentValue = val;
                if (targetHolder && typeof targetHolder === 'object' && 'value' in targetHolder) {
                    targetHolder.value = val;
                }
                if (typeof updateCallback === 'function') {
                    updateCallback(val);
                }
                if (originalSet) {
                    originalSet.call(this, val);
                }
            }
        });

        return jobVue;
    };
}

/**
 * 纯原生 JS 提取并绑定 Vue 实例上的方法
 *
 * 支持单一键名或数组键名降级匹配（如 ['searchJobAction', 'onSearch']）
 * 自动绑定 Vue 实例上下文，防止脱离实例后 this 指向丢失。
 *
 * @param {string} selectors DOM 选择器
 * @param {string|string[]} keys 目标方法名或候选方法名数组
 * @param {number} [timeout=20000]
 * @returns {() => Promise<Function|undefined>}
 */
function useHookVueFn(selectors, keys, timeout = 20000) {
    return async () => {
        const jobVue = await waitForVueInstance(selectors, timeout);
        const keyList = Array.isArray(keys) ? keys : [keys];

        for (const k of keyList) {
            if (jobVue && typeof jobVue[k] === 'function') {
                return jobVue[k].bind(jobVue);
            } else if (jobVue && jobVue[k] !== undefined) {
                return jobVue[k];
            }
        }
        return undefined;
    };
}

/**
 * 重置根 Vue 缓存（用于测试或页面硬刷新场景）
 */
function resetRootVueCache() {
    cachedRootVue = null;
}

// 统一导出兼容 Node.js (CommonJS) / ES Module / 浏览器环境
const BossHooks = {
    DEFAULT_BOSS_JOB_SELECTORS,
    DEFAULT_BOSS_ROOT_SELECTOR,
    waitForElement,
    waitForVueInstance,
    getRootVue,
    useHookVueData,
    useHookVueFn,
    resetRootVueCache
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BossHooks;
}
if (typeof window !== 'undefined') {
    window.BossHooks = BossHooks;
}
