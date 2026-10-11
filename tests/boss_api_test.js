/**
 * @file boss_api_test.js
 * @description BOSS直聘投递 API、凭证复用与限额熔断 Mock 单元测试
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BossApiError,
  PublishError,
  QuotaLimitError,
  RateLimitError,
  extractBstToken,
  confirmChatRemindLimit,
  sendPublishReq,
  deliverJob,
  batchDeliverJobs,
  deliverBatch,
  BOSS_ENDPOINTS,
} from '../src/platforms/boss_api.js';

test('1. 凭证提取测试 extractBstToken', async (t) => {
  await t.test('支持从显式参数获取 token', () => {
    const token = extractBstToken('custom-token-123');
    assert.equal(token, 'custom-token-123');
  });

  await t.test('支持从 document.cookie 获取 bst', () => {
    // 模拟浏览器 document.cookie 环境
    const originalDocument = globalThis.document;
    globalThis.document = {
      cookie: 'uuid=12345; bst=test-cookie-bst-token; Hm_lpvt=999',
    };

    const token = extractBstToken();
    assert.equal(token, 'test-cookie-bst-token');

    globalThis.document = originalDocument;
  });

  await t.test('支持从 window.Cookie.get 获取 bst', () => {
    const originalWindow = globalThis.window;
    globalThis.window = {
      Cookie: {
        get: (key) => (key === 'bst' ? 'window-cookie-bst-token' : null),
      },
    };

    const token = extractBstToken();
    assert.equal(token, 'window-cookie-bst-token');

    globalThis.window = originalWindow;
  });

  await t.test('缺失凭证且无显式传参时应返回 null', () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    delete globalThis.document;
    delete globalThis.window;

    const token = extractBstToken();
    assert.equal(token, null);

    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });
});

test('2. 投递报文结构与常规请求测试 sendPublishReq', async (t) => {
  await t.test('未提供凭证时抛出 PublishError', async () => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    delete globalThis.document;
    delete globalThis.window;

    await assert.rejects(
      async () => {
        await sendPublishReq({ securityId: 'sec_1', jobId: 'job_1' });
      },
      (err) => {
        assert.ok(err instanceof PublishError);
        assert.match(err.message, /未获取到有效凭证/);
        return true;
      },
    );

    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  });

  await t.test('正常投递成功报文与参数验证 (code === 0)', async () => {
    const capturedRequests = [];
    const mockFetch = async (url, init) => {
      capturedRequests.push({ url, init });
      return {
        json: async () => ({
          code: 0,
          message: 'Success',
          zpData: { greetStatus: 1 },
        }),
      };
    };

    const res = await sendPublishReq(
      { securityId: 'sec_mock_999', jobId: 'job_mock_888' },
      {
        token: 'token_mock_test',
        fetchFn: mockFetch,
      },
    );

    assert.equal(res.code, 0);
    assert.equal(capturedRequests.length, 1);

    const req = capturedRequests[0];
    const parsedUrl = new URL(req.url);

    // 验证接口地址、参数与头部信息
    assert.equal(parsedUrl.origin + parsedUrl.pathname, BOSS_ENDPOINTS.FRIEND_ADD);
    assert.equal(parsedUrl.searchParams.get('securityId'), 'sec_mock_999');
    assert.equal(parsedUrl.searchParams.get('jobId'), 'job_mock_888');
    assert.equal(req.init.method, 'POST');
    assert.equal(req.init.headers['Zp_token'], 'token_mock_test');
    assert.equal(req.init.headers['X-Requested-With'], 'XMLHttpRequest');
  });
});

test('3. 120人限额自动确认与携带 cid 重试机制', async (t) => {
  await t.test('返回120位限制时自动上报 chatremind 并带 { cid: 1 } 重试成功', async () => {
    const capturedCalls = [];

    const mockFetch = async (url, init) => {
      capturedCalls.push({ url, init });

      const parsedUrl = new URL(url);

      // 首次投递请求 (无 cid) -> 返回 120 软限额拦截
      if (
        parsedUrl.pathname === '/wapi/zpgeek/friend/add.json' &&
        !parsedUrl.searchParams.has('cid')
      ) {
        return {
          json: async () => ({
            code: 1,
            message: '沟通受限',
            zpData: {
              bizData: {
                chatRemindDialog: {
                  content: '您今天已与120位BOSS沟通，继续沟通请确认',
                  ba: 'mock-ba-signature-xyz',
                },
              },
            },
          }),
        };
      }

      // 解锁上报请求
      if (parsedUrl.pathname === '/wapi/zpCommon/actionLog/geek/chatremind.json') {
        return {
          json: async () => ({ code: 0, message: 'ok' }),
        };
      }

      // 解锁后重试投递请求 (带 cid=1) -> 成功
      if (
        parsedUrl.pathname === '/wapi/zpgeek/friend/add.json' &&
        parsedUrl.searchParams.get('cid') === '1'
      ) {
        return {
          json: async () => ({
            code: 0,
            message: 'Success After Unlock',
            zpData: { greetStatus: 1 },
          }),
        };
      }

      throw new Error(`未知调用: ${url}`);
    };

    const res = await sendPublishReq(
      { securityId: 'sec_120', jobId: 'job_120' },
      {
        token: 'token_120_test',
        fetchFn: mockFetch,
      },
    );

    assert.equal(res.code, 0);
    assert.equal(res.message, 'Success After Unlock');
    assert.equal(capturedCalls.length, 3);

    // 调用 1: 初次投递
    assert.equal(new URL(capturedCalls[0].url).pathname, '/wapi/zpgeek/friend/add.json');
    assert.equal(new URL(capturedCalls[0].url).searchParams.has('cid'), false);

    // 调用 2: 确认上报接口
    const remindUrl = new URL(capturedCalls[1].url);
    assert.equal(remindUrl.origin + remindUrl.pathname, BOSS_ENDPOINTS.CHAT_REMIND);
    assert.equal(remindUrl.searchParams.get('ba'), 'mock-ba-signature-xyz');
    assert.equal(remindUrl.searchParams.get('action'), 'addf-limit-popup-c');
    assert.equal(capturedCalls[1].init.headers['Zp_token'], 'token_120_test');

    // 调用 3: 携带 cid=1 自动重试投递
    const retryUrl = new URL(capturedCalls[2].url);
    assert.equal(retryUrl.searchParams.get('cid'), '1');
    assert.equal(retryUrl.searchParams.get('securityId'), 'sec_120');
  });

  await t.test('已带 cid=1 仍返回 120 限制时应停止并抛出 QuotaLimitError', async () => {
    const mockFetch = async () => ({
      json: async () => ({
        code: 1,
        message: '您今天已与120位BOSS沟通',
      }),
    });

    await assert.rejects(
      async () => {
        await sendPublishReq(
          { securityId: 'sec_inf', jobId: 'job_inf' },
          {
            token: 'test_token',
            fetchFn: mockFetch,
            _params: { cid: 1 },
          },
        );
      },
      (err) => {
        assert.ok(err instanceof QuotaLimitError);
        assert.match(err.message, /120位沟通限制确认后重试仍然受限/);
        return true;
      },
    );
  });
});

test('4. 150位硬性限额与频控异常拦截', async (t) => {
  await t.test('命中 150 位硬限制时抛出 QuotaLimitError', async () => {
    const mockFetch = async () => ({
      json: async () => ({
        code: 1,
        message: '您今天已与150位BOSS沟通，今日沟通人数已达上限，请明天再来',
        zpData: {
          bizData: {
            chatRemindDialog: {
              content: '您今天已与150位BOSS沟通，今日沟通人数已达上限',
            },
          },
        },
      }),
    });

    await assert.rejects(
      async () => {
        await sendPublishReq(
          { securityId: 'sec_150', jobId: 'job_150' },
          { token: 'token_150', fetchFn: mockFetch },
        );
      },
      (err) => {
        assert.ok(err instanceof QuotaLimitError);
        assert.match(err.message, /150位/);
        return true;
      },
    );
  });

  await t.test('命中频控时抛出 RateLimitError', async () => {
    const mockFetch = async () => ({
      json: async () => ({
        code: 1,
        message: '操作过于频繁，请稍后再试',
      }),
    });

    await assert.rejects(
      async () => {
        await sendPublishReq(
          { securityId: 'sec_rate', jobId: 'job_rate' },
          { token: 'token_rate', fetchFn: mockFetch },
        );
      },
      (err) => {
        assert.ok(err instanceof RateLimitError);
        assert.match(err.message, /操作过于频繁/);
        return true;
      },
    );
  });
});

test('5. 网络异常重试机制', async (t) => {
  let callCount = 0;
  const flakyFetch = async () => {
    callCount++;
    if (callCount < 3) {
      throw new Error(`网络闪断第 ${callCount} 次`);
    }
    return {
      json: async () => ({ code: 0, message: 'ok' }),
    };
  };

  const res = await sendPublishReq(
    { securityId: 'sec_flaky', jobId: 'job_flaky' },
    {
      token: 'test_token',
      retries: 3,
      fetchFn: flakyFetch,
    },
  );

  assert.equal(res.code, 0);
  assert.equal(callCount, 3);
});

test('6. 单岗位封装 deliverJob 测试', async (t) => {
  const mockFetch = async () => ({
    json: async () => ({ code: 0, message: '投递成功', zpData: {} }),
  });

  // 支持对象传参 (含兼容 encryptJobId)
  const res1 = await deliverJob(
    { securityId: 's1', encryptJobId: 'j1' },
    { token: 'tok', fetchFn: mockFetch },
  );
  assert.equal(res1.success, true);
  assert.equal(res1.jobId, 'j1');
  assert.equal(res1.securityId, 's1');

  // 支持位置参数 deliverJob(securityId, jobId)
  const res2 = await deliverJob('s2', 'j2', { token: 'tok', fetchFn: mockFetch });
  assert.equal(res2.success, true);
  assert.equal(res2.jobId, 'j2');
  assert.equal(res2.securityId, 's2');
});

test('7. 批量投递 batchDeliverJobs 与熔断机制测试', async (t) => {
  await t.test('正常批量投递与已沟通跳过', async () => {
    const jobs = [
      { securityId: 'sec_1', jobId: 'job_1', contacted: false },
      { securityId: 'sec_2', jobId: 'job_2', contacted: true }, // 应当被跳过
      { securityId: 'sec_3', jobId: 'job_3', contacted: false },
    ];

    const requestedJobIds = [];
    const mockFetch = async (url) => {
      const parsed = new URL(url);
      requestedJobIds.push(parsed.searchParams.get('jobId'));
      return {
        json: async () => ({ code: 0, message: 'ok' }),
      };
    };

    const report = await batchDeliverJobs(jobs, {
      token: 'tok_batch',
      fetchFn: mockFetch,
      intervalMs: 0,
    });

    assert.equal(report.total, 3);
    assert.equal(report.successCount, 2);
    assert.equal(report.skippedCount, 1);
    assert.equal(report.failedCount, 0);
    assert.equal(report.circuitBroken, false);
    assert.deepEqual(requestedJobIds, ['job_1', 'job_3']);
  });

  await t.test('命中 150 人硬限额时触发业务熔断并停止后续请求', async () => {
    const jobs = [
      { securityId: 'sec_1', jobId: 'job_1' },
      { securityId: 'sec_2', jobId: 'job_2' }, // 触发 150 硬封顶
      { securityId: 'sec_3', jobId: 'job_3' }, // 必须被熔断，不可发起请求
      { securityId: 'sec_4', jobId: 'job_4' },
    ];

    const requestedJobIds = [];
    let brokenTriggered = false;

    const mockFetch = async (url) => {
      const parsed = new URL(url);
      const jobId = parsed.searchParams.get('jobId');
      requestedJobIds.push(jobId);

      if (jobId === 'job_1') {
        return { json: async () => ({ code: 0, message: 'ok' }) };
      }
      if (jobId === 'job_2') {
        return {
          json: async () => ({
            code: 1,
            message: '您今天已与150位BOSS沟通，达到单日限制',
          }),
        };
      }
      return { json: async () => ({ code: 0, message: 'ok' }) };
    };

    const report = await batchDeliverJobs(jobs, {
      token: 'tok_batch',
      fetchFn: mockFetch,
      intervalMs: 0,
      onBreak: ({ reason }) => {
        brokenTriggered = true;
        assert.equal(reason, 'quota_exhausted');
      },
    });

    assert.equal(report.circuitBroken, true);
    assert.match(report.breakReason, /150/);
    assert.equal(report.successCount, 1);
    assert.equal(report.failedCount, 1);
    assert.equal(brokenTriggered, true);

    // 关键断言：熔断发生后，后续 job_3, job_4 绝不发起任何网络请求！
    assert.deepEqual(requestedJobIds, ['job_1', 'job_2']);
  });

  await t.test('命中操作频繁时触发熔断并停止后续请求', async () => {
    const jobs = [
      { securityId: 'sec_1', jobId: 'job_1' },
      { securityId: 'sec_2', jobId: 'job_2' }, // 触发频控
      { securityId: 'sec_3', jobId: 'job_3' },
    ];

    const requestedJobIds = [];
    const mockFetch = async (url) => {
      const parsed = new URL(url);
      const jobId = parsed.searchParams.get('jobId');
      requestedJobIds.push(jobId);

      if (jobId === 'job_1') {
        return { json: async () => ({ code: 0, message: 'ok' }) };
      }
      return {
        json: async () => ({
          code: 1,
          message: '操作过于频繁，请稍后再试',
        }),
      };
    };

    const report = await batchDeliverJobs(jobs, {
      token: 'tok_batch',
      fetchFn: mockFetch,
      intervalMs: 0,
    });

    assert.equal(report.circuitBroken, true);
    assert.match(report.breakReason, /平台频控/);
    assert.deepEqual(requestedJobIds, ['job_1', 'job_2']);
  });

  await t.test('deliverBatch 兼容别名导出可用性', () => {
    assert.equal(typeof deliverBatch, 'function');
    assert.equal(deliverBatch, batchDeliverJobs);
  });
});
