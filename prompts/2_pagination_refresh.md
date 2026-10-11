# 任务 2 提示词：Vue Hook 劫持与原生翻页刷新适配器

- **目标 Git 分支**：`feat/boss-pagination-refresh`
- **对应 Worktree 目录**：`worktrees/pagination`
- **使用方法**：在 Orca 的 `[Terminal 1 - 翻页刷新]` 终端中直接复制并发送以下指令。

---

```markdown
# Role: 资深逆向与前端自动化专家
# Workspace: worktrees/pagination
# Branch: feat/boss-pagination-refresh
# Context: 参考 codebase-memory-mcp 中 boss-helper 项目 (src/composables/useVue.ts & src/entrypoints/boss/index.ts)

请在当前分支抽取 boss-helper 的【Vue 实例劫持与原生翻页能力】，并将其适配为标准化平台层：

## 一、核心需求与实现范围
1. **Vue 运行时探测与劫持工具 (`src/platforms/boss_hooks.js`)**：
   - 抽取纯原生 JavaScript 版本的 `useHookVueFn` 与 `useHookVueData`（剥离 boss-helper 原版对 Vue 3 Ref/toValue 的依赖）；
   - 实现对页面元素 `#wrap .page-job-wrapper, .job-recommend-main, .page-jobs-main` 上挂载的 `.__vue__` 实例的轮询等待与属性监听（通过 `Object.defineProperty` 监听数据更新）；
   - 提取 `pageChangeAction`（推荐页）与 `searchJobAction` / `onSearch`（搜索页）原生方法。

2. **Boss 平台标准适配器 (`src/platforms/boss_adapter.js`)**：
   - 实现适配器统一契约：
     - `initContext()`: 初始化 Vue Hook，建立对 `jobList`, `pageVo`, `hasMore` 的双向绑定；
     - `refresh_jobs()`: 获取当前页解析后的岗位数据列表，标准化为包含 `id`, `securityId`, `jobName`, `companyName`, `salaryDesc`, `contacted` 的对象；
     - `next_page()`: 直接调用组件底层的切页方法，触发下一页数据网络拉取；
     - `get_page_info()`: 返回当前页数、是否到达底部的状态。
   - 完全替代原版 job-helper 中脆弱且易僵死的 `Loader.checkAndLoad`（滚轮模拟与假 DOM 元素注入）。

3. **测试验证脚本 (`tests/boss_hooks_test.js`)**：
   - 编写模拟测试验证在虚拟/页面 DOM 环境下 Vue Hook 的捕获机制与错误超时处理。

## 二、执行约束
- 严格限定在当前分支 (`feat/boss-pagination-refresh`) 独立工作区 (`worktrees/pagination`) 内编写；
- 保持纯 JS 原生生态兼容；
- 自测通过后执行：
  ```bash
  git add src/platforms/ tests/
  git commit -m "feat(boss-adapter): extract vue hook pagination and job list reader from boss-helper"
  git diff main...feat/boss-pagination-refresh
  ```
- 输出修改总结与 git diff，停下来等待审查。
```
