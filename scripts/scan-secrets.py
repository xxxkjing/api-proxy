#!/usr/bin/env python3
"""
密钥泄露扫描器 —— 推送/上传 GitHub 前必跑
=========================================
用法：
  python3 scripts/scan-secrets.py [路径...]

默认扫当前目录（排除 node_modules/.git），检测常见密钥模式：
  sk- / ghp_ / vcp_ / AKIA / Bearer / password= / token=

退出码：0=干净, 1=发现疑似密钥（必须处理后才允许推送）
"""
import re
import sys
import os

PATTERNS = [
    (r"sk-[A-Za-z0-9]{16,}", "OpenAI 风格 key"),
    (r"ghp_[A-Za-z0-9]{20,}", "GitHub PAT"),
    (r"vcp_[A-Za-z0-9]{20,}", "Vercel token"),
    (r"AKIA[A-Z0-9]{16}", "AWS Access Key"),
    (r"sk_live_[A-Za-z0-9]{20,}", "Stripe key"),
    (r"password\s*=\s*['\"]?[^'\"\s]{8,}", "明文密码"),
    (r"token\s*=\s*['\"]?[A-Za-z0-9]{20,}", "硬编码 token"),
    (r"Bearer\s+[A-Za-z0-9._-]{20,}", "Bearer 凭证"),
]

EXCLUDE_DIRS = {".git", "node_modules", "data", "__pycache__", ".venv", "venv"}
EXCLUDE_FILES = {"package-lock.json", ".gitignore"}


def scan_file(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            text = f.read()
    except OSError:
        return []
    hits = []
    for pat, label in PATTERNS:
        for m in re.finditer(pat, text):
            # 提取行号
            line_no = text[: m.start()].count("\n") + 1
            line = text.split("\n")[line_no - 1].strip()
            hits.append((path, line_no, label, line[:120]))
    return hits


def scan_dir(root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if fn in EXCLUDE_FILES:
                continue
            fp = os.path.join(dirpath, fn)
            hits.extend(scan_file(fp))
    return hits


def main():
    roots = sys.argv[1:] or ["."]
    all_hits = []
    for r in roots:
        if os.path.isfile(r):
            all_hits.extend(scan_file(r))
        else:
            all_hits.extend(scan_dir(r))

    if not all_hits:
        print("✅ 扫描干净：未发现疑似密钥")
        return 0

    print(f"⚠️  发现 {len(all_hits)} 处疑似密钥，禁止推送！")
    for path, line_no, label, line in all_hits:
        print(f"  {path}:{line_no} [{label}] {line}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
