// 本地长期启动 api-proxy（原生 Node http server 包装 Vercel serverless handler）
// 用法：node server.js [--port 3000]
// 安全：API_KEYS / YOUR_VERCEL_APP_API_KEY / BASE_URL 必须从环境变量提供，
//       源码中禁止硬编码任何密钥（push 前跑 scripts/scan-secrets.py）
"use strict";

const http = require("http");
const path = require("path");

const PORT = Number(process.argv.find((a, i) => a === "--port" && process.argv[i + 1])
  ? process.argv[process.argv.indexOf("--port") + 1]
  : (process.env.PORT || 3000));

const handler = require("./api/index.js");

// 包装原生 res 为 Vercel 风格（status/send/json）
function wrapRes(res) {
  return {
    setHeader: (k, v) => res.setHeader(k, v),
    status: (code) => { res.statusCode = code; return { send: (b) => res.end(b), json: (o) => res.end(JSON.stringify(o)) }; },
    send: (b) => res.end(b),
    json: (o) => res.end(JSON.stringify(o)),
  };
}

const server = http.createServer(async (req, res) => {
  const reqBody = await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data || undefined));
  });
  const reqLike = { method: req.method, url: req.url || "/", headers: req.headers, body: reqBody };
  try {
    await handler(reqLike, wrapRes(res));
  } catch (e) {
    console.error("[server] error:", e);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: { message: "Internal Server Error" } }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[api-proxy] listening on http://0.0.0.0:${PORT}`);
  console.log(`[api-proxy] BASE_URL=${process.env.BASE_URL || "(未设置)"}`);
  console.log(`[api-proxy] API_KEYS=${(process.env.API_KEYS || "").split(",").filter(Boolean).length} keys`);
});
