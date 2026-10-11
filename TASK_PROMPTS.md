# 独立分支开发指南与分工提示词矩阵 (TASK_PROMPTS.md)

本文档为各 Git 特性分支在 Orca 独立终端中执行开发时的**专属提示词库**。
每个分支的开发者/AI 代理可以根据已建立的 `codebase-memory-mcp` 知识图谱信息，在各自隔离的 Worktree 目录中独立完成编码、自测与 Git 提交，最后在流水线分支中进行总装。

---

## 快速导航与终端映射表

| 序号 | 目标 Git 分支 | 对应独立终端/Worktree 工作区 | 专职提示词文件 | 核心职责 |
| :---: | :--- | :--- | :--- | :--- |
| **01** | `feat/boss-blacklist-filter` | `worktrees/blacklist` | [prompts/1_blacklist_filter.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/1_blacklist_filter.md) | 黑名单前置引擎与自适应延时器 |
| **02** | `feat/boss-pagination-refresh` | `worktrees/pagination` | [prompts/2_pagination_refresh.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/2_pagination_refresh.md) | Vue Hook 劫持与原生翻页刷新适配器 |
| **03** | `feat/boss-batch-greet` | `worktrees/batch-greet` | [prompts/3_batch_greet.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/3_batch_greet.md) | 批量投递请求与 120/150 限额自解锁熔断 |
| **04** | `feat/boss-integration-pipeline` | `worktrees/pipeline` | [prompts/4_pipeline_assembly.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/4_pipeline_assembly.md) | 全链路合并组装、调度器与单文件打包 |

---

## 使用说明 (How to Use in Orca)

1. 在 Orca 左侧栏切换到目标终端卡片（例如：切换到 `feat/boss-blacklist-filter` 终端）；
2. 确保终端所在的当前工作目录为对应的 Worktree 路径（如 `worktrees/blacklist`）；
3. 复制下方对应任务的 Markdown 提示词，直接发送给该终端中的 AI；
4. 该终端的 AI 将仅在当前分支进行原子化修改，完成后提交 Git Commit；
5. 所有分支开发完毕后，在 `feat/boss-integration-pipeline` 终端执行总装提示词。

---

## 任务 1 提示词：黑名单前置引擎与自适应延时器
- **适用分支**：`feat/boss-blacklist-filter`
- **执行终端**：Terminal 3 (`worktrees/blacklist`)
- **完整提示词**：详见 [prompts/1_blacklist_filter.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/1_blacklist_filter.md)

```markdown
# Role: Google Senior Engineer (Blacklist & Anti-Ban Subsystem)
# Workspace: worktrees/blacklist
# Branch: feat/boss-blacklist-filter
# Context: 基于 codebase-memory-mcp 的 job-helper 项目知识库

请在当前分支开发【黑名单前置引擎与自适应延时频控模块】：

【核心目标】：
1. 升级 job-helper 原有的 Storage 存储结构，创建 `src/core/blacklist.js`：
   - 维护高吞吐 Set 缓存，基于 GM_getValue/GM_setValue 持久化；
   - 提供同步判断方法 `isBlocked(companyName: string): boolean` 与 `batchFilter(jobs: any[]): { allowed: any[], blocked: any[] }`；
   - 支持前置批量快速过滤，保证后续投递流水线中命中的黑名单企业实现「零网络请求跳过」。
2. 实现拟人化延时器 `src/core/rate_limiter.js`：
   - 实现高斯微扰动随机等待 `randomSleep(minMs, maxMs)`；
   - 提取 boss-helper 延时配置规范（单次投递 2~5s，切页等待 10~25s，批次休息 30s）。
3. 编写自测脚本 `tests/blacklist_rate_test.js` 并执行验证。

【严格约束】：
- 仅在当前分支目录修改，严禁改动其他未声明模块；
- 完成后执行 git add 和 git commit，提交信息格式：`feat(blacklist): implement high-performance blacklist engine and jittered rate limiter`；
- 输出 git diff 并停下等待审查。
```

---

## 任务 2 提示词：Vue Hook 劫持与原生翻页刷新适配器
- **适用分支**：`feat/boss-pagination-refresh`
- **执行终端**：Terminal 1 (`worktrees/pagination`)
- **完整提示词**：详见 [prompts/2_pagination_refresh.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/2_pagination_refresh.md)

```markdown
# Role: 资深逆向与前端自动化专家
# Workspace: worktrees/pagination
# Branch: feat/boss-pagination-refresh
# Context: codebase-memory-mcp 中的 boss-helper (src/composables/useVue.ts & src/entrypoints/boss/index.ts)

请在当前分支将 boss-helper 的【Vue 实例劫持与原生翻页能力】抽取并适配到 job-helper 架构中：

【核心目标】：
1. 创建 `src/platforms/boss_hooks.js`：
   - 抽取纯原生 JS 版的 `useHookVueFn(selectors, keys)` 和 `useHookVueData(selectors, key)`（参考 boss-helper/src/composables/useVue.ts）；
   - 稳定探测 `#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main` 上的 `.__vue__` 实例。
2. 创建 `src/platforms/boss_adapter.js`：
   - 实现标准适配器契约：
     - `refresh_jobs()`: 通过监听/读取 Vue 上的 `jobList`，返回结构化岗位列表；
     - `next_page()`: 识别推荐页或搜索页，直接调用 Vue 内部的 `pageChangeAction` 或 `searchJobAction` 实现原生无感翻页；
     - `get_page_info()`: 读取 `pageVo` 与 `hasMore`，获取真实页码与是否到达底部。
3. 替代 job-helper 原版易卡死的 `u-scroll-bait` 滚轮模拟逻辑。
4. 提供独立的单体自测验证脚本。

【严格约束】：
- 仅在当前分支目录修改，保持原生 JavaScript 零重型库依赖；
- 完成后执行 git add 和 git commit，提交信息格式：`feat(boss-adapter): extract vue hook pagination and job list reader from boss-helper`；
- 输出 git diff 并停下等待审查。
```

---

## 任务 3 提示词：批量投递请求与 120/150 限额自解锁熔断
- **适用分支**：`feat/boss-batch-greet`
- **执行终端**：Terminal 2 (`worktrees/batch-greet`)
- **完整提示词**：详见 [prompts/3_batch_greet.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/3_batch_greet.md)

```markdown
# Role: Google Senior Security & API Engineer
# Workspace: worktrees/batch-greet
# Branch: feat/boss-batch-greet
# Context: codebase-memory-mcp 中的 boss-helper (src/entrypoints/boss/requests.ts)

请在当前分支将 boss-helper 的【批量投递 API、Cookie 凭证复用与限额熔断机制】抽取并适配到 job-helper 平台层：

【核心目标】：
1. 创建 `src/platforms/boss_api.js`：
   - 抽取 `sendPublishReq({ securityId, jobId })`：向 `https://www.zhipin.com/wapi/zpgeek/friend/add.json` 发送 POST 投递请求；
   - 凭证复用：从当前网页 Cookie 自动提取 `bst`，或通过当前会话携带 `Zp_token` 头；
   - 异常与限额分流处理：
     - 当接口返回包含「您今天已与120位BOSS沟通」时，自动向 `https://www.zhipin.com/wapi/zpCommon/actionLog/geek/chatremind.json` 上报确认解除限制，并带 `{ cid: 1 }` 自动重试；
     - 当命中「150位」硬性限制时，抛出 `QuotaLimitError` 并触发熔断；
     - 当提示「操作过于频繁」时抛出 `RateLimitError`。
2. 封装 `deliverJob` 与 `batchDeliverJobs` 核心方法。
3. 编写模拟测试用例验证报文结构与错误捕获。

【严格约束】：
- 纯原生 fetch 实现，不引入外部 Axios 等沉重依赖；
- 完成后执行 git add 和 git commit，提交信息格式：`feat(delivery): extract deliver api with quota auto-unlock and circuit breaker`；
- 输出 git diff 并停下等待审查。
```

---

## 任务 4 提示词：全链路合并组装、调度器与单文件打包 (Integration)
- **适用分支**：`feat/boss-integration-pipeline`
- **执行终端**：Terminal 4 (`worktrees/pipeline`)
- **完整提示词**：详见 [prompts/4_pipeline_assembly.md](file:///C:/Users/root/orca/projects/remoteHelper/prompts/4_pipeline_assembly.md)

```markdown
# Role: Google Tech Lead & Release Engineer
# Workspace: worktrees/pipeline
# Branch: feat/boss-integration-pipeline
# Context: 负责将分支 1、2、3 进行 Git 合并与全链路总装

请在当前分支执行最终的【全链路总装、流水线调度整合与生产油猴脚本构建】：

【核心目标】：
1. 分支合并 (Git Merge)：
   - 依次合并：
     ```bash
     git merge feat/boss-blacklist-filter
     git merge feat/boss-pagination-refresh
     git merge feat/boss-batch-greet
     ```
2. 组装流水线调度器 `src/core/scheduler.js`：
   - 串联闭环：【调用 BossAdapter 翻页刷新 -> 遍历岗位经过 BlacklistFilter 过滤 -> 随机延时等待 -> 调用 BossApi 批量投递打招呼 -> 达到页底自动下一页】；
   - 支持一键开始、暂停、急停与熔断。
3. 升级 UI 交互 (`src/ui/panel.js` & `src/ui/fab.js`)：
   - 面板增加实时计数：已投递数、黑名单跳过数、当前页码、限额状态；
   - 悬浮球根据调度器状态动态切换颜色（运行绿 / 暂停黄 / 熔断红）。
4. 单文件打包构建：
   - 输出符合 Tampermonkey 标准的单文件生产脚本 `job-helper.user.js`。
5. 整体 Git Diff 审查与验收确认。

【严格约束】：
- 处理好可能的合并冲突，保持代码规范统一；
- 提交信息格式：`feat(assembly): integrate all modules into unified delivery pipeline and user script`；
- 提供完整的 `git diff main...feat/boss-integration-pipeline` 审查报告。
```
