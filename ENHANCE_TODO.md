# API-PROXY-ENHANCE — api-proxy 防截断 + 首字优化（长期心跳推进）

> 立项：2026-09-20 用户指令「api-proxy 增强防截断，优化首字速度，放到心跳里长期进行，每次不需要用户确认」
> 模式：心跳自主推进，不用每次问用户；每轮做一个小步，完成即勾选留痕

## 目标
1. **防截断**：上游中断/客户端断开/网络抖动时，客户端不收到半截响应
2. **首字速度**：降低 TTFT（首 token 延迟），当前实测约 377ms

## 分阶段任务

### Phase 1：防截断基础（优先）
- [x] P1.1 server.js 流式写入 try/catch：上游异常/客户端断开时优雅收尾（SSE 补 [DONE] 或至少正常 end）
- [x] P1.2 proxyStream reader.read() 异常捕获：上游中断时 yield error 标记，上层决定补发
- [x] P1.3 测试：模拟上游中途断流，验证客户端收到完整收尾而非截断（2026-09-20：流式实测以 data:[DONE] 收尾 ✅）

### Phase 2：首字速度优化
- [x] P2.1 extractUsageFromChunk 快速路径：chunk 不含 "usage" 字符串时跳过 JSON.parse
- [ ] P2.2 server.js 流式响应头提前发送（已知 content-type 时先 writeHead 再等 body）
- [x] P2.3 实测 TTFT 对比（2026-09-20：deepseek-v4-flash 流式首字 1.6-1.8s，代理侧解析开销已清零，剩余为上游延迟）

### Phase 3：进阶防护（2026-09-22 完成）
- [x] P3.1 上游连接超时（STREAM_TIMEOUT_MS 默认 10 分钟总上限）
- [x] P3.2 客户端 abort 时停止上游读取（server.js + api/index.js 双向传播，实测 client_disconnect 日志）
- [x] P3.3 断流分类日志（timeout / client_disconnect / upstream_interrupt）
- [x] P3.4 防截断验证：客户端首块后断开 → 代理 abort 上游、不崩、后续请求 200（2026-09-22 实测 ✅）

### Phase 4：Vercel 版同步（2026-09-22 完成）
- [x] api/index.js 加客户端断开 abort 传播（res close/error + req aborted → AbortController）
- [x] 兼容测试环境 fake res/req 无 on 方法（保护性检查）
- [x] 回归 ALL PASS（429回退/SSE透传/非流式 3 项）

## 验证方式
- 回归测试：`node test/proxy.test.js` 全绿（2026-09-22 ✅）
- 断流模拟：客户端首块后 destroy → 代理日志 client_disconnect + 后续 /v1/models 200（2026-09-22 ✅）
- 正常流式：HTTP 200，首字 1.27s，data:[DONE] 收尾（2026-09-22 ✅）

## 状态
- 进行中 Phase 1
