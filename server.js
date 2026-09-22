// 本地长期启动 api-proxy（原生 Node http server 包装 Vercel serverless handler）
// 用法：node server.js [--port 3000]
"use strict";

// 环境变量（用户指定，本地长期运行）
process.env.API_KEYS = process.env.API_KEYS || "sk-PdgRxdRf8kyLxPzZS3PUfXhldrGlVCsT,sk-WL5wqSlQkYyPjjwQETWDDoLzR2PDBeja,sk-k39DjTodYSA8DULZi3nGckkPAGA13vhT,sk-K6n2gFi9mgghtsUzdV36YnaQGSPHKv2U,sk-a6QfRPWghPF5Iz6Op76daI7MKPlNimH3,sk-4XVY7DOBwXx27Bo6KNxCrb1etDAuaWtf";
process.env.YOUR_VERCEL_APP_API_KEY = process.env.YOUR_VERCEL_APP_API_KEY || "sk-080924";
process.env.BASE_URL = process.env.BASE_URL || "https://token.sensenova.cn";

const http = require("http");
const path = require("path");

const PORT = Number(process.argv.find((a, i) => a === "--port" && process.argv[i + 1])
  ? process.argv[process.argv.indexOf("--port") + 1]
  : (process.env.PORT || 3000));

const handler = require("./api/index.js");

// 包装原生 res 为 Vercel 风格（status/send/json）
function wrapRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.send = (data) => {
    if (!res.headersSent) {
      if (typeof data === "string") {
        if (!res.getHeader("content-type")) res.setHeader("content-type", "text/plain; charset=utf-8");
      } else {
        if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8");
        data = JSON.stringify(data);
      }
    }
    res.end(data);
    return res;
  };
  res.json = (data) => {
    if (!res.headersSent) res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
    return res;
  };
  return res;
}

// 收集请求 body
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      // 尝试 JSON 解析，否则保留原始字符串
      try {
        resolve(JSON.parse(buf.toString()));
      } catch {
        resolve(buf.toString());
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // 解析 body
  req.body = await readBody(req);
  // 防截断：客户端断开（取消/网络断）时 abort 上游读取，释放连接避免泄漏
  const ac = new AbortController();
  req.abortSignal = ac.signal;
  const onClientClose = () => { try { ac.abort(); } catch (_) {} };
  res.on('close', onClientClose);
  res.on('error', onClientClose);
  req.on('aborted', onClientClose);
  const wrappedRes = wrapRes(res);
  try {
    await handler(req, wrappedRes);
  } catch (e) {
    console.error("[server] handler error:", e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Internal Server Error", detail: e.message } }));
    }
  } finally {
    res.removeListener('close', onClientClose);
    res.removeListener('error', onClientClose);
    req.removeListener('aborted', onClientClose);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`api-proxy listening on http://0.0.0.0:${PORT}`);
  console.log(`  BASE_URL: ${process.env.BASE_URL}`);
  console.log(`  API_KEYS: ${process.env.API_KEYS.split(",").length} keys`);
  console.log(`  Admin panel: http://0.0.0.0:${PORT}/admin`);
});