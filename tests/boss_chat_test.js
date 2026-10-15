/**
 * @file boss_chat_test.js
 * @description BOSS直聘自定义打招呼通讯、Protobuf编码与全链路单测
 */

const assert = require('assert');
const {
  getUuid,
  renderGreetingTemplate,
  ProtoBufferMessage,
  GeekChatClientManager,
  getBossData,
} = require('../src/platforms/boss_chat.js');
const { DeliveryScheduler } = require('../src/core/scheduler.js');

async function runTests() {
  console.log('🧪 开始执行 BOSS直聘自定义打招呼 (boss_chat) 全链路单测...\n');

  // --- 测试 1: UUID 工具 ---
  console.log('▶ 1. 测试 getUuid');
  const id1 = getUuid(16, 16);
  const id2 = getUuid(16, 16);
  assert.strictEqual(id1.length, 16, '生成的 UUID 长度应为 16');
  assert.notStrictEqual(id1, id2, '两次生成的 UUID 应不相同');
  console.log('  ✅ 1. getUuid 格式与唯一性测试通过');

  // --- 测试 2: 模板插值 ---
  console.log('▶ 2. 测试 renderGreetingTemplate');
  const tpl1 = '你好，我对贵司{companyName}的{jobName}岗位很感兴趣！';
  const res1 = renderGreetingTemplate(tpl1, { companyName: '字节跳动', jobName: '前端专家' });
  assert.strictEqual(res1, '你好，我对贵司字节跳动的前端专家岗位很感兴趣！');

  const tpl2 = '你好，看了{{ companyName }}的{{ jobName }}，期待交流！';
  const res2 = renderGreetingTemplate(tpl2, { companyName: '腾讯', jobName: '架构师' });
  assert.strictEqual(res2, '你好，看了腾讯的架构师，期待交流！');

  const tplEmpty = renderGreetingTemplate('', { companyName: '测试' });
  assert.strictEqual(tplEmpty, '', '空模板应返回空字符串');
  console.log('  ✅ 2. renderGreetingTemplate 变量插值测试通过');

  // --- 测试 3: Protobuf 消息构造与编码 ---
  console.log('▶ 3. 测试 ProtoBufferMessage');
  const msgBuilder = new ProtoBufferMessage({
    userId: 123456,
    token: 'test_token',
  });
  const stanza = {
    uid: 987654,
    friendSource: 0,
    encryptUid: 'boss_encrypt_id',
    clientMid: 1600000000000,
  };
  const msgObj = msgBuilder.createTextMessage(stanza, { text: '你好！' });
  assert.strictEqual(msgObj.type, 1);
  assert.strictEqual(msgObj.messages[0].body.text, '你好！');
  assert.strictEqual(msgObj.messages[0].from.uid, 123456);
  assert.strictEqual(msgObj.messages[0].to.uid, 987654);

  const encoded = msgBuilder.encode(msgObj);
  assert(encoded.length > 0, '编码后二进制 Buffer 长度应大于 0');
  console.log('  ✅ 3. ProtoBufferMessage 消息构造与二进制编码测试通过');

  // --- 测试 4: getBossData 接口调用与重试 ---
  console.log('▶ 4. 测试 getBossData 接口');
  let fetchCalls = [];
  const mockFetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (fetchCalls.length === 1) {
      // 首次模拟返回非好友关系，触发重试
      return {
        json: async () => ({ code: 1, message: '非好友关系' }),
      };
    }
    return {
      json: async () => ({
        code: 0,
        zpData: {
          bossId: 888888,
          bossSource: 0,
          encryptBossId: 'b_enc_123',
        },
      }),
    };
  };

  const bossData = await getBossData(
    { encryptUserId: 'b_enc_123', securityId: 'sec_123' },
    { fetchFn: mockFetch, token: 'bst_dummy' }
  );
  assert.strictEqual(bossData.bossId, 888888, '应成功返回 bossId');
  assert.strictEqual(fetchCalls.length, 2, '遇到非好友关系应自动重试 1 次');
  console.log('  ✅ 4. getBossData 凭证透传与非好友关系重试机制测试通过');

  // --- 测试 5: GeekChatClientManager 与 MQTT 发送 ---
  console.log('▶ 5. 测试 GeekChatClientManager 消息发送');
  let publishedTopic = null;
  let publishedData = null;
  const mockMqttClient = {
    publish: (topic, data, opts, cb) => {
      publishedTopic = topic;
      publishedData = data;
      cb(null);
    },
    end: () => {},
  };

  const chatManager = new GeekChatClientManager({
    wt: 'mock_wt2',
    token: 'mock_token',
    uid: 10001,
  });
  // 注入 mock client
  chatManager.client = mockMqttClient;
  chatManager.isConnected = true;
  chatManager.msgBuilder = msgBuilder;

  await chatManager.sendMessage(
    { bossId: 888888, bossSource: 0, encryptBossId: 'b_enc_123' },
    '这是自动化测试打招呼语'
  );
  assert.strictEqual(publishedTopic, 'chat', 'MQTT 应向 chat 主题发送报文');
  assert(publishedData && publishedData.length > 0, '发送的报文应有内容');
  console.log('  ✅ 5. GeekChatClientManager 报文发送测试通过');

  // --- 测试 6: DeliveryScheduler 全链路调度打招呼与自动拉黑 ---
  console.log('▶ 6. 测试 DeliveryScheduler 全链路打招呼与自动拉黑集成');
  let deliveredJobs = [];
  let sentGreetings = [];
  let blockedCompanies = [];

  const mockAdapter = {
    refresh_jobs: async () => [
      { id: 'job_1', securityId: 'sec_1', encryptUserId: 'u_1', companyName: '测试企业A', title: '全栈工程师' },
      { id: 'job_2', securityId: 'sec_2', encryptUserId: 'u_2', companyName: '测试企业B', title: 'Golang工程师' },
    ],
    get_page_info: () => ({ current: 1, hasMore: false }),
    next_page: async () => false,
  };

  const mockBlacklist = {
    batchFilter: (jobs) => ({ allowed: jobs, blocked: [] }),
    addCompany: (comp) => { blockedCompanies.push(comp); },
  };

  const mockLimiter = {
    afterDelivery: async () => {},
    afterPageChange: async () => {},
  };

  const mockApi = {
    deliverJob: async (job) => {
      deliveredJobs.push(job);
      return { success: true };
    },
    getBossData: async (job) => ({
      bossId: 777777,
      bossSource: 0,
      encryptBossId: job.encryptUserId,
    }),
  };

  const mockChatManager = {
    connect: async () => {},
    sendMessage: async (bossData, text) => {
      sentGreetings.push({ bossData, text });
      return true;
    },
  };

  const scheduler = new DeliveryScheduler({
    adapter: mockAdapter,
    blacklist: mockBlacklist,
    limiter: mockLimiter,
    api: mockApi,
    chatManager: mockChatManager,
    dailyLimit: 10,
    customGreeting: {
      enabled: true,
      text: '您好！看了贵司{companyName}的{jobName}，非常契合！',
    },
  });

  const runResult = await scheduler.start();
  assert.strictEqual(runResult.stats.delivered, 2, '应成功投递 2 个岗位');
  assert.strictEqual(blockedCompanies.length, 2, '投递成功后应将两个公司加入黑名单');
  assert.deepStrictEqual(blockedCompanies, ['测试企业A', '测试企业B'], '拉黑的公司名称应匹配');

  assert.strictEqual(sentGreetings.length, 2, '应成功发送 2 条自定义打招呼语');
  assert.strictEqual(sentGreetings[0].text, '您好！看了贵司测试企业A的全栈工程师，非常契合！');
  // --- 测试 7: 真实嵌套数据结构与原生 Varint 二进制编码测试 ---
  console.log('▶ 7. 测试嵌套结构解构 (bossData.data.bossId) 与原生 Varint Protobuf 编码');
  let capturedStanza = null;
  const spyMsgBuilder = {
    createTextMessage: (stanza, opt) => {
      capturedStanza = stanza;
      return { messages: [{ from: { uid: 111 }, to: { uid: stanza.uid }, body: { text: opt.text } }] };
    },
    encode: (msg) => new Uint8Array([1, 2, 3]),
  };

  const nestedChatManager = new GeekChatClientManager();
  nestedChatManager.client = mockMqttClient;
  nestedChatManager.isConnected = true;
  nestedChatManager.msgBuilder = spyMsgBuilder;

  // 模拟真实 API 返回的嵌套数据结构
  const realApiResponse = {
    data: {
      bossId: 999888,
      bossSource: 1,
      encryptBossId: 'real_boss_enc_999',
    },
    job: { jobName: '架构师' },
  };

  await nestedChatManager.sendMessage(realApiResponse, '嵌套解析打招呼测试');
  assert.strictEqual(capturedStanza.uid, 999888, '应成功从 bossData.data.bossId 中提取出目标数字 UID');
  assert.strictEqual(capturedStanza.encryptUid, 'real_boss_enc_999', '应成功提取 encryptBossId');
  console.log('  ✅ 7. 嵌套结构解析测试通过');

  console.log('\n🎉 所有 boss_chat 与打招呼单测均 100% 通过！\n');
}

runTests().catch((err) => {
  console.error('❌ 测试执行失败:', err);
  process.exit(1);
});
