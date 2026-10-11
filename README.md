# Job Helper

Job Helper 是一个用于 BOSS 直聘岗位列表页的 Tampermonkey 辅助脚本。它在用户明确点击开始后，按页读取岗位、过滤本地黑名单，并逐个发起沟通请求。

## 使用边界

- 使用前请确认行为符合 BOSS 直聘的规则、适用法律以及你的账号授权范围。
- 脚本不会自动确认平台限额、验证码、安全验证或登录提示；出现这些提示时会立即熔断，需由用户自行在页面处理。
- 请只对自己有意愿沟通的岗位使用。默认限额为 80，界面最多可设置为 150。
- 网络超时或失败不会自动重试投递，以避免重复沟通。

## 安装

1. 在浏览器安装 Tampermonkey。
2. 下载或打开仓库根目录的 `job-helper.user.js`。
3. 由 Tampermonkey 安装脚本，并确认脚本仅匹配 `https://www.zhipin.com/web/geek/*`。
4. 登录 BOSS 直聘，打开职位推荐或搜索结果页。
5. 页面右下角会出现 `JD` 悬浮按钮和控制面板。

## 操作说明

1. 在面板中设置每日投递上限。
2. 在脚本存储中维护黑名单公司；黑名单命中的岗位不会产生投递网络请求。
3. 点击“开始”启动本次任务。脚本会执行“读取当前页 → 黑名单过滤 → 随机延时 → 投递 → 翻页”。
4. 点击“暂停”会在当前安全等待步骤结束后暂停；点击“开始”可继续。
5. 点击“急停”或 `JD` 悬浮按钮会立即取消后续步骤。

面板会显示已投递数、黑名单跳过数、重复跳过数、当前页和限额状态。运行中为绿色、暂停为黄色、熔断为红色。

## 熔断条件

任务在下列情况下停止，不会继续发送后续投递请求：

- 平台沟通限额、频控、登录失效或安全验证；
- 连续三次投递失败；
- 用户急停；
- 无下一页、无岗位或达到配置限额。

同一个岗位 ID 在一次任务内只会处理一次。

## 本地开发与构建

要求 Node.js 24 或兼容版本，无第三方依赖。

```powershell
node tests/blacklist_rate_test.js
node tests/boss_hooks_test.js
node --test tests/boss_api_test.js
node tests/scheduler_test.js
node scripts/build-userscript.js
```

构建命令会把 `src/` 下的模块打包为根目录的 `job-helper.user.js`，并在写入前以普通脚本上下文做语法校验。提交涉及源码的变更前，请重新构建并提交该产物。

## 项目结构

- `src/core/blacklist.js`：本地黑名单与公司标识归一化。
- `src/core/rate_limiter.js`：随机延时和批量休息。
- `src/core/scheduler.js`：状态机、限额、去重与熔断。
- `src/platforms/`：BOSS 页面读取、翻页和请求适配。
- `src/ui/`：控制面板和悬浮急停按钮。
- `scripts/build-userscript.js`：生产单文件构建。
