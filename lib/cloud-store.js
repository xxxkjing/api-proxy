// 云端持久化：Vercel Blob Storage（私有存储）
// 无数据库、无本地存储、OIDC 自动认证（Vercel Functions 上自动可用）
// 数据分层：
//   - 热数据：store.json（keys / 当前统计快照，覆盖写 + read-merge-write 防并发覆盖）
//   - 冷归档：logs/YYYY-MM-DD.json（每日日志，只追加不删）
//
// 环境变量（Vercel 自动设置）：
//   BLOB_STORE_ID       Vercel Blob Store ID（自动认证时用）

let _blobSdk = null;
let _diag = { lastWrite: { ok: false, error: "", path: "", ts: 0 }, initTried: false };

// 动态导入 @vercel/blob（CJS 兼容）
async function getSdk() {
  if (_blobSdk) return _blobSdk;
  try {
    _blobSdk = await import("@vercel/blob");
    _diag.initTried = true;
    return _blobSdk;
  } catch (e) {
    _diag.lastWrite = { ok: false, error: "import failed: " + e.message, path: "", ts: Date.now() };
    return null;
  }
}

// 是否启用（Vercel 环境下 BLOB_STORE_ID 存在即可用）
function isEnabled() {
  return !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);
}

function getLastWrite() {
  return _diag.lastWrite;
}

/**
 * 读取 JSON（私有存储，useCache:false 获取最新版本绕过 CDN 缓存）
 */
async function readJson(pathname) {
  if (!isEnabled()) return null;
  const sdk = await getSdk();
  if (!sdk) return null;
  try {
    const blob = await sdk.get(pathname, { 
      useCache: false,
      token: process.env.BLOB_READ_WRITE_TOKEN || "",
    });
    if (!blob || blob.statusCode === 404) return null;
    // 读取 body stream
    const text = await new Response(blob.body).text();
    return JSON.parse(text);
  } catch (e) {
    if (e.statusCode === 404 || e.name === "BlobNotFoundError") return null;
    console.error("[blob] read", pathname, "error:", e.message);
    return null;
  }
}

/**
 * 写入 JSON（覆盖写 + read-merge-write 防并发覆盖）
 * 读取当前云端数据 → 合并本地新增的 key → 写回
 */
async function writeJson(pathname, obj) {
  if (!isEnabled()) {
    _diag.lastWrite = { ok: false, error: "not enabled", path: pathname, ts: Date.now() };
    return false;
  }
  const sdk = await getSdk();
  if (!sdk) return false;

  // read-merge-write：先读云端当前数据，合并本地新增项，再写回
  // 对 store.json 特别重要：多实例并发写不会互相覆盖 key
  let merged = obj;
  if (pathname === "store.json") {
    try {
      const existing = await readJson(pathname);
      if (existing && Array.isArray(existing.clientKeys) && Array.isArray(obj.clientKeys)) {
        const localKeys = new Map(obj.clientKeys.map(k => [k.key, k]));
        // 云端有、本地没有 → 加进来（保留云端数据）
        for (const k of existing.clientKeys) {
          if (!localKeys.has(k.key)) localKeys.set(k.key, k);
        }
        merged = { ...obj, clientKeys: Array.from(localKeys.values()) };
      }
    } catch (e) {
      // 合并失败不致命，用原始 obj 写
    }
  }

  try {
    await sdk.put(pathname, JSON.stringify(merged), {
      access: "private",
      allowOverwrite: true,
      contentType: "application/json",
      addRandomSuffix: false,
      token: process.env.BLOB_READ_WRITE_TOKEN || "",
    });
    _diag.lastWrite = { ok: true, error: "", path: pathname, ts: Date.now() };
    return true;
  } catch (e) {
    // 乐观锁冲突 → 重试一次
    if (e.name === "BlobPreconditionFailedError" || e.statusCode === 412) {
      console.warn("[blob] write conflict, retrying...");
      try {
        await sdk.put(pathname, JSON.stringify(merged), {
          access: "private",
          allowOverwrite: true,
          contentType: "application/json",
          addRandomSuffix: false,
        });
        _diag.lastWrite = { ok: true, error: "retry ok", path: pathname, ts: Date.now() };
        return true;
      } catch (e2) {
        _diag.lastWrite = { ok: false, error: "retry failed: " + e2.message, path: pathname, ts: Date.now() };
        return false;
      }
    }
    _diag.lastWrite = { ok: false, error: e.message, path: pathname, ts: Date.now() };
    console.error("[blob] write", pathname, "error:", e.message);
    return false;
  }
}

/**
 * 追加日志归档（按天文件，只追加不删）
 */
async function appendLogs(dateStr, entries) {
  if (!entries || !entries.length) return false;
  if (!isEnabled()) return false;
  const path = `logs/${dateStr}.json`;
  const existing = (await readJson(path)) || [];
  const merged = existing.concat(entries);
  return await writeJson(path, merged);
}

module.exports = { isEnabled, readJson, writeJson, appendLogs, getLastWrite };