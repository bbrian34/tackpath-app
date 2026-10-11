#!/usr/bin/env bash
# TackPath nightly backup. Read-only against the database: pg_dump runs in a
# single READ ONLY transaction, and the other two reads are plain SELECTs.
#
# Makes one backup set, encrypts every file to the age public key(s) in
# backup/age-recipients.txt, and stores the set outside Supabase:
#   daily/<YYYY-MM-DD>/    every night       (keep 14)
#   weekly/<YYYY-MM-DD>/   Sundays (UTC)     (keep 8)
#   monthly/<YYYY-MM-DD>/  the 1st (UTC)     (keep 6)
# Each set holds:
#   db.dump.age              pg_dump (custom format) of every app schema, with
#                            functions, triggers, policies and grants
#   rowcounts.tsv.age        exact row count per table (the restore test checks them)
#   storage-objects.csv.age  every file in every storage bucket (bucket, path, size, updated)
#   tackpath-app.bundle.age, tackpath-driver.bundle.age   git bundles (all branches and tags)
#   MANIFEST.txt             file names, sizes and SHA-256 of the ENCRYPTED files (no data)
#
# Environment (GitHub Actions secrets; never printed, never written to disk):
#   SUPABASE_DB_URL   Postgres connection string (Session pooler, port 5432)
#   B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT   Backblaze B2 (S3-compatible)
#   MIRROR_TOKEN      read-only GitHub token for the two repos (optional for public repos)
# Dry run: set BACKUP_DEST_DIR=/some/local/dir instead of the B2_* variables.
# Optional: BACKUP_DATE=YYYY-MM-DD (tests), REPOS="owner/repo ...".
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECIPIENTS="${AGE_RECIPIENTS_FILE:-$HERE/age-recipients.txt}"   # the dry run passes a test key
REPOS="${REPOS:-bbrian34/tackpath-app bbrian34/tackpath-driver}"
DAY="${BACKUP_DATE:-$(date -u +%F)}"
KEEP_DAILY=14 KEEP_WEEKLY=8 KEEP_MONTHLY=6

fail(){ echo "BACKUP FAILED: $*" >&2; exit 1; }
log(){ echo "[$(date -u +%H:%M:%S)] $*"; }

[ -n "${SUPABASE_DB_URL:-}" ] || fail "SUPABASE_DB_URL is not set (GitHub secret)"
grep -q '^age1' "$RECIPIENTS" 2>/dev/null || fail "no age public key in backup/age-recipients.txt (see docs/backups-runbook.md, step 2)"
command -v age >/dev/null || fail "age is not installed"
if [ -z "${BACKUP_DEST_DIR:-}" ]; then
  for v in B2_KEY_ID B2_APP_KEY B2_BUCKET B2_ENDPOINT; do [ -n "${!v:-}" ] || fail "$v is not set (GitHub secret)"; done
  command -v aws >/dev/null || fail "aws CLI is not installed"
fi

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/set"; mkdir -p "$OUT"
enc(){ age -R "$RECIPIENTS" -o "$OUT/$2.age" "$1" && rm -f "$1"; }
export PGCONNECT_TIMEOUT=20 PGAPPNAME=tackpath-backup

# 1. Which schemas: every schema the app created. Supabase's own schemas are
#    left out (the scratch project brings its own); the storage FILE LIST is
#    taken separately below. Private schemas such as tp_sec are included.
SKIP="'information_schema','auth','storage','realtime','_realtime','extensions','graphql','graphql_public','pgbouncer','pgsodium','pgsodium_masks','vault','supabase_functions','supabase_migrations','net','cron','_analytics','pgtle','topology','tiger','tiger_data'"
SCHEMAS="$(psql "$SUPABASE_DB_URL" -X -q -At -v ON_ERROR_STOP=1 -c "select nspname from pg_namespace where nspname not like 'pg\_%' and nspname not in ($SKIP) order by 1")" \
  || fail "could not connect to the database"
[ -n "$SCHEMAS" ] || fail "no schemas found"
log "schemas: $(echo $SCHEMAS)"
NS=(); for s in $SCHEMAS; do NS+=(-n "$s"); done

# 2. The database dump (read-only transaction; functions, triggers, RLS, grants)
log "dumping database"
pg_dump "$SUPABASE_DB_URL" --format=custom --compress=9 --no-owner --quote-all-identifiers "${NS[@]}" -f "$WORK/db.dump" \
  || fail "pg_dump failed"
pg_restore --list "$WORK/db.dump" > /dev/null || fail "the dump cannot be read back"
log "dump: $(du -h "$WORK/db.dump" | cut -f1)"
enc "$WORK/db.dump" db.dump

# 3. Exact row count per table, read in one read-only transaction
log "counting rows"
psql "$SUPABASE_DB_URL" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 > "$WORK/rowcounts.tsv" <<SQL || fail "row counts failed"
begin transaction isolation level repeatable read read only;
select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r','p') and n.nspname not like 'pg\_%' and n.nspname not in ($SKIP)
 order by 1;
commit;
SQL
log "tables: $(wc -l < "$WORK/rowcounts.tsv")"
enc "$WORK/rowcounts.tsv" rowcounts.tsv

# 4. The storage file list (metadata only; the files themselves stay in Supabase Storage)
log "listing storage files"
if [ "$(psql "$SUPABASE_DB_URL" -X -q -At -c "select to_regclass('storage.objects') is not null")" = t ]; then
  psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "\copy (select bucket_id, name, coalesce((metadata->>'size')::bigint, 0) as size, updated_at from storage.objects order by bucket_id, name) to '$WORK/storage-objects.csv' with csv header" 2>/dev/null \
    || psql "$SUPABASE_DB_URL" -X -q -v ON_ERROR_STOP=1 -c "\copy (select bucket_id, name from storage.objects order by bucket_id, name) to '$WORK/storage-objects.csv' with csv header" \
    || fail "storage file list failed"
else
  echo "bucket_id,name" > "$WORK/storage-objects.csv"
fi
log "storage files: $(( $(wc -l < "$WORK/storage-objects.csv") - 1 ))"
enc "$WORK/storage-objects.csv" storage-objects.csv

# 5. Code mirror: a git bundle of each repo (every branch and tag)
for repo in $REPOS; do
  name="${repo##*/}"; log "mirroring $repo"
  if [ -d "$repo/.git" ] || [ -d "$repo/objects" ]; then src="$repo"          # a local repo (dry run)
  else src="https://github.com/$repo.git"; fi
  if [ -n "${MIRROR_TOKEN:-}" ] && [ "${src#https://}" != "$src" ]; then
    git -c credential.helper= -c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$MIRROR_TOKEN" | base64 -w0)" \
      clone --quiet --mirror "$src" "$WORK/$name.git" || fail "could not mirror $repo"
  else
    git clone --quiet --mirror "$src" "$WORK/$name.git" || fail "could not mirror $repo"
  fi
  git -C "$WORK/$name.git" bundle create --quiet "$WORK/$name.bundle" --all || fail "bundle $repo"
  rm -rf "$WORK/$name.git"
  enc "$WORK/$name.bundle" "$name.bundle"
done

# 6. Manifest (encrypted files only: sizes and checksums, no data)
( cd "$OUT"; { echo "TackPath backup $DAY (UTC)"; echo "schemas: $(echo $SCHEMAS)";
  for f in *.age; do printf '%s  %s bytes  sha256 %s\n' "$f" "$(stat -c %s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"; done; } > MANIFEST.txt )

# 7. Store the set and keep 14 daily / 8 weekly / 6 monthly
TIERS="daily"
[ "$(date -u -d "$DAY" +%u)" = 7 ] && TIERS="$TIERS weekly"
[ "$(date -u -d "$DAY" +%d)" = 01 ] && TIERS="$TIERS monthly"
keep(){ case "$1" in daily) echo $KEEP_DAILY;; weekly) echo $KEEP_WEEKLY;; monthly) echo $KEEP_MONTHLY;; esac; }

if [ -n "${BACKUP_DEST_DIR:-}" ]; then
  for t in $TIERS; do mkdir -p "$BACKUP_DEST_DIR/$t/$DAY"; cp "$OUT"/* "$BACKUP_DEST_DIR/$t/$DAY/"; log "stored $t/$DAY"; done
  for t in daily weekly monthly; do
    [ -d "$BACKUP_DEST_DIR/$t" ] || continue
    ls -1 "$BACKUP_DEST_DIR/$t" | sort -r | tail -n +"$(( $(keep $t) + 1 ))" | while read -r old; do rm -rf "$BACKUP_DEST_DIR/$t/$old"; log "pruned $t/$old"; done
  done
else
  export AWS_ACCESS_KEY_ID="$B2_KEY_ID" AWS_SECRET_ACCESS_KEY="$B2_APP_KEY" AWS_DEFAULT_REGION="${B2_REGION:-$(echo "$B2_ENDPOINT" | sed -n 's#.*s3\.\([a-z0-9-]*\)\.backblazeb2\.com.*#\1#p')}" AWS_EC2_METADATA_DISABLED=true
  S3=(aws --only-show-errors --endpoint-url "$B2_ENDPOINT" s3)
  for t in $TIERS; do "${S3[@]}" cp --recursive "$OUT/" "s3://$B2_BUCKET/$t/$DAY/" || fail "upload $t/$DAY"; log "stored $t/$DAY"; done
  # read back: every file of today's daily set is there with the right size
  for f in "$OUT"/*; do
    got="$("${S3[@]}" ls "s3://$B2_BUCKET/daily/$DAY/$(basename "$f")" | awk '{print $3}')"
    [ "$got" = "$(stat -c %s "$f")" ] || fail "uploaded $(basename "$f") does not match (got '${got}')"
  done
  for t in daily weekly monthly; do
    "${S3[@]}" ls "s3://$B2_BUCKET/$t/" 2>/dev/null | awk '/PRE/{print $2}' | tr -d / | sort -r | tail -n +"$(( $(keep $t) + 1 ))" \
      | while read -r old; do "${S3[@]}" rm --recursive "s3://$B2_BUCKET/$t/$old/" && log "pruned $t/$old"; done
  done
fi
log "BACKUP OK: $DAY ($TIERS)"
cat "$OUT/MANIFEST.txt"
