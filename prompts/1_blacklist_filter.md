# 任务 1 提示词：黑名单前置引擎与自适应延时频控

- **目标 Git 分支**：`feat/boss-blacklist-filter`
- **对应 Worktree 目录**：`worktrees/blacklist`
- **使用方法**：在 Orca 的 `[Terminal 3 - 黑名单过滤]` 终端中直接复制并发送以下指令。

---

```markdown
# Role: Google Senior Engineer (Blacklist & Anti-Ban Subsystem)
# Workspace: worktrees/blacklist
# Branch: feat/boss-blacklist-filter
# Context: 基于 codebase-memory-mcp 的 job-helper 项目知识库

请在当前分支开发【黑名单前置引擎与自适应延时频控模块】：

## 一、核心需求与实现范围
1. **黑名单引擎改造 (`src/core/blacklist.js`)**：
   - 基于现有 `job-helper` 的 `Storage` 模块（利用 `GM_getValue('universal_job_blacklist', [])` 与 `GM_setValue`）；
   - 构建高性能内存缓存 `Set`，提供毫秒级 O(1) 判定；
   - 暴露关键接口：
     - `isBlocked(companyName: string): boolean`
     - `addCompany(companyName: string): boolean`
     - `batchFilter(jobs: Array<{ companyName: string }>): { allowed: any[], blocked: any[] }`
   - 目标：让后续批量投递调度器可以在发起任何网络请求前直接前置拦截黑名单企业，实现「零网络请求跳过」。

2. **自适应拟人化延时器 (`src/core/rate_limiter.js`)**：
   - 实现带有随机高斯微扰动的休眠函数 `randomSleep(minMs, maxMs)`；
   - 内置防封延时配置梯度：
     - 单次投递间隔：默认 2500ms ~ 4500ms 浮动
     - 翻页浏览缓冲：默认 10000ms ~ 20000ms 浮动
     - 批次休息间隔：每投递 10 个岗位强制休眠 30000ms。

3. **自测用例 (`tests/blacklist_rate_test.js`)**：
   - 编写 Node/原生兼容的单测脚本，验证：
     - 黑名单添加、持久化与模糊/精确匹配；
     - 批量过滤吞吐量与命中率；
     - 随机延时落在指定区间。

## 二、执行约束
- 严格限定在当前分支 (`feat/boss-blacklist-filter`) 独立工作区 (`worktrees/blacklist`) 内编写；
- 保持原生 JavaScript 零重型外部依赖；
- 自测通过后执行：
  ```bash
  git add src/core/ tests/
  git commit -m "feat(blacklist): implement high-performance blacklist engine and jittered rate limiter"
  git diff main...feat/boss-blacklist-filter
  ```
- 输出修改总结与 git diff，停下来等待审查。
```
