# 任务 3 提示词：批量投递请求与 120/150 限额自解锁熔断

- **目标 Git 分支**：`feat/boss-batch-greet`
- **对应 Worktree 目录**：`worktrees/batch-greet`
- **使用方法**：在 Orca 的 `[Terminal 2 - 批量发送]` 终端中直接复制并发送以下指令。

---

```markdown
# Role: Google Senior Security & API Engineer
# Workspace: worktrees/batch-greet
# Branch: feat/boss-batch-greet
# Context: 参考 codebase-memory-mcp 中 boss-helper 项目 (src/entrypoints/boss/requests.ts)

请在当前分支抽取 boss-helper 的【批量投递 API、凭证复用与风控熔断机制】：

## 一、核心需求与实现范围
1. **投递请求客户端 (`src/platforms/boss_api.js`)**：
   - 凭证获取：从宿主浏览器 Cookie 中提取 `bst` 作为 `Zp_token`（或复用全局 `window._PAGE` 认证信息）；
   - 投递核心函数 `sendPublishReq({ securityId, jobId }, retries = 3)`：
     - 向 `https://www.zhipin.com/wapi/zpgeek/friend/add.json` 发起 POST 请求（建立沟通并自动触发系统预设招呼语）；
     - 结构化响应解析：
       - `code === 0`: 投递成功；
       - `code === 1` 且包含「您今天已与120位BOSS沟通」：
         - 自动发起确认请求：`POST https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json`（附带 `ba` 凭证与 `action: 'addf-limit-popup-c'`）；
         - 携带 `{ cid: 1 }` 自动重新发起投递，实现限额自动解锁；
       - `code === 1` 且包含「150位」：抛出自定义 `QuotaLimitError`（已达平台硬性上限，触发业务熔断）；
       - `code === 1` 且包含「操作过于频繁」：抛出 `RateLimitError`。

2. **批量投递批处理接口 (`deliverBatch(jobs, options)`)**：
   - 接收待投递岗位列表，按顺序安全执行单笔投递，返回结构化处理报告 `{ successCount, skippedCount, errors }`。

3. **测试用例 (`tests/boss_api_test.js`)**：
   - 编写 Mock 测试验证限额错误识别、自动确认上报链路及熔断抛错机制。

## 二、执行约束
- 严格限定在当前分支 (`feat/boss-batch-greet`) 独立工作区 (`worktrees/batch-greet`) 内编写；
- 采用原生 `fetch` 实现，禁止引入庞大的外部 Axios 库；
- 自测通过后执行：
  ```bash
  git add src/platforms/ tests/
  git commit -m "feat(delivery): extract deliver api with quota auto-unlock and circuit breaker"
  git diff main...feat/boss-batch-greet
  ```
- 输出修改总结与 git diff，停下来等待审查。
```
