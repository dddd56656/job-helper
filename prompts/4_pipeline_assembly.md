# 任务 4 提示词：全链路合并组装、调度器与单文件打包 (Integration)

- **目标 Git 分支**：`feat/boss-integration-pipeline`
- **对应 Worktree 目录**：`worktrees/pipeline`
- **使用方法**：在 Orca 的 `[Terminal 4 - 流水线集成]` 终端中直接复制并发送以下指令。

---

```markdown
# Role: Google Tech Lead & Release Engineer
# Workspace: worktrees/pipeline
# Branch: feat/boss-integration-pipeline
# Context: 负责将分支 1、2、3 进行 Git 组装并输出端到端流水线

请在当前分支执行【全链路代码合并、总调度器组装、UI面板升级与单文件油猴脚本构建】：

## 一、核心需求与实现范围
1. **多分支代码合并 (Git Merge)**：
   - 确保当前分支干净，按序执行合并：
     ```bash
     git merge feat/boss-blacklist-filter -m "merge: integrate blacklist filter engine"
     git merge feat/boss-pagination-refresh -m "merge: integrate boss vue pagination adapter"
     git merge feat/boss-batch-greet -m "merge: integrate boss batch deliver api"
     ```
   - 解决潜在的文件冲突，保留各模块核心接口。

2. **核心流水线调度器 (`src/core/scheduler.js`)**：
   - 组装 `DeliveryScheduler` 类，实现完整闭环逻辑：
     - Step 1: 调用 `BossAdapter.refresh_jobs()` 获取当前页岗位；
     - Step 2: 传入 `BlacklistFilter.batchFilter()` 过滤黑名单公司（黑名单命中直接跳过，零网络请求）；
     - Step 3: 循环遍历有效岗位，每次通过 `RateLimiter.randomSleep()` 拟人化延时，调用 `BossApi.deliverJob()` 投递并触发打招呼；
     - Step 4: 当前页处理完成后，延时 10~20 秒缓冲，调用 `BossAdapter.next_page()` 切换至下一页；
     - Step 5: 达到每日投递配额或页面见底时自动停止；遇到熔断错误立即挂起。

3. **UI 控制面板升级 (`src/ui/panel.js` & `src/ui/fab.js`)**：
   - 面板增加：
     - 投递统计（已投递成功数、黑名单拦截数、当前页数）；
     - 批量投递一键开启 / 暂停按钮；
     - 单日投递上限配置项（默认 80 次）；
   - 悬浮球随状态动态变色并支持一键紧急急停。

4. **单文件构建输出 (`job-helper.user.js`)**：
   - 将模块代码合并打包为标准的单文件油猴脚本 `job-helper.user.js`，包含标准 UserScript 元数据头。

## 二、验收与审查
- 执行端到端自测，验证翻页 -> 过滤 -> 延时 -> 投递的完整状态机流转；
- 提交合并与组装代码：
  ```bash
  git add .
  git commit -m "feat(pipeline): complete end-to-end integration of pagination, blacklist and delivery"
  git diff main...feat/boss-integration-pipeline
  ```
- 输出整体变更审查报告与测试结果。
```
