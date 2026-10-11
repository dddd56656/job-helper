const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const modules = ['src/core/blacklist.js', 'src/core/rate_limiter.js', 'src/platforms/boss_hooks.js', 'src/platforms/boss_adapter.js', 'src/platforms/boss_api.js', 'src/core/scheduler.js', 'src/ui/panel.js', 'src/ui/fab.js', 'src/entry.js'];
const header = `// ==UserScript==\n// @name         Job Helper Delivery Pipeline\n// @namespace    https://github.com/job-helper\n// @version      1.0.0\n// @description  Blacklist-aware BOSS job delivery assistant\n// @match        https://www.zhipin.com/web/geek/*\n// @grant        GM_getValue\n// @grant        GM_setValue\n// @run-at       document-idle\n// ==/UserScript==\n\n`;
const contents = modules.map((file) => {
  let source = fs.readFileSync(path.join(root, file), 'utf8');
  // boss_api is ESM for its standalone test suite; the production bundle uses globals.
  source = source.replace(/^export\s+(?=(class|const|function))/gm, '');
  return `/* ${file} */\n;(function () {\n${source}\n})();\n`;
});
fs.writeFileSync(path.join(root, 'job-helper.user.js'), header + contents.join('\n'));
console.log('Built job-helper.user.js');
