#!/usr/bin/env bash
# Verifies the SQL that makes balance changes concurrency-safe, against a real
# (local) D1. The guarded UPDATE in src/lib/ledger.ts is the single mechanism
# preventing two simultaneous requests from both spending the same balance —
# if this ever regresses, balances can go negative.
#
# Usage: npm run test:d1
set -euo pipefail
cd "$(dirname "$0")/.."

d1() { npx wrangler d1 execute oneapi --local -y --json --command "$1" 2>/dev/null; }
rows() { python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)[0]['results']))"; }

fail=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok  $1"; else echo "FAIL  $1"; echo "      expected $2, got $3"; fail=1; fi
}

npx wrangler d1 execute oneapi --local -y --file=./migrations/0001_init.sql >/dev/null 2>&1
npx wrangler d1 execute oneapi --local -y --file=./migrations/0002_credits_ledger.sql >/dev/null 2>&1
npx wrangler d1 execute oneapi --local -y --file=./migrations/0006_billing_windows.sql >/dev/null 2>&1
npx wrangler d1 execute oneapi --local -y --file=./migrations/0010_allowances.sql >/dev/null 2>&1
npx wrangler d1 execute oneapi --local -y --file=./migrations/0011_allowance_anchor.sql >/dev/null 2>&1
d1 "DELETE FROM users WHERE username='__guard_test__'" >/dev/null
d1 "INSERT INTO users (username,password,quota) VALUES ('__guard_test__','x',100)" >/dev/null
UID_=$(d1 "SELECT id FROM users WHERE username='__guard_test__'" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['id'])")

GUARD="UPDATE users SET quota = quota + ?D WHERE id = $UID_ AND quota + ?D >= 0 RETURNING quota"
guarded() { d1 "${GUARD//\?D/$1}" | rows; }

check "debit within balance succeeds"        '[{"quota": 40}]' "$(guarded -60)"
check "debit beyond balance matches no rows" '[]'              "$(guarded -60)"
check "debit to exactly zero succeeds"       '[{"quota": 0}]'  "$(guarded -40)"
check "credit is never blocked"              '[{"quota": 25}]' "$(guarded +25)"
# Settlement runs unguarded: the response was already delivered, so the charge
# must land even when it overdraws.
check "unguarded settlement may overdraw"    '[{"quota": -5}]' \
      "$(d1 "UPDATE users SET quota = quota + -30 WHERE id = $UID_ RETURNING quota" | rows)"

# ---------------------------------------------------------------------------
# 固定计费单元的授权规则。
#
# 规则：余额 > 0 时最多预留 ceil(余额 / WINDOW) 个整窗，一次要 k 个就写成
# `quota > (k-1)*WINDOW`。这一条 SQL 就是规则本身——没有先读后写，也就没有脏读。
# 拿 WINDOW=8 验边界，和需求里给的例子一一对应。
#
# 整段写成一个文件跑一次：每 spawn 一次 wrangler 要好几秒，逐条发会让这个测试变成
# 没人愿意跑的那种。
# ---------------------------------------------------------------------------
SEQ=$(mktemp -t d1seq).sql
cat > "$SEQ" <<EOF
UPDATE users SET quota = 12 WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = 9  WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = 8  WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = 7  WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = 0  WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = -3 WHERE id = $UID_;
UPDATE users SET quota = quota - 8  WHERE id = $UID_ AND quota > 0  RETURNING quota;
UPDATE users SET quota = 12 WHERE id = $UID_;
UPDATE users SET quota = quota - 16 WHERE id = $UID_ AND quota > 8  RETURNING quota;
UPDATE users SET quota = 8  WHERE id = $UID_;
UPDATE users SET quota = quota - 16 WHERE id = $UID_ AND quota > 8  RETURNING quota;
UPDATE users SET quota = 17 WHERE id = $UID_;
UPDATE users SET quota = quota - 24 WHERE id = $UID_ AND quota > 16 RETURNING quota;
EOF
SEQ_OUT=$(npx wrangler d1 execute oneapi --local -y --json --file="$SEQ" 2>/dev/null)
rm -f "$SEQ"
at() { printf '%s' "$SEQ_OUT" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)[$1]['results']))"; }

check "余额 12：第一个 8 发得出"          '[{"quota": 4}]'  "$(at 1)"
check "余额 12：第二个 8 也发得出"        '[{"quota": -4}]' "$(at 2)"
check "透支之后再也发不出"                '[]'             "$(at 3)"
check "余额 9：发得出第一个"              '[{"quota": 1}]'  "$(at 5)"
check "余额 9：第二个把它打到 -7"         '[{"quota": -7}]' "$(at 6)"
check "余额 8：只发得出一个"              '[{"quota": 0}]'  "$(at 8)"
check "余额 8：第二个发不出"              '[]'             "$(at 9)"
check "余额 7：只发得出一个（透支 1）"    '[{"quota": -1}]' "$(at 11)"
check "余额 7：第二个发不出"              '[]'             "$(at 12)"
check "余额 0：一个都发不出"              '[]'             "$(at 14)"
check "余额为负：一个都发不出"            '[]'             "$(at 16)"
# 一次要 k 个整窗是"连续贪心 k 次"的等价形式，边界必须一致。
check "余额 12：一次要两个整窗，成"       '[{"quota": -4}]' "$(at 18)"
check "余额 8：一次要两个整窗，不成"      '[]'             "$(at 20)"
check "余额 17：一次要三个整窗，成"       '[{"quota": -7}]' "$(at 22)"
# 每一条"发得出"之后的余额都 > -8：透支恒小于一个 WINDOW。

# ---------------------------------------------------------------------------
# batch 是不是一个事务。
#
# applyCreditGated() 把「抢状态、记账、动钱」放进一个 batch，中间态存不存在全看这个。
# 类型声明里对它只字未提，所以这里实测：一个文件里的多条语句由 wrangler 当作一批发出去，
# 故意让第二条撞唯一索引，看第一条的效果还在不在。
# ---------------------------------------------------------------------------
d1 "DELETE FROM users WHERE username='__batch_probe__'" >/dev/null
d1 "INSERT INTO users (username,password,quota) VALUES ('__batch_probe__','x',100)" >/dev/null
PID_=$(d1 "SELECT id FROM users WHERE username='__batch_probe__'" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['id'])")
d1 "INSERT INTO credits (user_id,delta,reason,ref,balance_after,created_at) VALUES ($PID_,1,'adjust','__probe_ref__',0,0)" >/dev/null

PROBE=$(mktemp -t d1probe).sql
cat > "$PROBE" <<EOF
UPDATE users SET quota = quota - 50 WHERE id = $PID_;
INSERT INTO credits (user_id,delta,reason,ref,balance_after,created_at) VALUES ($PID_,1,'adjust','__probe_ref__',0,0);
EOF
npx wrangler d1 execute oneapi --local -y --file="$PROBE" >/dev/null 2>&1 || true
rm -f "$PROBE"
AFTER=$(d1 "SELECT quota FROM users WHERE id = $PID_" | rows)
if [ "$AFTER" = '[{"quota": 100}]' ]; then
  echo "  ok  batch 失败时前面的语句被回滚（原子）"
else
  echo "NOTE  batch 不是原子的：失败前的语句已落地（quota=$AFTER）"
  echo "      设计对此有准备——语句顺序保证任何前缀提交都不写坏账，剩下的由"
  echo "      repairSettlements() 补完。生产结论请用 GET /api/diagnostics/d1-batch 复核。"
fi
d1 "DELETE FROM credits WHERE ref='__probe_ref__'" >/dev/null
d1 "DELETE FROM users WHERE username='__batch_probe__'" >/dev/null

# ---------------------------------------------------------------------------
# 授权窗口的状态推进。
#
# 这些 CAS 是本方案里唯一的序列化器：结算和回收器可能同时看上同一个窗口，谁先把
# status 改掉谁才有资格动钱。credits.ref 挡不住这个——它是 check-then-act，两个
# 并发的相同 ref 会双双移动余额，只有第二条 INSERT 撞唯一索引。
# ---------------------------------------------------------------------------
W=__win_test__
d1 "DELETE FROM billing_windows WHERE id LIKE '${W}%'" >/dev/null
d1 "INSERT INTO billing_windows (id,user_id,status,authorized_quota,expires_at) VALUES ('$W',$UID_,'active',2500,1)" >/dev/null

# CAS 命不命中看 RETURNING 回没回行——和上面那条守门 UPDATE 是同一个判据。
# meta 里有哪些字段是驱动的实现细节（wrangler CLI 就不给 changes），不能靠它。
cas() { d1 "UPDATE billing_windows SET status='$2' WHERE id='$W' AND status='$1' RETURNING id" | rows; }

HIT='[{"id": "__win_test__"}]'
check "回收器 CAS 只能命中一次"          "$HIT" "$(cas active expired)"
check "第二次回收匹配零行（不会退两次款）" '[]'    "$(cas active expired)"
check "迟到的结算能从 expired 接手"      "$HIT" "$(cas expired settled)"
check "结算过的窗口谁也接不走"            '[]'    "$(cas active settled)"

# 一个前驱只能有一个后继：settle_and_authorize 重试时靠它保证不会开出第二个窗口。
d1 "INSERT INTO billing_windows (id,user_id,status,prev_window_id) VALUES ('${W}_b',$UID_,'active','$W')" >/dev/null
DUP=$(d1 "INSERT INTO billing_windows (id,user_id,status,prev_window_id) VALUES ('${W}_c',$UID_,'active','$W')" 2>&1 || true)
case "$DUP" in *UNIQUE*|*constraint*) echo "  ok  一个前驱只能挂一个后继";; *) echo "FAIL  一个前驱只能挂一个后继"; echo "      期望唯一索引报错，实际：$DUP"; fail=1;; esac

# 退款的幂等靠 credits.ref 上那条部分唯一索引兜底（不是序列化器，是审计兜底）。
d1 "INSERT INTO credits (user_id,delta,reason,ref,balance_after,created_at) VALUES ($UID_,2500,'refund','win:$W:expire',0,0)" >/dev/null
DUP=$(d1 "INSERT INTO credits (user_id,delta,reason,ref,balance_after,created_at) VALUES ($UID_,2500,'refund','win:$W:expire',0,0)" 2>&1 || true)
case "$DUP" in *UNIQUE*|*constraint*) echo "  ok  同一个窗口不能退两次款";; *) echo "FAIL  同一个窗口不能退两次款"; echo "      期望唯一索引报错，实际：$DUP"; fail=1;; esac

# ---------------------------------------------------------------------------
# 订阅赠额：发放的幂等、锚点的固化、支取的 CAS。
#
# 这三条在假 D1 上是验不了的——它们全都依赖真实 SQLite 的行为：唯一索引报错、
# 条件 UPDATE 的匹配行数、ON CONFLICT DO NOTHING 配合 RETURNING 的返回。
# 错了不会有任何症状，只会让某些用户每次同步都多拿一份 $3。

PS=1700000000
grant() { d1 "INSERT INTO allowances (user_id,source,period_start,period_end,granted,consumed,created_at)
              VALUES ($UID_,'legacy-subscription',$1,$(($1+2592000)),1500000,0,0)
              ON CONFLICT (user_id, source, period_start) DO NOTHING RETURNING id" | rows; }

FIRST=$(grant $PS)
case "$FIRST" in '[{"id":'*) echo "  ok  首次发放：真的插进去了";; *) echo "FAIL  首次发放"; echo "      实际：$FIRST"; fail=1;; esac
check "同一期重复发放：一行都不插（重复同步不重复发）" '[]' "$(grant $PS)"
check "下一期是另一行，照常发得出来" '1' \
      "$(d1 "SELECT count(*) AS c FROM allowances WHERE user_id=$UID_ AND period_start=$((PS+2592000))" >/dev/null; grant $((PS+2592000)) >/dev/null; d1 "SELECT count(*) AS c FROM allowances WHERE user_id=$UID_ AND period_start=$((PS+2592000))" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['c'])")"

# 支取带 CAS：读到的 consumed 被人改过就必须匹配零行，否则两条并发的流会各扣各的。
AID=$(d1 "SELECT id FROM allowances WHERE user_id=$UID_ AND period_start=$PS" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['id'])")
draw() { d1 "UPDATE allowances SET consumed = consumed + $1 WHERE id = $AID AND consumed = $2 RETURNING consumed" | rows; }
check "支取：CAS 前置值对得上就成功"        '[{"consumed": 8000}]' "$(draw 8000 0)"
check "支取：拿过时的前置值去写匹配零行"      '[]'                   "$(draw 8000 0)"
check "退款只减不越界"                      '[{"consumed": 0}]'    "$(d1 "UPDATE allowances SET consumed = MAX(0, consumed - 99999) WHERE id = $AID RETURNING consumed" | rows)"

# 锚点：首次落一个值，之后那条带 `= 0` 条件的 UPDATE 必须再也命中不了。
d1 "UPDATE users SET allowance_anchor_at = 0 WHERE id = $UID_" >/dev/null
setanchor() { d1 "UPDATE users SET allowance_anchor_at = $1 WHERE id = $UID_ AND allowance_anchor_at = 0 RETURNING allowance_anchor_at" | rows; }
check "首次进会员：锚点落下"                '[{"allowance_anchor_at": 111}]' "$(setanchor 111)"
check "续费再来一次：匹配零行（锚点不动）"    '[]'                             "$(setanchor 222)"
check "锚点确实还是第一次那个值"            '[{"allowance_anchor_at": 111}]' \
      "$(d1 "SELECT allowance_anchor_at FROM users WHERE id = $UID_" | rows)"
check "中断清零之后可以重新设锚"            '[{"allowance_anchor_at": 333}]' \
      "$(d1 "UPDATE users SET allowance_anchor_at = 0 WHERE id = $UID_" >/dev/null; setanchor 333)"

d1 "DELETE FROM allowances WHERE user_id=$UID_" >/dev/null
d1 "DELETE FROM credits WHERE ref LIKE 'win:${W}%'" >/dev/null
d1 "DELETE FROM billing_windows WHERE id LIKE '${W}%'" >/dev/null
d1 "DELETE FROM users WHERE username='__guard_test__'" >/dev/null
[ "$fail" = 0 ] && echo "
D1 guard semantics: all passed" || { echo "
D1 guard semantics: FAILURES"; exit 1; }
