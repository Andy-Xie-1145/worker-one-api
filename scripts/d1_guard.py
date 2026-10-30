#!/usr/bin/env python3
"""部署前的 D1 迁移历史守卫（只读）。

用法：
  python scripts/d1_guard.py check     # 比对本地 migrations/*.sql 与远端 d1_migrations
  python scripts/d1_guard.py selftest  # 不碰网络，自检比对函数

规则（fail-closed，宁可误报也不让半迁移状态上线）：
  - 远端已应用、本地却找不到同名文件 → 漂移，拒绝部署；
  - 本地有、远端没应用 → 提示「先 db:migrate 再 deploy」（不算失败，列出来提醒）；
  - 本地文件名不符合 NNNN_*.sql 排序约定 → 拒绝。

上游 webclaw-api 同名脚本还包含生产库指纹锁定与一次性 baseline 采纳，
那些绑定他们各自的数据库与迁移历史，不适用本项目，没有移植。
"""
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_NAME = "oneapi"
NAME_RE = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")


def fail(reason: str):
    print(f"✗ {reason}")
    sys.exit(1)


def local_migrations():
    files = sorted((ROOT / "migrations").glob("*.sql"))
    bad = [f.name for f in files if not NAME_RE.match(f.name)]
    if bad:
        fail(f"迁移文件名不符合 NNNN_*.sql 约定：{bad}")
    return files


def run_wrangler(*args, timeout=120):
    # 认证失败不绕过；Cloudflare 传输瞬断可重试三次（只读查询，重试安全）。
    last = ""
    for attempt in range(3):
        result = subprocess.run(["wrangler", *args], cwd=ROOT, capture_output=True, text=True, timeout=timeout)
        if result.returncode == 0:
            return result.stdout
        last = (result.stderr + "\n" + result.stdout)[-900:]
        if "fetch failed" not in last or attempt == 2:
            break
        time.sleep(1 + attempt)
    fail(f"wrangler 执行失败：{last[-350:]}")


def remote_applied():
    payload = run_wrangler("d1", "execute", DB_NAME, "--remote", "--json", "--command",
                           "SELECT name FROM d1_migrations ORDER BY id")
    data = json.loads(payload)
    first = data[0] if isinstance(data, list) else data
    if not first.get("success"):
        fail("远端 d1_migrations 查询失败")
    return [r["name"] for r in first.get("results", [])]


def compare(local_files, applied):
    """返回 (漂移, 待应用)。漂移 = 远端有记录、本地没文件。"""
    local_names = {f.name for f in local_files}
    drift = [name for name in applied if name not in local_names]
    pending = [f.name for f in local_files if f.name not in set(applied)]
    return sorted(drift), pending


def check():
    files = local_migrations()
    print(f"本地迁移：{len(files)} 个")
    applied = remote_applied()
    print(f"远端已应用：{len(applied)} 个")
    drift, pending = compare(files, applied)
    if drift:
        fail("迁移历史漂移（远端有记录、本地无文件）：" + ", ".join(drift))
    if pending:
        print(f"⚠ 有 {len(pending)} 个本地迁移未应用到远端，先 `npm run db:migrate` 再部署：")
        for name in pending:
            print(f"  - {name}")
        sys.exit(1)
    print("✓ 迁移历史一致，可以部署")


def selftest():
    files = [Path("0001_init.sql"), Path("0002_x.sql")]
    drift, pending = compare(files, ["0001_init.sql", "ghost.sql"])
    assert drift == ["ghost.sql"], drift
    assert pending == ["0002_x.sql"], pending
    drift, pending = compare(files, ["0001_init.sql", "0002_x.sql"])
    assert drift == [] and pending == []
    # 文件名约定
    assert NAME_RE.match("0016_logs_billing_meta.sql")
    assert not NAME_RE.match("16_logs.sql") and not NAME_RE.match("000X_bad.sql")
    print("selftest OK")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    {"check": check, "selftest": selftest}.get(cmd, lambda: fail("用法：d1_guard.py check | selftest"))()
