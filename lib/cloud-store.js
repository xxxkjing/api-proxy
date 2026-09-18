// 云端持久化：GitHub 私有仓库 Contents API 读写 JSON 文件
// 零数据库、零本地存储、零用户配置（复用环境已有的 GitHub token）
// 数据分层：
//   - 热数据：store.json（keys / 当前统计快照，覆盖写）
//   - 冷归档：logs/YYYY-MM-DD.json（每日日志，只追加不删）
//
// 环境变量（Vercel 上配置，或本地 .env）：
//   GITHUB_TOKEN       GitHub PAT（必需，需 repo 权限）
//   GITHUB_REPO        owner/repo（默认 xxxkjing/api-proxy-data）
//   GITHUB_BRANCH      分支（默认 main）

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "xxxkjing/api-proxy-data";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

const API = "https://api.github.com";

// 是否启用云端持久化（无 token 则退化：静默跳过写，读返回 null）
const enabled = !!GITHUB_TOKEN;

/**
 * 读取一个路径的 JSON 内容（base64 解码）
 * @returns {Promise<object|null>} 不存在或失败返回 null
 */
async function readJson(path) {
  if (!enabled) return null;
  try {
    const resp = await fetch(
      `${API}/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "api-proxy",
        },
      }
    );
    if (resp.status === 404) return null;
    if (!resp.ok) {
      console.error(`[cloud] read ${path} failed: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (data.type !== "file" || !data.content) return null;
    const buf = Buffer.from(data.content, "base64").toString("utf8");
    return JSON.parse(buf);
  } catch (e) {
    console.error(`[cloud] read ${path} error:`, e.message);
    return null;
  }
}

/**
 * 写入一个路径的 JSON 内容（覆盖写，自动处理 sha 并发冲突）
 * @returns {Promise<boolean>} 是否成功
 */
async function writeJson(path, obj) {
  if (!enabled) return false;
  const content = Buffer.from(JSON.stringify(obj)).toString("base64");
  // 先取当前 sha（若存在）
  let sha = null;
  try {
    const head = await fetch(
      `${API}/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "api-proxy",
        },
      }
    );
    if (head.ok) {
      const d = await head.json();
      if (d.sha) sha = d.sha;
    }
  } catch (e) {
    // 取 sha 失败不致命，尝试无 sha 写（新文件场景）
  }

  const body = {
    message: `update ${path}`,
    content,
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  try {
    const resp = await fetch(`${API}/repos/${GITHUB_REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "api-proxy",
      },
      body: JSON.stringify(body),
    });
    if (resp.ok) return true;
    console.error(`[cloud] write ${path} failed: HTTP ${resp.status}`);
    return false;
  } catch (e) {
    console.error(`[cloud] write ${path} error:`, e.message);
    return false;
  }
}

/**
 * 追加日志归档（按天文件，只追加不删）
 * 实现：读当日文件 → 合并 → 写回。日志量小，读改写开销可接受。
 */
async function appendLogs(dateStr, entries) {
  if (!enabled || !entries || !entries.length) return false;
  const path = `logs/${dateStr}.json`;
  const existing = (await readJson(path)) || [];
  const merged = existing.concat(entries);
  return await writeJson(path, merged);
}

module.exports = { enabled, readJson, writeJson, appendLogs };