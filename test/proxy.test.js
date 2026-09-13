// api-proxy 回归测试：429+SSE 边界 + 流式透传 + 非流式转发
// 运行：node test/proxy.test.js（零依赖，纯 node:http）
process.env.RPM = "100";
const http = require("http");
const assert = require("assert");
const MOD = require("path").resolve(__dirname, "../api/index.js");

function run(env, handler, stream = true) {
  return new Promise((resolve) => {
    const mock = http.createServer(handler);
    mock.listen(0, async () => {
      const port = mock.address().port;
      Object.assign(process.env, { ...env, BASE_URL: `http://127.0.0.1:${port}` });
      delete require.cache[MOD];
      const mod = require(MOD);
      let sc = 0, body = null, writes = [];
      const res = {
        setHeader: () => {}, status: (c) => { sc = c; return { json: (d) => { body = JSON.stringify(d); }, send: (t) => { body = t; } }; },
        write: (t) => writes.push(t), end: () => {},
      };
      const req = { method: "POST", url: "/v1/chat/completions", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-x", stream }) };
      await mod(req, res);
      mock.close(() => resolve({ sc, body, writes }));
    });
  });
}

(async () => {
  let calls = 0;
  const r1 = await run({ API_KEYS: "k1" }, (req, res) => {
    calls++;
    res.writeHead(429, { "content-type": "text/event-stream" });
    res.end('data: {"error":"rate limited"}\n\n');
  });
  assert.equal(r1.sc, 502, "429+SSE 应最终 502");
  assert.equal(calls, 3, "应重试 3 次");
  console.log("✅ 1. 429+SSE content-type 正确回退");

  const r2 = await run({ API_KEYS: "k2" }, (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    setTimeout(() => res.end('data: [DONE]\n\n'), 20);
  });
  assert.ok(r2.writes.length >= 1, `流式应透传（got ${r2.writes.length}）`);
  assert.ok(r2.writes.join("").includes("你"), "应含流式内容");
  console.log("✅ 2. SSE 流式透传（边读边写）");

  const r3 = await run({ API_KEYS: "k3" }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }, false);
  assert.equal(r3.sc, 200);
  assert.ok(r3.body && r3.body.includes("ok"), "非流式应完整转发 body");
  console.log("✅ 3. 非流式文本转发");

  console.log("\nALL PASS");
  process.exit(0);
})();
