const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

const modules = [
  'src/core/blacklist.js',
  'src/core/rate_limiter.js',
  'src/platforms/boss_chat.js',
  'src/platforms/boss_hooks.js',
  'src/platforms/boss_adapter.js',
  'src/platforms/boss_api.js',
  'src/platforms/job51_adapter.js',
  'src/core/scheduler.js',
  'src/ui/panel.js',
  'src/ui/fab.js',
  'src/entry.js',
];

const header = `// ==UserScript==
// @name         招聘网站全能助手 (Job Helper Universal)
// @namespace    https://github.com/job-helper
// @version      34.0
// @description  全能招聘助手：前程无忧与BOSS直聘双平台黑名单实时互通共享、卡片一键屏蔽、BOSS直聘全链路流水线自动沟通、自定义MQTT招呼语与智能防封
// @match        *://www.zhipin.com/*
// @match        *://*.51job.com/*
// @match        *://search.51job.com/*
// @match        *://we.51job.com/*
// @require      https://cdn.jsdelivr.net/npm/protobufjs@7.2.6/dist/protobuf.min.js
// @require      https://cdn.jsdelivr.net/npm/mqtt@5.15.2/dist/mqtt.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_addValueChangeListener
// @run-at       document-idle
// ==/UserScript==

`;

const contents = modules.map((file) => {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  source = source.replace(/^export\s+/gm, '');
  return `/* ${file} */\n;(function () {\n${source}\n})();\n`;
});

const output = header + contents.join('\n');

// 语法编译校验
new vm.Script(output, { filename: 'job-helper.user.js' });

fs.writeFileSync(path.join(root, 'job-helper.user.js'), output);
fs.writeFileSync(path.join(root, 'job-helper.js'), output);
console.log('Built job-helper.user.js and job-helper.js (Universal 51job + Boss)');

