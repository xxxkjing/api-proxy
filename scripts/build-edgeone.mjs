// 打包 api-proxy 为 EdgeOne 单文件 worker（Service Worker 风格，无 require/fs/process）
// 输出：edgeone/worker.js —— 直接在 EdgeOne 控制台粘贴部署
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

function indent(src, n) {
  const pad = ' '.repeat(n);
  return src.split('\n').map(l => pad + l).join('\n');
}

// 模块源码
const storeSrc = read('lib/store.js')
  // EdgeOne 无 require：兜底 crypto 用全局 Web Crypto
  .replace("const crypto = require(\"crypto\");", "const crypto = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;")
  .replace("let fs = null;", "let fs = null; // EdgeOne: 无 fs（下方 try require 会失败→纯内存）")
  .replace("try {\n  fs = require(\"fs\");", "try { throw new Error('no-fs'); fs = require(\"fs\");")
  .replace("const modelsMod = require(\"./models\");", "const modelsMod = __requireModule('lib/models.js');")
  .replace("const { estimateCost } = require(\"./models\");", "const { estimateCost } = __requireModule('lib/models.js').estimateCost !== undefined ? __requireModule('lib/models.js') : {};");

const modelsSrc = read('lib/models.js');
const adminSrc = read('lib/admin-page.js');
const coreSrc = read('lib/core.js')
  // core.js 顶部依赖改造成打包器模块查找（EdgeOne 无 require）
  .replace("const store = require('../lib/store');", "const store = __requireModule('lib/store.js');")
  .replace("const { MODELS, lookupModel } = require('../lib/models');", "const { MODELS, lookupModel } = __requireModule('lib/models.js');")
  .replace("const adminHtml = require('../lib/admin-page.js');", "const adminHtml = __requireModule('lib/admin-page.js');");

const worker = `// EdgeOne Edge Function — api-proxy（由 scripts/build-edgeone.mjs 生成，勿手改）
// 部署：EdgeOne 控制台 → 边缘函数 → 新建/编辑 → 粘贴本文件 → 部署 → 配置触发规则 → 环境变量
// 环境变量：API_KEYS(必填), BASE_URL, YOUR_VERCEL_APP_API_KEY(或 ADMIN_KEY), RPM, COOLDOWN_MS
// 注意：EdgeOne 无文件系统，数据为纯内存（重启清零）；持久化请用 KV 或自托管

const __modules = {};
function __requireModule(id) {
  if (__modules[id]) return __modules[id].exports;
  const factory = __modules[__moduleFactories[id]];
  if (!factory) { throw new Error('module not found: ' + id); }
  const mod = { exports: {} };
  __modules[id] = mod;
  factory(mod, mod.exports);
  return mod.exports;
}
const __moduleFactories = {
  'lib/store.js': function(module, exports) {
${indent(storeSrc, 4)}
  },
  'lib/models.js': function(module, exports) {
${indent(modelsSrc, 4)}
  },
  'lib/admin-page.js': function(module, exports) {
${indent(adminSrc, 4)}
  },
};
// core 模块立即工厂（无 require 依赖）
const __coreFactory = function() {
${indent(coreSrc.replace('module.exports = function createHandler', 'return function createHandler'), 4)}
};

// 环境变量解析：EdgeOne 通过 event.env 或全局 env
function resolveEnv(event) {
  const e = (event && event.env) || globalThis.env || {};
  const get = (k) => {
    if (e && typeof e.get === 'function') { const v = e.get(k); if (v != null) return v; }
    return e[k] != null ? e[k] : undefined;
  };
  const raw = get('API_KEYS') || get('KEYS') || '';
  return {
    API_KEYS: String(raw).split(',').map(s => s.trim()).filter(Boolean),
    BASE_URL: get('BASE_URL') || 'https://api.openai.com',
    ADMIN_KEY: get('ADMIN_KEY') || get('YOUR_VERCEL_APP_API_KEY') || '',
    RPM: get('RPM'),
    COOLDOWN_MS: get('COOLDOWN_MS'),
  };
}

addEventListener('fetch', (event) => {
  event.respondWith(handle(event));
});

async function handle(event) {
  const request = event.request;
  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
    try { body = await request.text(); } catch (_) { body = null; }
  }
  const reqLike = {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body,
  };
  const handler = __coreFactory();
  const result = await handler(reqLike, { env: resolveEnv(event) });

  if (result.stream) {
    // 流式：包装成 ReadableStream 响应（SSE 首 token 即到即转）
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of result.stream) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(stream, { status: result.status, headers: result.headers });
  }
  return new Response(result.body || '', { status: result.status, headers: result.headers });
}

function indent(src, n) {
  const pad = ' '.repeat(n);
  return src.split('\\n').map(l => pad + l).join('\\n');
}
`;

writeFileSync(join(root, 'edgeone', 'worker.js'), worker);
console.log('edgeone/worker.js 生成:', worker.length, 'bytes');
