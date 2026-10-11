# BOSS直聘功能抽取与 job-helper 重构计划与分阶段提示词工程 (plan.md)

本项目旨在以 [dddd56656/job-helper](https://github.com/dddd56656/job-helper) 为主体进行重构，从 [Ocyss/boss-helper](https://github.com/Ocyss/boss-helper) 中抽取 BOSS 直聘的**岗位刷新与翻页**、**批量投递**与**批量发送招呼语**能力，并与 job-helper 现有的**公司黑名单跳过**逻辑深度联动。

为了防止大模型出现“急躁冒进（Premature Coding）”导致代码逻辑混乱，整体重构流程严格实行**阶段化门禁机制（Gating Mechanism）**：**先完善规划方案（Plan Only），经人工确认与强烈要求后，再按原子任务逐一改动代码**。同时，利用 Orca 多终端环境为每个核心功能分配独立的 Git 分支，方便后续进行清晰的 `git diff` 比对与合并。

---

## 阶段零：终点场景功能拆解、Git 特性分支与 Orca 独立终端初始化

> **执行目的**：基于终点场景进行模块解耦，并在 Orca 环境中为每个功能创建专属 Git 分支与终端环境，以便后续模块独立开发和 `git diff` 审查。

### 终点场景功能模块拆解
| 分支名称 | 核心功能目标 | 隔离开发范围 |
| :--- | :--- | :--- |
| `feat/boss-pagination-refresh` | **岗位检索与深度翻页** | 抽取 `boss-helper` 的翻页抓取与岗位列表解析逻辑，对接 `job-helper` 数据结构 |
| `feat/boss-batch-greet` | **批量打招呼与话术发送** | 抽取 `boss-helper` 的批量发送招呼语能力、频率控制与风控防封间隔 |
| `feat/boss-blacklist-filter` | **黑名单智能过滤联动** | 将 `job-helper` 已有的公司/岗位/HR黑名单机制注入到 BOSS 岗位流与打招呼前置拦截链路中 |
| `feat/boss-integration-pipeline` | **端到端流水线集成** | 串联翻页刷新 -> 黑名单过滤 -> 批量打招呼完整闭环，准备总合并与 diff 对比 |

```markdown
# Role: Google DevOps & Release Engineer
# Task: 终点业务场景功能解耦、Git 特性分支创建与 Orca 独立终端初始化
# Context: 项目位于 Orca 环境，终点场景为将 boss-helper 翻页、批量打招呼与 job-helper 黑名单过滤闭环融合

请严格按照以下规范，为四大核心功能模块创建独立的 Git 特性分支与终端工作上下文：

## 1. 终点功能模块拆解定义
- **Feature A (翻页刷新)**: `feat/boss-pagination-refresh`
  - 职责: 提取 boss-helper 岗位翻页/列表拉取能力，适配 job-helper 平台层。
- **Feature B (批量打招呼)**: `feat/boss-batch-greet`
  - 职责: 提取 boss-helper 批量投递/发送招呼语逻辑与防封控间隔。
- **Feature C (黑名单拦截)**: `feat/boss-blacklist-filter`
  - 职责: 联动 job-helper 现有公司黑名单，在前置管道中跳过目标公司/HR。
- **Feature D (流水线聚合)**: `feat/boss-integration-pipeline`
  - 职责: 串联上述能力并输出端到端流水线（翻页 -> 过滤 -> 发送）。

## 2. 执行步骤 (Terminal & Git Operations)
1. **主干基准对齐**：
   - 确保当前主分支处于 clean 状态，拉取或检出基准分支（如 `main` 或 `dev`）。
2. **创建 4 个隔离特性分支**：
   - 基于基准分支，依次执行：
     ```bash
     git branch feat/boss-pagination-refresh
     git branch feat/boss-batch-greet
     git branch feat/boss-blacklist-filter
     git branch feat/boss-integration-pipeline
     ```
3. **分配/初始化 Orca 对应终端环境**：
   - 为每个功能分别分配一个独立的 Terminal Session（或通过 `git worktree` 创建独立目录结构 `worktrees/<branch-name>`，确保多终端互不干扰代码修改与构建依赖）。
   - 在各终端中打印就绪标识：
     - `[Terminal 1 - Pagination] Branch: feat/boss-pagination-refresh`
     - `[Terminal 2 - BatchGreet] Branch: feat/boss-batch-greet`
     - `[Terminal 3 - Blacklist]  Branch: feat/boss-blacklist-filter`
     - `[Terminal 4 - Pipeline]   Branch: feat/boss-integration-pipeline`
4. **输出验证报告与 Diff 指引**：
   - 执行 `git branch -v` 验证分支创建状态。
   - 提供后续各分支与基准分支的比较命令（如 `git diff main...feat/boss-pagination-refresh`）。

## 【🚨 执行约束】
- 本提示词仅用于建立分支结构与准备多终端隔离环境，严禁在此阶段编写任何业务逻辑代码。
- 完成分支与终端映射后，请停下等待我的具体功能开发指令。
```

---

## 阶段一：仓库拉取与 Codebase Memory 索引构建

> **执行目的**：将两个开源仓库克隆至本地，并将其 AST 与代码结构注入 `codebase-memory-mcp` 知识图谱，为后续精确分析打好基础。

```markdown
# Role: 全栈架构工程师 / Codebase Memory 专家
# Task: 拉取目标开源仓库并注入 Codebase Memory MCP 知识图谱

请执行以下初始化工作：
1. 在当前工作区创建目录 `workspace/reference`，将以下两个仓库克隆到本地：
   - 主体项目: https://github.com/dddd56656/job-helper
   - 参考项目: https://github.com/Ocyss/boss-helper
2. 调用 codebase-memory-mcp 工具，分别对两个项目执行代码索引（`index_repository`）：
   - 项目一名称: job-helper
   - 项目二名称: boss-helper
3. 索引完成后，调用 `index_status` 验证状态，并输出简要的索引确认报告（包含关键技术栈：语言、框架、是否有反爬/无头浏览器依赖等）。

【严格限制】：
- 本步骤仅进行仓库克隆与索引构建，不要修改任何业务代码，不要进行任何重构推演。
```

---

## 阶段二：逆向分析与能力解耦提炼（Deep Analysis）

> **执行目的**：利用代码知识图谱工具深入逆向两个项目的实现机制，定位核心能力调用链与架构适配点。

```markdown
# Role: 资深逆向与爬虫自动化专家
# Task: 跨项目能力分析与接口解耦定位
# Context: 已索引 job-helper 和 boss-helper

请利用 codebase-memory-mcp 的 `search_graph`, `trace_path`, `get_code_snippet` 工具，对两个项目进行深度对比分析，输出一份《能力解耦分析报告》：

1. 【boss-helper 核心能力逆向】：
   - 定位「BOSS直聘岗位刷新/检索」的底层实现（API 请求还是 Playwright/Puppeteer/Selenium DOM 操作？Cookie/Token 维系机制）。
   - 定位「批量投递 / 简历发送」与「批量打招呼/自定义话术发送」的调用链与频率控制（Rate Limit / 防封策略）。
2. 【job-helper 架构适配性分析】：
   - 分析 job-helper 当前的插件/平台扩展架构（其平台适配层、任务调度层、UI/CLI 触发入口）。
   - 评估将 boss-helper 的上述能力移植到 job-helper 时面临的兼容性挑战（如：依赖冲突、并发模型、登录态共享）。

【严格限制】：
- 只输出架构、函数调用链、依赖分析与数据流走向，严禁输出任何重构代码。
```

---

## 阶段三：制定重构 Blueprint 与实施方案（Plan Only）

> **执行目的**：制定系统级架构方案与按步骤拆分的实施方案，严格禁止输出落地代码，等待人工审查与门禁批准。

```markdown
# Role: Google Staff Architect
# Task: 制定以 job-helper 为主体的功能融合与重构实施方案 (Plan Only)

基于此前的分析结果，以 job-helper 为基底，制定一份细化到函数级的《BOSS直聘自动化模块融合重构计划 (DESIGN_DOC.md)》。

计划书必须包含以下章节：
1. 整体架构设计：
   - 目标架构图（Mermaid 格式），展示 boss-helper 抽取模块如何无缝插入 job-helper 核心生命周期。
   - 接口设计（定义统一的 JobPlatformAdapter 接口：`refresh_jobs`, `batch_deliver`, `batch_greet`）。
2. 模块迁移清单：
   - 需要从 boss-helper 抽取的纯函数、类及资源列表。
   - 需要在 job-helper 中新增/改造的目录结构与文件清单。
3. 风险与防御机制：
   - 防封禁风控策略（模拟鼠标、随机延迟、每日阈值上限控制）。
4. 渐进式实施步骤（分为至少 4-6 个原子任务）：
   - Task 1: 基础设施与登录鉴权对接
   - Task 2: 岗位刷新与筛选能力移植
   - Task 3: 批量投递与打招呼核心逻辑迁移
   - Task 4: 任务调度与频率控制集成
   - Task 5: 联调与测试验证
   - 每个 Task 必须明确【改动文件】、【依赖前提】与【完成判据 (Acceptance Criteria)】。

【🚨 核心防冒进规则 (Crucial Constraint)】：
- 本阶段你的任务 100% 仅限于制定计划与设计方案。
- 严禁创建、修改或生成任何业务落地代码！
- 在方案最后，请停下来等待我的审查与逐项指令。除非我发出类似“确认第 X 步，开始写代码”的明确指令，否则坚决不写代码。
```

---

## 阶段四：单步触发与原子化代码改动（Step-by-Step Execution）

> **执行目的**：通过门禁确认后，按单个原子任务进行精准代码变更，单步修改并单步验证，避免一次性重构导致失控。

```markdown
# Role: Google Senior Software Engineer
# Task: 仅执行重构计划中的 [Task X: 具体任务名称]

我已批准计划中的 [Task X]。现在请你**仅针对该任务**编写与改动代码：

【执行要求】：
1. 严格限定范围：只修改该任务声明的文件，不得跨越到后续 Task 的改动中。
2. 风格与契约一致：保持 job-helper 原有编码规范与类型提示。
3. 验证与自测：修改完成后，给出对应的单元测试或模拟运行命令，验证当前步骤已达到预设的 Acceptance Criteria。
4. 汇报与停顿：完成该步骤后，总结改动点并展示代码 diff，然后停下来等待我确认，不得擅自进入下一步。
```
