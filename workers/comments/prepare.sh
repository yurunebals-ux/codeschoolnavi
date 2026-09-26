#!/usr/bin/env bash
# Cloudflare 側の準備（comments-worker / comments-admin の両方から呼ぶ）。2026-09-26
#  1. workers.dev のサブドメインが無ければ作る（codeschoolnavi → だめなら csn-<ランダム>）
#  2. D1 データベース csn-comments が無ければ作る
#  3. wrangler.template.toml から wrangler.toml を作る（database_id を埋める）
# 必要な環境変数: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
# 出力: $GITHUB_OUTPUT に subdomain= と db_id=
set -euo pipefail
cd "$(dirname "$0")"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}"
AUTH=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const v=(new Function("j","return "+process.argv[1]))(j);process.stdout.write(v==null?"":String(v))}catch(e){}})' "$1"; }

# 1. サブドメイン
SUB=$(curl -sS "${AUTH[@]}" "$API/workers/subdomain" | jget 'j.result && j.result.subdomain')
if [ -z "$SUB" ]; then
  for cand in codeschoolnavi "csn-$(openssl rand -hex 3)"; do
    RES=$(curl -sS -X PUT "${AUTH[@]}" "$API/workers/subdomain" --data "{\"subdomain\":\"$cand\"}")
    SUB=$(echo "$RES" | jget 'j.success ? j.result.subdomain : ""')
    [ -n "$SUB" ] && break
    echo "サブドメイン $cand は使えませんでした: $(echo "$RES" | jget 'JSON.stringify(j.errors)')"
  done
fi
[ -n "$SUB" ] || { echo "::error::workers.dev のサブドメインを用意できませんでした。Cloudflare の Workers & Pages を一度開いてください"; exit 1; }
echo "workers.dev サブドメイン: $SUB"

# 2. D1
DB_ID=$(curl -sS "${AUTH[@]}" "$API/d1/database?name=csn-comments" | jget '(j.result||[]).filter(d=>d.name==="csn-comments").map(d=>d.uuid)[0]')
if [ -z "$DB_ID" ]; then
  RES=$(curl -sS -X POST "${AUTH[@]}" "$API/d1/database" --data '{"name":"csn-comments"}')
  DB_ID=$(echo "$RES" | jget 'j.success ? j.result.uuid : ""')
  [ -n "$DB_ID" ] || { echo "::error::D1 を作れませんでした: $(echo "$RES" | jget 'JSON.stringify(j.errors)')（APIトークンに D1:Edit があるか確認）"; exit 1; }
  echo "D1 csn-comments を作成しました"
fi
echo "D1 id: $DB_ID"

# 3. wrangler.toml
sed "s/__DB_ID__/$DB_ID/" wrangler.template.toml > wrangler.toml

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "subdomain=$SUB" >> "$GITHUB_OUTPUT"
  echo "db_id=$DB_ID" >> "$GITHUB_OUTPUT"
fi
