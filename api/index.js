const API_KEYS = process.env.API_KEYS ?
  process.env.API_KEYS.split(',').map(key => key.trim()).filter(Boolean) :
  [];
const BASE_URL = process.env.BASE_URL || 'https://api.openai.com';

let currentKeyIndex = 0;

async function handleStream(response, res) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let done = false;

  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    if (value) {
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }
  }

  res.end();
}

async function handleNonStream(response, res) {
  const data = await response.json();
  res.status(response.status).json(data);
}

async function proxyRequest(req, res, apiKey) {
  // 修改这里的逻辑以适应新的路由
  const url = req.url;
  let targetUrl;
  if (url.startsWith('/api')) {
    targetUrl = `${BASE_URL}${url.replace('/api', '/v1')}`;
  } else {
    targetUrl = `${BASE_URL}${url}`;
  }

  console.log('targetUrl:', targetUrl);

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': req.headers['content-type'] || 'application/json',
  };

  let body = null;
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    if (typeof req.body === 'string') {
      body = req.body;
    } else if (Buffer.isBuffer(req.body)) {
      body = req.body.toString();
    } else if (typeof req.body === 'object') {
      body = JSON.stringify(req.body);
    }
  }

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: body,
    });

    // 添加这行日志，打印完整的 Headers 对象
    console.log('Response headers from target:', response.headers);

    // 记录完整的响应体
    const responseText = await response.text();
    console.log('Response body from target:', responseText);

    // 只转发这两个标头
    const headersToForward = ['content-type', 'authorization'];
    for (const [key, value] of response.headers.entries()) {
      if (headersToForward.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }
    
    // 将原始响应体发送给客户端
    res.status(response.status).send(responseText);

  } catch (error) {
    console.error('Proxy error:', error);
    throw error;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  console.log('Available API keys:', API_KEYS.length);

  if (!API_KEYS.length) {
    return res.status(500).json({
      error: {
        message: `"API_KEYS environment variable is not set or is empty"`,
        type: `"config_error"`,
        param: `"API_KEYS"`,
        code: `"missing_api_keys"`
      }
    });
  }

  let retries = 0;
  const maxRetries = API_KEYS.length;

  while (retries < maxRetries) {
    const apiKey = API_KEYS[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;

    try {
      await proxyRequest(req, res, apiKey);
      return;
    } catch (error) {
      retries++;
      console.warn(`Request failed with key ${apiKey}, retrying... (${retries}/${maxRetries})`);
      if (retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  }

  return res.status(500).json({
    error: {
      message: `"All API keys failed"`,
      type: `"api_error"`,
      param: null,
      code: `"all_keys_failed"`
    }
  });
};
