// 本地长期启动 api-proxy（原生 Node http server 包装 Vercel serverless handler）
// 用法：node server.js [--port 3000]
// 安全：API_KEYS / YOUR_VERCEL_APP_API_KEY / BASE_URL 必须从环境变量或 .env 提供，
//       禁止在源码中硬编码任何密钥。
"use strict";

const http = require("http");
const path = require("path");

const PORT = Number(process.argv.find((a, i) => a === "--port" && process.argv[i + 1])
  ? process.argv[process.argv.indexOf("--port") + 1]
  : (process.env.PORT || 3000));
