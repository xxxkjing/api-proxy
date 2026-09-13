# API_PROXY_ADMIN — api-proxy 管理面板（内存版，无数据库）

> 用户 2026-09-13 批准：「现在先做」
> 约束：不用数据库，全部内存存储（Vercel 冷启动会重置，用户已知晓并接受）

## 目标
后台管理面板：登录用环境变量鉴权 key；动态刷新曲线图（TTFT/RPM/token/429/费用）；模型价格表；新增带额度 API key 并扣费。

## 阶段

### S1 鉴权 + key 管理 + 统计采集
- [x] lib/models.js：主流模型官方价格表（OpenAI/GLM/DeepSeek/Claude）
- [x] lib/store.js：内存存储（keys/logs/分钟统计）+ 环形缓冲
- [x] api/index.js：转发前校验客户端 key（管理 key 或生成的 sk-xxx），统计 TTFT/RPM/token/429

### S2 管理 API
- [x] GET /admin/api/stats：聚合统计 + 分钟序列（供曲线图）
- [x] GET /admin/api/keys：key 列表
- [x] POST /admin/api/keys：新增带额度 key（name+quota）
- [x] PATCH/DELETE /admin/api/keys：禁用/删除
- [x] GET /admin/api/models：模型价格表
- [x] 管理 API 全部校验 admin key（Authorization Bearer 环境变量 key）

### S3 面板前端
- [x] public/admin.html：登录页（存 localStorage）
- [x] Chart.js 曲线图：TTFT / RPM / token / 请求量 / 429
- [x] key 管理表格：列表/新增/禁用/删除/剩余额度
- [x] 模型价格表展示
- [x] 动态刷新（setInterval 轮询）

### S4 测试 + 部署
- [x] 单元测试：key 生成/校验/扣费、统计聚合
- [x] 集成测试：mock 上游 + 管理 API + 转发扣费
- [x] vercel.json 路由更新（/admin）
- [ ] 推送 GitHub + 部署验证（当前进行中）

## 备注
- 转发路径：客户端 Authorization 用管理 key 或生成的 sk-xxx；上游仍走 RPM 轮询池
- 流式 token 统计：优先 stream_options.include_usage 的 SSE usage chunk；非流式从响应 json 的 usage 解析
