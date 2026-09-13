# API 代理

这是一个简单的 API 代理项目，用于转发 API 请求。你可以用它来代理 OpenAI 的 API，也可以代理其他服务的 API。主要用于多key轮询。

## 功能

- **多 key 轮询**：随机轮询 + 每次调用后冷却（默认按 RPM=8 计算约 8.25s）+ 429 自动切换「最没调用过」的 key + 429 双倍冷却惩罚
- **SSE 流式透传**：首 token 即到即转，首字延迟 = 上游首字延迟（不等完整响应）
- **参数全透传**：temperature / tools / response_format / stream 等所有推理参数原样转发
- **后台管理面板**：`/admin` —— 曲线图（请求量/RPM、TTFT、Token、429、费用）、API Key 管理（带额度）、模型价格表、最近请求日志
- **鉴权与额度**：客户端必须使用管理面板签发的 `sk-` key（可按 token 额度计费），或管理员 key

## 使用方法 

**注意：本项目需要你自备 API 密钥。**

1. **部署到 Vercel:**

    *   点击 [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=[https://github.com/sigazen/api-proxy]) 将本项目一键部署到 Vercel。
    *   在 Vercel 部署过程中，你需要设置以下环境变量：

        | 环境变量     | 必填 | 说明                                                                                     | 默认值                     |
        | ------------ | ---- | ---------------------------------------------------------------------------------------- | -------------------------- |
        | `API_KEYS`   | 是   | 上游 API 密钥，多个密钥用逗号分隔。例如：`sk-xxxxxxxxxxxx,sk-yyyyyyyyyyyy`          | 无                         |
        | `BASE_URL`   | 否   | 目标 API 的基础 URL。例如你想代理 OpenAI 的 API，则设置为 `https://api.openai.com`。  | `https://api.openai.com` |
        | `YOUR_VERCEL_APP_API_KEY`   | 是（启用鉴权时） | 管理面板登录密码 + 管理 API 鉴权 + 转发时的管理员 key。 | 无（不设置则转发不鉴权、管理 API 不可用） |
        | `RPM`   | 否   | 上游单 key 每分钟请求上限，冷却时间按 `60/RPM*1.1` 计算。 | `8` |
        | `COOLDOWN_MS`   | 否   | 覆盖冷却时长（毫秒），优先级高于 RPM。 | 无 |

2. **使用代理地址:**

    部署完成后，Vercel 会为你生成一个应用的访问地址 (例如：`https://your-app-name.vercel.app`)。你可以使用这个地址替换原本的 API 地址，然后就像使用官方 API 一样发送请求。

    *   访问 `https://your-app-name.vercel.app/admin` 打开管理面板，用 `YOUR_VERCEL_APP_API_KEY` 登录
    *   在面板「API Key 管理」里新增带额度的 key（如额度 1000000 token）
    *   客户端用面板签发的 `sk-xxx` 作为 `Authorization: Bearer` 调用 `/v1/*`

3. **客户端调用示例:**

    ```
    POST /v1/chat/completions
    Authorization: Bearer sk-你面板签发的key
    Content-Type: application/json

    {"model":"gpt-4o-mini","messages":[{"role":"user","content":"你好"}]}
    ```

## 管理面板 API

| 端点 | 方法 | 鉴权 | 说明 |
| ---- | ---- | ---- | ---- |
| `/admin` | GET | 面板登录 | 管理面板 HTML |
| `/admin/api/stats` | GET | 管理员 key | 统计（总量/分钟序列/模型/最近日志） |
| `/admin/api/keys` | GET/POST | 管理员 key | 列出 / 新增带额度 key |
| `/admin/api/keys/toggle` | POST | 管理员 key | 启用/禁用 key |
| `/admin/api/keys/delete` | POST | 管理员 key | 删除 key |
| `/admin/api/models` | GET | 无 | 模型价格表 |

## 提示

*   `BASE_URL` 可以根据你的需要进行配置，例如你可以将其设置为其他 API 服务的地址，比如 `https://api.example.com`。
*   ⚠️ **存储说明**：当前为内存存储（无数据库），Vercel 冷启动后 key/统计会重置。若需持久化，请自行接 Neon/Postgres。
*   费用估算按内置模型价格表（`lib/models.js`）计算，未收录的模型不计费。

**就这些！尽情享用吧！**
