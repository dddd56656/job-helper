/**
 * @file boss_chat.js
 * @description BOSS直聘自定义打招呼长连接、MQTT通讯与Protobuf协议编解码层
 */

// 兼容 Node.js 与浏览器沙盒环境依赖引入
let globalProtobuf = typeof protobuf !== 'undefined' ? protobuf : null;
let globalMqtt = typeof mqtt !== 'undefined' ? mqtt : null;
if (typeof require !== 'undefined') {
  try { if (!globalProtobuf) globalProtobuf = require('protobufjs'); } catch (_) {}
  try { if (!globalMqtt) globalMqtt = require('mqtt'); } catch (_) {}
}

/**
 * 获取全局跨沙盒宿主页面运行环境与上下文参数 (适配 Tampermonkey unsafeWindow 与原生 window)
 */
export function getGlobalPageContext() {
  const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : (typeof window !== 'undefined' ? window : {});
  let page = win._PAGE || (typeof window !== 'undefined' ? window._PAGE : null);

  // 1. 若运行在沙盒中或 _PAGE 关键属性缺失，扫描页面内联 <script> 进行精准正则提取（杜绝 JSON.parse 原生 JS 字面量抛错）
  const inlineProps = {};
  if (typeof document !== 'undefined') {
    try {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const s of scripts) {
        const txt = s.textContent || '';
        if (txt.includes('window._PAGE') || txt.includes('_PAGE =') || txt.includes('encryptUserId')) {
          // 提取 token
          const mToken = txt.match(/["']?token["']?\s*:\s*["']([^"']+)["']/);
          if (mToken && !inlineProps.token) inlineProps.token = mToken[1];

          // 提取 encryptUserId
          const mEncUid = txt.match(/["']?encryptUserId["']?\s*:\s*["']([^"']+)["']/);
          if (mEncUid && !inlineProps.encryptUserId) inlineProps.encryptUserId = mEncUid[1];

          // 提取 uid / userId
          const mUid = txt.match(/["']?(?:userId|uid)["']?\s*:\s*["']?(\d+)["']?/);
          if (mUid && !inlineProps.uid) {
            inlineProps.uid = Number(mUid[1]);
            inlineProps.userId = Number(mUid[1]);
          }

          // 提取 name / showName
          const mName = txt.match(/["']?(?:showName|name)["']?\s*:\s*["']([^"']+)["']/);
          if (mName && !inlineProps.name) inlineProps.name = mName[1];
        }
      }
    } catch (_) {}
  }

  // 合并 page 对象与内联正则提取结果
  page = { ...(page || {}), ...inlineProps };

  // 2. HTTP 接口专用凭证: bst (Cookie 提取)
  const cookieObj = win.Cookie || (typeof window !== 'undefined' ? window.Cookie : null);
  let bstToken = null;
  if (cookieObj && typeof cookieObj.get === 'function') {
    try { bstToken = cookieObj.get('bst'); } catch (_) {}
  }
  if (!bstToken && typeof document !== 'undefined' && document.cookie) {
    const m = document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (m) bstToken = decodeURIComponent(m[1]);
  }
  if (!bstToken && win.document && typeof win.document.cookie === 'string') {
    const m = win.document.cookie.match(/(?:^|;\s*)bst=([^;]*)/);
    if (m) bstToken = decodeURIComponent(m[1]);
  }

  // 3. WebSocket 长连接专用认证 token: page.token
  const wsToken = page.token || '';

  // 4. 当前求职者身份标识
  const uid = Number(page.uid || page.userId || 0);
  const encryptUserId = page.encryptUserId || '';

  return {
    win,
    page,
    token: bstToken || wsToken,
    bstToken: bstToken || '',
    wsToken: wsToken || '',
    uid,
    encryptUserId,
  };
}

/**
 * 随机 UUID 生成工具
 */
export function getUuid(len = 16, radix = 16) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('');
  const uuid = [];
  radix = radix || chars.length;
  if (len) {
    for (let i = 0; i < len; i++) {
      uuid[i] = chars[(Math.random() * radix) | 0];
    }
  } else {
    uuid[8] = uuid[13] = uuid[18] = uuid[23] = '-';
    uuid[14] = '4';
    for (let i = 0; i < 36; i++) {
      if (!uuid[i]) {
        const r = (Math.random() * 16) | 0;
        uuid[i] = chars[i === 19 ? (r & 3) | 8 : r];
      }
    }
  }
  return uuid.join('');
}

/**
 * 招呼语模板插值渲染
 * 支持 {{ jobName }}、{{ companyName }} 及 {jobName}、{companyName}
 */
export function renderGreetingTemplate(template, data = {}) {
  if (!template || typeof template !== 'string') return '';
  const context = {
    jobName: data.jobName || data.title || data.job_name || '',
    companyName: data.companyName || data.brandName || data.company || '',
    bossName: data.bossName || data.bossTitle || '',
    ...data,
  };

  // 1. 替换 {{ key }} 风格
  let res = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const val = path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), context);
    return val !== undefined && val !== null ? String(val) : '';
  });

  // 2. 替换 {key} 风格
  res = res.replace(/\{(\w+)\}/g, (match, key) => {
    const val = context[key];
    return val !== undefined && val !== null ? String(val) : match;
  });

  return res;
}

/**
 * Protobuf 编码工具函数 (用于无外部 protobufjs 库时的稳固原生编码兜底)
 */
function writeVarint(buf, val) {
  let v = BigInt(val);
  while (v > 127n) {
    buf.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  buf.push(Number(v));
}

function encodeProtobufText(str) {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(str));
  }
  return Array.from(Buffer.from(str, 'utf8'));
}

/**
 * 原生编码 TechwolfChatProtocol 消息报文
 */
function encodeChatProtocolBinary({ fromUid, toUid, text, mid, toName = '', toSource = 0 }) {
  const buf = [];

  // 1. TechwolfUser from
  const fromBytes = [];
  fromBytes.push((1 << 3) | 0); // tag 1: uid (varint)
  writeVarint(fromBytes, fromUid);
  fromBytes.push((7 << 3) | 0); // tag 7: source = 0
  writeVarint(fromBytes, 0);

  // 2. TechwolfUser to
  const toBytes = [];
  toBytes.push((1 << 3) | 0); // tag 1: uid (varint)
  writeVarint(toBytes, toUid);
  if (toName) {
    const nameBytes = encodeProtobufText(toName);
    toBytes.push((2 << 3) | 2); // tag 2: name (string) = encryptBossId
    writeVarint(toBytes, nameBytes.length);
    toBytes.push(...nameBytes);
  }
  toBytes.push((7 << 3) | 0); // tag 7: source = 0
  writeVarint(toBytes, toSource || 0);

  // 3. TechwolfMessageBody body
  const bodyBytes = [];
  bodyBytes.push((1 << 3) | 0); // tag 1: type = 1
  writeVarint(bodyBytes, 1);
  bodyBytes.push((2 << 3) | 0); // tag 2: templateId = 1
  writeVarint(bodyBytes, 1);
  const textBytes = encodeProtobufText(text);
  bodyBytes.push((3 << 3) | 2); // tag 3: text (string)
  writeVarint(bodyBytes, textBytes.length);
  bodyBytes.push(...textBytes);

  // 4. TechwolfMessage
  const msgBytes = [];
  // field 1: from
  msgBytes.push((1 << 3) | 2);
  writeVarint(msgBytes, fromBytes.length);
  msgBytes.push(...fromBytes);
  // field 2: to
  msgBytes.push((2 << 3) | 2);
  writeVarint(msgBytes, toBytes.length);
  msgBytes.push(...toBytes);
  // field 3: type = 1
  msgBytes.push((3 << 3) | 0);
  writeVarint(msgBytes, 1);
  // field 4: mid
  msgBytes.push((4 << 3) | 0);
  writeVarint(msgBytes, mid);
  // field 5: time
  msgBytes.push((5 << 3) | 0);
  writeVarint(msgBytes, mid);
  // field 6: body
  msgBytes.push((6 << 3) | 2);
  writeVarint(msgBytes, bodyBytes.length);
  msgBytes.push(...bodyBytes);
  // field 11: cmid
  msgBytes.push((11 << 3) | 0);
  writeVarint(msgBytes, mid);

  // 5. TechwolfChatProtocol
  buf.push((1 << 3) | 0); // tag 1: type = 1
  writeVarint(buf, 1);
  buf.push((3 << 3) | 2); // tag 3: messages (repeated)
  writeVarint(buf, msgBytes.length);
  buf.push(...msgBytes);

  return new Uint8Array(buf);
}

/**
 * BOSS 直聘官方 Protobuf 模式定义
 */
export const BOSS_PROTO_SCHEMA =
  'option java_package = "cn.techwolf.boss.chat";option java_outer_classname = "ChatProtocol";message TechwolfUser { required int64 uid = 1; optional string name = 2; optional string avatar = 3; optional string company = 4; optional int32 headImg = 5; optional int32 certification = 6; optional int32 source = 7;}message TechwolfSound { optional int64 sid = 1; optional string url = 2; optional int32 duration = 3; optional int32 templateId = 4; optional string extend = 5;}message TechwolfVideo { required int32 type = 1; required int32 status = 2; optional int32 duration = 3; optional string text = 4;}message TechwolfInterview { required int32 condition = 1; required string text = 2; optional string url = 3; optional string extend = 4; }message TechwolfImageInfo { required string url = 1; required int32 width = 2; required int32 height = 3;}message TechwolfImage { optional int64 iid = 1; optional TechwolfImageInfo tinyImage = 2; optional TechwolfImageInfo originImage = 3;}message TechwolfAction { required int32 aid = 1; optional string extend = 2;}message TechwolfArticle { required string title = 1; required string description = 2; required string picUrl = 3; required string url = 4; optional int32 templateId = 5; optional string bottomText = 6; optional int64 timeout = 7; optional string statisticParameters = 8; repeated TechwolfSlice highlightParts = 9; repeated TechwolfSlice dimParts = 10; optional string subTitle = 11; optional string extend = 12;}message TechwolfNotify { required string text = 1; optional string url = 2; optional string title = 3;}message TechwolfButton { required string text = 1; optional string url = 2; optional int32 templateId = 3;}message TechwolfDialog { required string text = 1; repeated TechwolfButton buttons = 2; required bool operated = 3; optional bool clickMore = 4; optional int32 type = 5; optional string backgroundUrl = 6; optional int64 timeout = 7; optional string statisticParameters = 8; optional string title = 9; optional string url = 10; optional int32 selectedIndex = 11; optional string extend = 12; optional string content = 13;}message TechwolfJobDesc { required string title = 1; required string company = 2; required string salary = 3; required string url = 4; required int64 jobId = 5; optional string positionCategory = 6; optional string experience = 7; optional string education = 8; optional string city = 9; optional string bossTitle = 10; optional TechwolfUser boss = 11; optional string lid = 12; optional string stage = 13; optional string bottomText = 14; optional string jobLabel = 15; optional int32 iconFlag = 16; optional string content = 17; repeated string labels = 18; optional int64 expectId = 19; optional string expectPosition = 20; optional string expectSalary = 21; optional string partTimeDesc = 22; optional TechwolfUser geek = 23; optional string latlon = 24; optional string distance = 25; optional string extend = 26;}message TechwolfResume { required TechwolfUser user = 1; optional string description = 2; optional string city = 3; optional string position = 4; repeated string keywords = 5; optional int64 expectId = 6; optional string lid = 7; optional int32 gender = 8; optional string salary = 9; optional string workYear = 10; optional string content1 = 11; optional string content2 = 12; optional string education = 13; optional string age = 14; repeated string labels = 15; repeated UserExperience experiences = 16; optional string positionCategory = 17; optional string jobSalary = 18; optional string bottomText = 19; optional string applyStatus = 20; optional int64 jobId = 21; optional string content3 = 22; optional string securityId = 23; optional TechwolfUser boss = 24; optional string brandName = 25; optional string extend = 26;}message TechwolfHyperLink {        required string text = 1;       required string url = 2; required int32 hyperLinkType = 3; optional string extraJson=4;}message TechwolfMessageBody { required int32 type = 1; required int32 templateId = 2; optional string headTitle = 11; optional string text = 3; optional TechwolfSound sound = 4; optional TechwolfImage image = 5; optional TechwolfAction action = 6; repeated TechwolfArticle articles = 7; optional TechwolfNotify notify = 8; optional TechwolfDialog dialog = 9; optional TechwolfJobDesc jobDesc = 10; optional TechwolfResume resume = 12; optional TechwolfRedEnvelope redEnvelope = 13; optional TechwolfOrderDetail orderDetail = 14; optional TechwolfHyperLink hyperLink = 15; optional TechwolfVideo video = 16; optional TechwolfInterview interview = 17; optional TechwolfJobShare jobShare = 18; optional TechwolfResumeShare resumeShare = 19; optional AtInfo atInfo = 20; optional TechwolfSticker sticker = 21; optional TechwolfChatShare chatShare = 22; optional TechwolfInterviewShare interviewShare = 23; optional TechwolfListCard listCard = 24; optional TechwolfStarRate starRate = 25; optional TechwolfFrame frame = 26; optional TechwolfMultiImage multiImage = 27; optional string extend = 28; optional int32 style = 29; optional TechwolfComDesc comDesc = 30; optional TechwolfUserCard userCard = 31;}message TechwolfMessage { required TechwolfUser from = 1; required TechwolfUser to = 2; required int32 type = 3; optional int64 mid = 4; optional int64 time = 5; required TechwolfMessageBody body = 6; optional bool offline = 7; optional bool received = 8; optional string pushText = 9; optional int64 taskId = 10; optional int64 cmid = 11; optional int32 status = 12; optional int32 uncount = 13; optional int32 pushSound = 14; optional int32 flag = 15; optional bytes encryptedBody = 16; optional string bizId = 17; optional int32 bizType = 18; optional string securityId = 19; optional int64 quoteId = 20;}message TechwolfClientInfo { optional string version = 1; optional string system = 2; optional string systemVersion = 3; optional string model = 4; optional string uniqid = 5; optional string network = 6; optional int32 appid = 7; optional string platform = 8; optional string channel = 9; optional string ssid = 10; optional string bssid = 11; optional double longitude = 12; optional double latitude = 13;}message TechwolfClientTime { optional int64 startTime = 1; optional int64 resumeTime = 2; optional int64 locateTime = 3;}message TechwolfPresence { required int32 type = 1; required int32 uid = 2; optional TechwolfClientInfo clientInfo = 3; optional TechwolfClientTime clientTime = 4; optional int64 lastMessageId = 5; optional int64 lastGroupMessageId = 6; optional int64 userId = 7;}message TechwolfKVEntry {        required string key = 1;        required string value = 2;}message TechwolfIq { required int64 qid = 1; required string query = 2; repeated TechwolfKVEntry params = 3;}message TechwolfIqResponse { required int64 qid = 1; required string query = 2; repeated TechwolfKVEntry results = 3;}message TechwolfMessageSync {       required int64 clientMid = 1;    required int64 serverMid = 2;}message TechwolfMessageRead {     required int64 userId = 1;      required int64 messageId = 2;   required int64 readTime = 3;     optional bool sync = 4 [default = false];       optional int32 userSource = 5;}message TechwolfChatProtocol { required int32 type = 1; optional string version = 2; repeated TechwolfMessage messages = 3; optional TechwolfPresence presence = 4; optional TechwolfIq iq = 5; optional TechwolfIqResponse iqResponse = 6; repeated TechwolfMessageSync messageSync = 7; repeated TechwolfMessageRead messageRead = 8; optional TechwolfDataSync dataSync = 9; optional int32 domain = 10;}message TechwolfRedEnvelope { required int64 redId = 1; required string redText = 2; required string redTitle = 3; required string clickUrl = 4;}message TechwolfOrderDetail { required string title = 1; required string subTitle = 2; optional string url = 3; repeated TechwolfOrderDetailEntry orderDetailEntryList = 4;}message TechwolfOrderDetailItem { required string name = 1; required int32 templateId = 2;}message TechwolfOrderDetailEntry { required TechwolfOrderDetailItem key = 1; required TechwolfOrderDetailItem value = 2;}message TechwolfUserSync { required int64 uid = 1; required int32 identity = 2; optional string extraJson = 3; optional int32 userSource = 4;}message TechwolfDataSync { required int32 type = 1; optional TechwolfUserSync userSync = 2; optional TechwolfGroupSync groupSync = 3;}message TechwolfSlice { required int32 startIndex = 1; required int32 endIndex = 2;}message UserExperience { required string organization = 1; required string occupation = 2; optional string startDate = 3; optional string endDate = 4; required int32 type = 5;}message TechwolfJobShare { required TechwolfUser user = 1; required int64 jobId = 2; required string position = 3; required string salary = 4; optional string location = 5; required string company = 6; optional string stage = 7; optional string experience = 8; optional string education = 9; optional string url = 10; optional string lid = 11; optional string price = 12; optional string description = 13; optional int64 bossId = 14; optional string extend = 15;}message TechwolfResumeShare { required TechwolfUser user = 1; required int64 expectId = 2; required string position = 3; required string salary = 4; optional string location = 5; optional string applyStatus = 6; optional string age = 7; optional string experience = 8; optional string education = 9; optional string url = 10; optional string lid = 11; optional int32 gender = 12; optional bool blurred = 13; optional int32 source = 14;}message AtInfo { required int32 flag = 1; repeated int64 uids = 2;}message TechwolfGroupSync { required int64 gid = 1; optional int32 version = 2; optional string encGid = 3; optional string extraJson = 4;}message TechwolfSticker { required int64 sid = 1; optional int64 packId = 2; optional TechwolfImage image = 3; optional string format = 4; optional string name = 5; optional string encSid = 6;}message TechwolfChatShare { required int64 shareId = 1; required string title = 2; repeated string records = 3; optional string bottomText = 4; optional string url = 5; required TechwolfUser from = 6; required TechwolfUser to = 7; required TechwolfUser user = 8;}message TechwolfInterviewShare { required int64 interviewId = 1; required TechwolfUser user = 2; required string title = 3; required string bottomText = 4; optional string url = 5; optional string interviewTime = 6; optional string interviewAddress = 7; optional string jobName = 8;}message TechwolfListItem { optional string title = 1; optional int32 icon = 2; optional string url = 3; optional string text = 4;}message TechwolfListCard { optional string title = 1; repeated TechwolfListItem items = 2; optional int32 pageSize = 3; optional string extend = 4;}message TechwolfStar { required int64 starId = 1; optional string starDesc = 2; repeated TechwolfListItem options = 3;}message TechwolfStarRate { optional string title = 1; repeated TechwolfStar stars = 2; required int32 rateStatus = 3; optional TechwolfStar rateStar = 4; optional TechwolfButton submitButton = 5;}message TechwolfFrame { required string href = 1;}message TechwolfMultiImage { repeated TechwolfImageInfo images = 1;}message TechwolfComDesc { required string picUrl = 1; required string name = 2; optional string stage = 3; optional string scale = 4; optional string industry = 5; repeated string welfareLabels = 6; optional string introduce = 7; optional string url = 8; optional string extend = 9;}message TechwolfUserCard { required string name = 1; required string tiny = 2; optional int32 gender = 3; optional string comment = 4; optional string description = 5; repeated string labels = 6; optional string url = 7; optional string extend = 8;}';

/**
 * Protobuf 消息序列化与构建器
 */
export class ProtoBufferMessage {
  constructor(config = {}) {
    this.config = config;
    this.protoRoot = null;
    this.ChatProtocol = null;
    this.isInitialized = false;
    const ctx = getGlobalPageContext();
    this.protobufLib = config.protobufLib || globalProtobuf || ctx.win.protobuf || (typeof window !== 'undefined' ? window.protobuf : null);
    this.toObjectOptions = {
      enums: String,
      bytes: String,
      defaults: true,
      arrays: true,
      objects: true,
      oneofs: true,
    };
    this.init();
  }

  init() {
    if (this.isInitialized) return;
    if (!this.protobufLib || typeof this.protobufLib.parse !== 'function') {
      return;
    }
    try {
      this.protoRoot = this.protobufLib.parse(BOSS_PROTO_SCHEMA, { keepCase: false }).root;
      this.ChatProtocol = this.protoRoot.lookupType('TechwolfChatProtocol');
      this.TechwolfMessage = this.protoRoot.lookupType('TechwolfMessage');
      this.TechwolfUser = this.protoRoot.lookupType('TechwolfUser');
      this.TechwolfMessageBody = this.protoRoot.lookupType('TechwolfMessageBody');
      this.isInitialized = true;
    } catch (e) {
      console.warn('[JobHelper:Chat] Protobuf 加载异常，将使用内置原生编解码器:', e?.message || e);
    }
  }

  createTextMessage(stanza, options = {}) {
    const text = options.text || '';
    const now = Date.now();
    const fromUid = Number(this.config.userId || 0);
    const toUid = Number(stanza.uid || 0);

    const messagePayload = {
      type: 1,
      mid: stanza.clientMid || now,
      cmid: stanza.clientMid || now,
      time: now,
      from: {
        uid: fromUid,
        source: this.config.friendSource || 0,
      },
      to: {
        uid: toUid,
        name: stanza.encryptUid || '', // BOSS直聘官方协议：to.name 承载 encryptUid/encryptBossId
        encryptUid: stanza.encryptUid || '',
        source: stanza.friendSource || 0,
      },
      body: {
        type: 1,
        templateId: 1,
        text: text,
      },
    };

    if (this.isInitialized && this.ChatProtocol) {
      const chatProtocolMsg = this.ChatProtocol.create({
        type: 1,
        messages: [this.TechwolfMessage.create(messagePayload)],
      });
      return this.ChatProtocol.toObject(chatProtocolMsg, this.toObjectOptions);
    }

    return {
      type: 1,
      messages: [messagePayload],
    };
  }

  encode(messageObj) {
    if (this.isInitialized && this.ChatProtocol) {
      try {
        return this.ChatProtocol.encode(messageObj).finish();
      } catch (e) {
        console.warn('[JobHelper:Chat] protobufjs 编码异常，回退内置编码器:', e?.message || e);
      }
    }

    // 内置二进制标准 Varint/Tag 编码器兜底
    try {
      const msg = messageObj?.messages?.[0];
      const fromUid = msg?.from?.uid || this.config.userId || 0;
      const toUid = msg?.to?.uid || 0;
      const toName = msg?.to?.name || msg?.to?.encryptUid || '';
      const toSource = msg?.to?.source || 0;
      const text = msg?.body?.text || '';
      const mid = msg?.mid || Date.now();
      return encodeChatProtocolBinary({ fromUid, toUid, text, mid, toName, toSource });
    } catch (err) {
      console.error('[JobHelper:Chat] 原生二进制编码致命错误:', err);
      const jsonStr = JSON.stringify(messageObj);
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(jsonStr);
      }
      return Buffer.from(jsonStr);
    }
  }
}

/**
 * BOSS 直聘聊天客户端管理器
 */
export class GeekChatClientManager {
  constructor(options = {}) {
    this.options = options;
    this.client = null;
    this.msgBuilder = null;
    this.wt = null;
    this.token = null;
    this.uid = null;
    this.isConnected = false;
    this._connectPromise = null;
  }

  /**
   * 从当前运行环境中获取 wt 凭证 (GET https://www.zhipin.com/wapi/zppassport/get/wt)
   */
  async fetchWt(fetchFn = globalThis.fetch) {
    const url = 'https://www.zhipin.com/wapi/zppassport/get/wt';
    const res = await fetchFn(url, { credentials: 'include' }).then((r) => r.json());
    if (res?.code !== 0 || !res?.zpData?.wt2) {
      throw new Error(`获取 wt 凭证失败: ${res?.message || '未知错误'}`);
    }
    return res.zpData.wt2;
  }

  /**
   * 建立 MQTT 长连接与初始化 Protobuf 构建器
   */
  async connect(params = {}) {
    if (this.isConnected && this.client) return this;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      const ctx = getGlobalPageContext();
      const win = ctx.win;
      const fetchFn = params.fetchFn || this.options.fetchFn || globalThis.fetch;
      const mqttLib = params.mqttLib || this.options.mqttLib || (typeof mqtt !== 'undefined' ? mqtt : null) || globalMqtt || win.mqtt || (typeof window !== 'undefined' ? window.mqtt : null);

      // 1. 获取 wt2 (支持自动重试 3 次)
      this.wt = params.wt || this.options.wt;
      if (!this.wt) {
        let wtError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            this.wt = await this.fetchWt(fetchFn);
            if (this.wt) {
              console.log('[JobHelper:Chat] 获取 wt 凭证成功');
              break;
            }
          } catch (e) {
            wtError = e;
            if (attempt < 3) await new Promise((r) => setTimeout(r, 600));
          }
        }
        if (!this.wt) {
          throw new Error(`无法获取 wt 认证凭证: ${wtError?.message || '未知错误'}`);
        }
      }

      // 2. 获取 token (WebSocket 专用) 与 uid、encryptUserId
      this.token = params.token || this.options.token || ctx.wsToken || '';
      if (!this.token) {
        throw new Error('未获取到 WebSocket 长连接认证 token (_PAGE.token)，请确认是否已登录BOSS直聘');
      }

      this.uid = Number(params.uid || this.options.uid || ctx.uid || 0);
      this.encryptUserId = params.encryptUserId || this.options.encryptUserId || ctx.encryptUserId || '';

      // 3. 初始化 Protobuf 消息构造器
      const protobufLib = params.protobufLib || this.options.protobufLib || (typeof protobuf !== 'undefined' ? protobuf : null) || globalProtobuf || win.protobuf || (typeof window !== 'undefined' ? window.protobuf : null);

      this.msgBuilder = new ProtoBufferMessage({
        userId: this.uid,
        token: this.token,
        platform: 'web',
        friendSource: 0,
        supportPush: true,
        wt: this.wt,
        protobufLib,
      });

      // 4. 连接 MQTT (wss://ws6.zhipin.com/chatws)
      if (!mqttLib || typeof mqttLib.connect !== 'function') {
        throw new Error('当前运行环境未检测到可用的 MQTT 库 (window.mqtt/mqtt)，无法建立聊天长连接');
      }

      const clientId = `ws-${getUuid(16, 16)}`;
      const wsUrl = 'wss://ws6.zhipin.com/chatws';
      const wtVal = this.wt;
      const WebSocketCtor = (win && win.WebSocket) || (typeof WebSocket !== 'undefined' ? WebSocket : null);
      if (!WebSocketCtor) {
        throw new Error('当前环境缺少 WebSocket 构造函数');
      }

      this.client = mqttLib.connect(wsUrl, {
        clientId,
        username: `${this.token}|0`,
        password: wtVal,
        keepalive: 25,
        clean: true,
        reconnectPeriod: 1000,
        connectTimeout: 10000,
        protocolVersion: 4,
        createWebsocket: (url) => {
          const subProtocols = wtVal ? [wtVal] : ['mqtt'];
          return new WebSocketCtor(url, subProtocols);
        },
      });

      // 监听连接状态，离线时重置连接标记
      if (this.client && typeof this.client.on === 'function') {
        this.client.on('close', () => { this.isConnected = false; });
        this.client.on('offline', () => { this.isConnected = false; });
      }

      await new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            this.isConnected = true;
            resolve();
          }
        }, 5000);

        if (this.client && typeof this.client.on === 'function') {
          this.client.on('connect', () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.isConnected = true;
              console.log('[JobHelper:Chat] ✅ MQTT 聊天长连接已建立');
              resolve();
            }
          });
          this.client.on('error', (err) => {
            if (!settled) {
              console.warn('[JobHelper:Chat] MQTT 连接告警:', err?.message || err);
            }
          });
        } else {
          this.isConnected = true;
          resolve();
        }
      });

      return this;
    })();

    try {
      await this._connectPromise;
      return this;
    } finally {
      this._connectPromise = null;
    }
  }

  /**
   * 发送聊天文本消息 (基于高级打招呼长连接协议)
   * @param {object} bossData Boss元数据对象
   * @param {string} greetingText 待发送文本
   * @param {object} [job] 关联的岗位对象
   */
  async sendMessage(bossData, greetingText, job = null) {
    if (!bossData) {
      throw new Error('未提供 bossData，无法发送自定义招呼语');
    }
    if (!greetingText || typeof greetingText !== 'string' || !greetingText.trim()) {
      return false;
    }

    // 重点：解构 bossData 与 bossData.data 结构
    const innerData = bossData.data || bossData;
    const targetUid = Number(innerData.bossId || innerData.uid || bossData.bossId || 0);
    const friendSource = Number(
      innerData.bossSource ??
      bossData.bossSource ??
      job?.rawData?.detail?.bossInfo?.bossSource ??
      0
    );
    const encryptBossId = String(
      innerData.encryptBossId ||
      bossData.encryptBossId ||
      innerData.encryptUid ||
      bossData.encryptUid ||
      job?.encryptBossId ||
      job?.rawData?.encryptBossId ||
      job?.rawData?.jobitem?.encryptBossId ||
      ''
    );

    if (!targetUid || Number.isNaN(targetUid)) {
      console.error('[JobHelper:Chat] 无法解析到有效的 targetUid (bossId):', bossData);
      throw new Error('无法解析目标 Boss 的数字 UID，消息取消发送');
    }

    if (!this.isConnected || !this.client || !this.msgBuilder) {
      await this.connect();
    }

    const stanza = {
      uid: targetUid,
      friendSource: friendSource,
      encryptUid: encryptBossId,
      encryptGid: '',
      clientMid: Date.now(),
    };

    console.log('[JobHelper:Chat] 准备向 Boss 发送高级自定义打招呼:', {
      targetUid,
      friendSource,
      encryptBossId,
      text: greetingText.trim(),
    });

    const msgObj = this.msgBuilder.createTextMessage(stanza, {
      text: greetingText.trim(),
    });

    const encoded = this.msgBuilder.encode(msgObj);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          console.warn('[JobHelper:Chat] MQTT 发送等待响应超时，已放行');
          resolve(true);
        }
      }, 5000);

      try {
        this.client.publish('chat', encoded, { qos: 1, retain: true }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) {
            console.warn('[JobHelper:Chat] MQTT 消息发送异常:', err);
            return reject(err);
          }
          console.log('[JobHelper:Chat] ✅ 高级自定义招呼语发送成功！');
          resolve(true);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  disconnect() {
    if (this.client && typeof this.client.end === 'function') {
      try { this.client.end(); } catch (_) {}
    }
    this.isConnected = false;
  }
}

/**
 * 获取 Boss 元数据 (数值型 UID 与通讯参数)
 */
export async function getBossData(job, options = {}) {
  const ctx = getGlobalPageContext();
  const fetchFn = options.fetchFn || globalThis.fetch;
  const token = options.token || ctx.bstToken || ctx.token;

  if (!token) {
    throw new Error('未获取到有效凭证(bst/Zp_token)，请确认是否已登录BOSS直聘');
  }

  const retries = options.retries !== undefined ? options.retries : 3;
  if (retries <= 0) {
    throw new Error(options.errorMsg || '获取Boss信息重试多次失败');
  }

  const url = 'https://www.zhipin.com/wapi/zpchat/geek/getBossData';
  const targetSecurityId = job?.securityId || job?.security_id;

  if (!targetSecurityId) {
    throw new Error('缺少获取Boss信息的必要参数: securityId');
  }

  let currentUserId = options.encryptUserId || job?.encryptUserId || ctx.encryptUserId;
  // 若当前页面上下文缺失 encryptUserId，异步发起轻量个人基础信息接口兜底拉取
  if (!currentUserId && typeof fetchFn === 'function') {
    try {
      const userRes = await fetchFn('https://www.zhipin.com/wapi/zpgeek/resume/getGeekBaseInfo.json', {
        headers: { 'Zp_token': token },
        credentials: 'include',
      }).then((r) => r.json());
      if (userRes?.code === 0 && userRes?.zpData?.encryptUserId) {
        currentUserId = userRes.zpData.encryptUserId;
        ctx.encryptUserId = currentUserId;
      }
    } catch (_) {}
  }

  if (!currentUserId) {
    throw new Error('未获取到当前求职者 encryptUserId，无法获取 Boss 信息');
  }

  let lastError = null;
  try {
      let body;
      if (typeof FormData !== 'undefined') {
        body = new FormData();
        body.append('bossId', String(currentUserId));
        body.append('securityId', String(targetSecurityId));
        body.append('bossSrc', '0');
      } else {
        body = new URLSearchParams();
        body.append('bossId', String(currentUserId));
        body.append('securityId', String(targetSecurityId));
        body.append('bossSrc', '0');
      }

      const rawRes = await fetchFn(url, {
        method: 'POST',
        body: body,
        headers: {
          'Zp_token': token,
        },
        credentials: 'include',
      });

      const res = await rawRes.json();

      if (res?.code === 0 && res?.zpData) {
        return res.zpData;
      }

      if (res?.message === '非好友关系') {
        if (retries > 1) {
          await new Promise((r) => setTimeout(r, 600));
          return await getBossData(job, {
            ...options,
            retries: retries - 1,
            errorMsg: '非好友关系',
          });
        }
      }

      lastError = new Error(`获取Boss信息失败: ${res?.message || '未知状态'}`);
  } catch (err) {
    lastError = err;
  }

  throw lastError || new Error('获取Boss信息重试失败');
}

// 导出至 window 与 unsafeWindow 便于油猴与调试复用
if (typeof window !== 'undefined') {
  window.ProtoBufferMessage = ProtoBufferMessage;
  window.GeekChatClientManager = GeekChatClientManager;
  window.getBossData = getBossData;
  window.renderGreetingTemplate = renderGreetingTemplate;
  window.getUuid = getUuid;
  window.getGlobalPageContext = getGlobalPageContext;
}
if (typeof unsafeWindow !== 'undefined') {
  unsafeWindow.ProtoBufferMessage = ProtoBufferMessage;
  unsafeWindow.GeekChatClientManager = GeekChatClientManager;
  unsafeWindow.getBossData = getBossData;
  unsafeWindow.renderGreetingTemplate = renderGreetingTemplate;
  unsafeWindow.getUuid = getUuid;
  unsafeWindow.getGlobalPageContext = getGlobalPageContext;
}
