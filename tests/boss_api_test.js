import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthenticationError,
  BOSS_ENDPOINTS,
  PublishError,
  QuotaLimitError,
  RateLimitError,
  VerificationError,
  batchDeliverJobs,
  deliverJob,
  sendPublishReq,
} from '../src/platforms/boss_api.js';

const successResponse = () => ({ json: async () => ({ code: 0, message: 'ok' }) });

test('投递请求使用当前页凭证和岗位参数', async () => {
  const requests = [];
  await sendPublishReq({ securityId: 'sec', jobId: 'job' }, { token: 'token', fetchFn: async (url, init) => { requests.push({ url, init }); return successResponse(); } });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).origin + new URL(requests[0].url).pathname, BOSS_ENDPOINTS.FRIEND_ADD);
  assert.equal(new URL(requests[0].url).searchParams.get('jobId'), 'job');
  assert.equal(requests[0].init.headers.Zp_token, 'token');
});

test('120 位限额只熔断，不自动确认或重试', async () => {
  let calls = 0;
  await assert.rejects(
    () => sendPublishReq({ securityId: 'sec', jobId: 'job' }, { token: 'token', fetchFn: async () => { calls++; return { json: async () => ({ code: 1, message: '您今天已与120位BOSS沟通' }) }; } }),
    QuotaLimitError,
  );
  assert.equal(calls, 1);
});

test('网络异常不会自动重试非幂等投递', async () => {
  let calls = 0;
  await assert.rejects(
    () => sendPublishReq({ securityId: 'sec', jobId: 'job' }, { token: 'token', retries: 3, fetchFn: async () => { calls++; throw new Error('timeout'); } }),
    PublishError,
  );
  assert.equal(calls, 1);
});

test('认证、验证、限额和频控均被分类', async () => {
  const assertError = async (payload, Type) => assert.rejects(
    () => sendPublishReq({ securityId: 'sec', jobId: 'job' }, { token: 'token', fetchFn: async () => ({ json: async () => payload }) }),
    Type,
  );
  await assertError({ code: 1, message: '登录状态已失效' }, AuthenticationError);
  await assertError({ code: 1, message: '请完成安全验证' }, VerificationError);
  await assertError({ code: 1, message: '您今天已与150位BOSS沟通' }, QuotaLimitError);
  await assertError({ code: 1, message: '操作过于频繁' }, RateLimitError);
});

test('deliverJob 和批量接口保留结构化结果', async () => {
  const delivered = await deliverJob({ securityId: 'sec', encryptJobId: 'job' }, { token: 'token', fetchFn: async () => successResponse() });
  assert.equal(delivered.success, true);
  const report = await batchDeliverJobs([{ securityId: 'sec', jobId: 'job' }, { securityId: 'skip', jobId: 'skip', contacted: true }], { token: 'token', fetchFn: async () => successResponse(), intervalMs: 0 });
  assert.equal(report.successCount, 1);
  assert.equal(report.skippedCount, 1);
});
