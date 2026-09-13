# API 代理

这是一个简单的 API 代理项目，用于转发 API 请求。你可以用它来代理 OpenAI 的 API，也可以代理其他服务的 API。主要用于多key轮询。

## 使用方法

**注意：本项目需要你自备 API 密钥。**

1. **部署到 Vercel:**

    *   点击 [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=[https://github.com/sigazen/api-proxy]) 将本项目一键部署到 Vercel。
    *   在 Vercel 部署过程中，你需要设置以下环境变量：

        | 环境变量     | 必填 | 说明                                                                                     | 默认值                     |
        | ------------ | ---- | ---------------------------------------------------------------------------------------- | -------------------------- |
        | `API_KEYS`   | 是   | 你的 API 密钥，多个密钥可以用逗号分隔。例如：`sk-xxxxxxxxxxxx,sk-yyyyyyyyyyyy`          | 无                         |
        | `BASE_URL`   | 否   | 目标 API 的基础 URL。例如你想代理 OpenAI 的 API，则设置为 `https://api.openai.com`。  | `https://api.openai.com` |
        | `YOUR_VERCEL_APP_API_KEY`   | 否   | 你可以设置一个 `YOUR_VERCEL_APP_API_KEY` 环境变量用于鉴权, 防止滥用。  | 无                         |

2. **使用代理地址:**

    部署完成后，Vercel 会为你生成一个应用的访问地址 (例如：`https://your-app-name.vercel.app`)。你可以使用这个地址替换原本的 API 地址，然后就可以像使用官方 API 一样发送请求了。

  
**提示：**

*   `BASE_URL` 可以根据你的需要进行配置，例如你可以将其设置为其他 API 服务的地址，比如 `https://api.example.com`。
*   因为做了重定向, 所以在客户端中你可以随意填写 `api_key`, 或者你可以在客户端设置一个 `YOUR_VERCEL_APP_API_KEY` 环境变量用于鉴权。

**就这些！尽情享用吧！**
