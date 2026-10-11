/**
 * @file boss_api.js
 * @description BOSS直聘原生投递请求、凭证复用与限额熔断平台驱动层
 * @author Google Senior Security & API Engineer
 */

/**
 * 平台通用 API 异常基类
 */
export class BossApiError extends Error {
  /**
   * @param {string} message - 错误信息
   * @param {Object} [options] - 附加错误详情
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'BossApiError';
    this.details = options.details;
    this.response = options.response;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * 投递常规异常
 */
export class PublishError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'PublishError';
  }
}

/**
 * 配额超限硬性熔断异常 (单日达 150 人硬封顶)
 */
export class QuotaLimitError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'QuotaLimitError';
    this.limit = 150;
  }
}

/**
 * 平台风控频控异常 (操作过于频繁)
 */
export class RateLimitError extends BossApiError {
  constructor(message, options) {
    super(message, options);
    this.name = 'RateLimitError';
  }
}

/**
 * BOSS直聘相关 API 端点
 */
export const BOSS_ENDPOINTS = {
  FRIEND_ADD: 'https://www.zhipin.com/wapi/zpgeek/friend/add.json',
  CHAT_REMIND: 'https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json',
};

/**
 * 从当前运行环境 (Cookie / 全局对象 / 自定义参数) 中自动提取 bst 凭证
 * @param {string} [explicitToken] - 显式指定的 token
 * @returns {string|null}
 */
export function extractBstToken(explicitToken) {
  if (explicitToken && typeof explicitToken === 'string') {
    return explicitToken.trim();
  }

  // 1. 从宿主页面 window.Cookie 获取
  if (typeof window !== 'undefined' && window.Cookie && typeof window.Cookie.get === 'function') {
    try {
      const token = window.Cookie.get('bst');
      if (token) return token;
    } catch (_) {}
  }

  // 2. 从 document.cookie 中提取 bst 键值
  if (typeof document !== 'undefined' && typeof document.cookie === 'string') {
    const match = document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  // 3. 从 window 页面全局状态尝试获取
  if (typeof window !== 'undefined') {
    if (window._PAGE?.token) return window._PAGE.token;
    if (window._PAGE?.zpToken) return window._PAGE.zpToken;
    if (window.Zp_token) return window.Zp_token;
  }

  return null;
}

/**
 * 向 actionLog 发送 120 人限额提醒解除上报
 * @param {Object} params
 * @param {string} [params.ba] - 弹窗回传的校验 ba 凭据
 * @param {string} [params.token] - Zp_token 凭据
 * @param {Function} [params.fetchFn] - 可注入的 fetch 实现
 * @returns {Promise<Response>}
 */
export async function confirmChatRemindLimit({ ba, token, fetchFn = globalThis.fetch } = {}) {
  const url = new URL(BOSS_ENDPOINTS.CHAT_REMIND);
  if (ba) {
    url.searchParams.set('ba', String(ba));
  }
  url.searchParams.set('action', 'addf-limit-popup-c');

  const headers = {};
  if (token) {
    headers['Zp_token'] = token;
  }

  return await fetchFn(url.toString(), {
    method: 'POST',
    headers,
    credentials: 'include',
  });
}

/**
 * 发送单笔投递请求 (核心底层网络请求方法)
 * @param {Object} data - 岗位参数
 * @param {string} data.securityId - BOSS直聘安全凭证 securityId
 * @param {string} [data.jobId] - 岗位加密 ID
 * @param {string} [data.encryptJobId] - 岗位加密 ID 兼容别名
 * @param {string} [data.id] - 岗位 ID 兼容别名
 * @param {Object|string} [optionsOrErrorMsg={}] - 配置项对象或重试失败默认提示
 * @param {number} [retries=3] - 网络重试次数
 * @param {Object} [_params={}] - 额外附加请求参数 (如 { cid: 1 })
 * @returns {Promise<Object>} 接口返回的原始 JSON 数据
 */
export async function sendPublishReq(data, optionsOrErrorMsg = {}, retries = 3, _params = {}) {
  // 规范化配置项，兼容对象参数与位置参数两种形式
  let options = {};
  if (typeof optionsOrErrorMsg === 'string') {
    options = {
      errorMsg: optionsOrErrorMsg,
      retries,
      _params,
    };
  } else if (typeof optionsOrErrorMsg === 'object' && optionsOrErrorMsg !== null) {
    options = { ...optionsOrErrorMsg };
  }

  const currentRetries = options.retries !== undefined ? options.retries : 3;
  if (currentRetries <= 0) {
    throw new PublishError(options.errorMsg || '投递请求重试多次失败');
  }

  const targetJobId = data?.jobId || data?.encryptJobId || data?.id;
  const targetSecurityId = data?.securityId;

  if (!targetJobId || !targetSecurityId) {
    throw new PublishError('缺少必要的投递参数: securityId 或 jobId');
  }

  // 凭证提取与复用
  const token = extractBstToken(options.token);
  if (!token) {
    throw new PublishError('未获取到有效凭证(bst/Zp_token)，请确认是否已登录BOSS直聘');
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new PublishError('当前环境未找到可用的 fetch 实现');
  }

  // 构造请求 URL 与查询参数
  const url = new URL(BOSS_ENDPOINTS.FRIEND_ADD);
  url.searchParams.set('securityId', targetSecurityId);
  url.searchParams.set('jobId', targetJobId);

  const extraParams = options._params || {};
  for (const [key, val] of Object.entries(extraParams)) {
    if (val !== undefined && val !== null) {
      url.searchParams.set(key, String(val));
    }
  }

  const headers = {
    'Zp_token': token,
    'X-Requested-With': 'XMLHttpRequest',
    ...(options.headers || {}),
  };

  try {
    const rawRes = await fetchFn(url.toString(), {
      method: 'POST',
      headers,
      credentials: 'include',
    });

    const res = await rawRes.json();

    // code === 0: 投递成功
    if (res.code === 0) {
      return res;
    }

    // code === 1: 业务异常与限额分流拦截
    if (res.code === 1) {
      const content = String(
        res?.zpData?.bizData?.chatRemindDialog?.content || res?.message || '未知错误',
      );

      // 1. 命中 120 位软限额弹窗 -> 自动确认解除限制并携带 { cid: 1 } 重试
      if (content.includes('120位') || content.includes('已与120位BOSS沟通')) {
        // 防止携带 cid 仍反复返回 120 造成死循环
        if (extraParams.cid === 1) {
          throw new QuotaLimitError(`120位沟通限制确认后重试仍然受限: ${content}`, { response: res });
        }

        try {
          const ba = res?.zpData?.bizData?.chatRemindDialog?.ba;
          await confirmChatRemindLimit({ ba, token, fetchFn });

          // 解除成功后，自动携带 { cid: 1 } 重新发起投递
          return await sendPublishReq(data, {
            ...options,
            _params: { ...extraParams, cid: 1 },
          });
        } catch (err) {
          if (err instanceof BossApiError) throw err;
          throw new PublishError(`解除120位投递限制确认请求失败: ${err.message}`, {
            details: err,
            response: res,
          });
        }
      }

      // 2. 命中 150 位硬性上限 -> 抛出 QuotaLimitError 触发业务熔断
      if (content.includes('150位') || content.includes('已与150位BOSS沟通')) {
        throw new QuotaLimitError(content, { response: res });
      }

      // 3. 命中频控拦截 -> 抛出 RateLimitError
      if (content.includes('操作过于频繁')) {
        throw new RateLimitError(content, { response: res });
      }

      // 其他业务错误
      throw new PublishError(content, { response: res });
    }

    // 其它非 0 状态码
    throw new PublishError(res?.message || `未知错误状态码: ${res.code}`, { response: res });
  } catch (err) {
    // 凡是明确的业务/配额/频控异常，不可盲目网络重试，必须直接向上抛出
    if (err instanceof BossApiError) {
      throw err;
    }

    // 网络层抖动或超时，执行重试递减
    if (currentRetries > 1) {
      return await sendPublishReq(data, {
        ...options,
        retries: currentRetries - 1,
        errorMsg: err?.message,
      });
    }

    throw new PublishError(err?.message || '投递网络请求失败，已耗尽重试次数', { details: err });
  }
}

/**
 * 封装单岗位投递核心方法
 * @param {Object|string} job - 岗位对象（含 securityId, jobId）或 securityId 字符串
 * @param {Object|string} [optionsOrJobId={}] - 配置项或 jobId 字符串
 * @param {Object} [maybeOptions={}] - 额外配置项
 * @returns {Promise<{ success: boolean, jobId: string, securityId: string, data: Object, message: string }>}
 */
export async function deliverJob(job, optionsOrJobId = {}, maybeOptions = {}) {
  let jobData = {};
  let options = {};

  if (typeof job === 'string') {
    jobData = {
      securityId: job,
      jobId: optionsOrJobId,
    };
    options = maybeOptions || {};
  } else if (typeof job === 'object' && job !== null) {
    jobData = {
      securityId: job.securityId,
      jobId: job.jobId || job.encryptJobId || job.id,
    };
    options = optionsOrJobId || {};
  } else {
    throw new PublishError('无效的岗位参数，必须提供 securityId 与 jobId');
  }

  const res = await sendPublishReq(jobData, options);
  return {
    success: true,
    jobId: jobData.jobId,
    securityId: jobData.securityId,
    data: res,
    message: res?.message || '投递成功',
  };
}

/**
 * 批量投递核心方法 (带限额熔断与结构化统计报告)
 * @param {Array<Object>} jobs - 待投递岗位列表
 * @param {Object} [options={}] - 批量调度配置
 * @param {number|Function} [options.intervalMs=2500] - 单次投递安全间隔 (毫秒) 或动态延时函数
 * @param {Function} [options.onProgress] - 进度回调 ({ index, total, job, result, status }) => void
 * @param {Function} [options.onBreak] - 熔断触发回调 ({ reason, error, job, index }) => void
 * @param {AbortSignal} [options.signal] - 外部中止信号
 * @param {boolean} [options.stopOnError=false] - 遇常规错误是否立即停止
 * @param {string} [options.token] - 自定义凭据 token
 * @param {Function} [options.fetchFn] - 可注入的 fetch 实现
 * @returns {Promise<{
 *   total: number,
 *   successCount: number,
 *   failedCount: number,
 *   skippedCount: number,
 *   circuitBroken: boolean,
 *   breakReason: string|null,
 *   results: Array<Object>,
 *   errors: Array<Object>
 * }>}
 */
export async function batchDeliverJobs(jobs, options = {}) {
  const {
    intervalMs = 2500,
    onProgress = null,
    onBreak = null,
    signal = null,
    stopOnError = false,
    token = null,
    fetchFn = globalThis.fetch,
  } = options;

  if (!Array.isArray(jobs)) {
    throw new PublishError('jobs 必须为岗位对象数组');
  }

  const results = [];
  const errors = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let circuitBroken = false;
  let breakReason = null;

  for (let i = 0; i < jobs.length; i++) {
    // 1. 检查外部取消信号
    if (signal && signal.aborted) {
      circuitBroken = true;
      breakReason = '任务被外部信号中止';
      break;
    }

    const job = jobs[i];

    // 2. 检查是否已经沟通过
    if (job?.contacted) {
      skippedCount++;
      const skipItem = {
        job,
        index: i,
        success: false,
        status: 'skipped_contacted',
        message: '该岗位已沟通，自动跳过',
      };
      results.push(skipItem);
      onProgress?.({ index: i, total: jobs.length, job, result: skipItem, status: 'skipped_contacted' });
      continue;
    }

    // 3. 执行单岗位投递
    try {
      const res = await deliverJob(job, { token, fetchFn });
      successCount++;
      const successItem = {
        job,
        index: i,
        success: true,
        status: 'delivered',
        result: res,
      };
      results.push(successItem);
      onProgress?.({ index: i, total: jobs.length, job, result: successItem, status: 'delivered' });
    } catch (err) {
      failedCount++;

      // 4. 限额 150 硬性熔断处理
      if (err instanceof QuotaLimitError) {
        circuitBroken = true;
        breakReason = `命中每日上限硬性限制 (150位): ${err.message}`;
        const errorItem = {
          job,
          index: i,
          success: false,
          status: 'quota_exhausted',
          error: err,
        };
        results.push(errorItem);
        errors.push({ job, error: err, isCircuitBreak: true });
        onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'quota_exhausted' });
        onBreak?.({ reason: 'quota_exhausted', error: err, job, index: i });
        break; // 立即熔断，不再执行任何后续网络请求
      }

      // 5. 频控风控硬性熔断处理
      if (err instanceof RateLimitError) {
        circuitBroken = true;
        breakReason = `命中平台频控风控: ${err.message}`;
        const errorItem = {
          job,
          index: i,
          success: false,
          status: 'rate_limited',
          error: err,
        };
        results.push(errorItem);
        errors.push({ job, error: err, isCircuitBreak: true });
        onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'rate_limited' });
        onBreak?.({ reason: 'rate_limited', error: err, job, index: i });
        break; // 立即熔断，停止后续请求
      }

      // 6. 其他常规错误 (如单岗位已下线或未知失败)
      const errorItem = {
        job,
        index: i,
        success: false,
        status: 'failed',
        error: err,
      };
      results.push(errorItem);
      errors.push({ job, error: err, isCircuitBreak: false });
      onProgress?.({ index: i, total: jobs.length, job, result: errorItem, status: 'failed' });

      if (stopOnError) {
        circuitBroken = true;
        breakReason = `遇到投递错误已停止: ${err.message}`;
        break;
      }
    }

    // 7. 岗位之间随机/配置延时等待 (未熔断且非最后一个岗位时生效)
    if (i < jobs.length - 1 && !circuitBroken) {
      const delay = typeof intervalMs === 'function' ? intervalMs() : Number(intervalMs) || 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  return {
    total: jobs.length,
    successCount,
    failedCount,
    skippedCount,
    circuitBroken,
    breakReason,
    results,
    errors,
  };
}

/**
 * 批量投递兼容别名导出
 */
export const deliverBatch = batchDeliverJobs;

// Browser entry point used by the production userscript bundle.  Keeping this
// explicit also lets the scheduler receive the API as a dependency in tests.
if (typeof window !== 'undefined') {
  window.BossApi = {
    BossApiError,
    PublishError,
    QuotaLimitError,
    RateLimitError,
    BOSS_ENDPOINTS,
    extractBstToken,
    confirmChatRemindLimit,
    sendPublishReq,
    deliverJob,
    batchDeliverJobs,
    deliverBatch,
  };
}
