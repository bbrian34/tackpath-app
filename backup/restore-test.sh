#!/usr/bin/env bash
# TackPath restore test. Restores the LATEST backup set into a SCRATCH
# Supabase project (never production) and checks it:
#   - every encrypted file matches the SHA-256 in MANIFEST.txt
#   - the dump decrypts with the offline private key and restores
#   - every table has exactly the row count recorded at backup time
#   - the gateway functions tp_org and tp_driver and the tables jobs and
#     bin_bindings exist
# Prints PASS or FAIL and how long it took, and writes restore-report-<date>.txt
# (no secrets in it). Run on the PC (WSL Ubuntu), see docs/backups-runbook.md.
#
#   SCRATCH_DB_URL   connection string of the SCRATCH project (asked for, hidden, if not set)
#   AGE_KEY_FILE     the private key file (on the USB stick), e.g. /mnt/e/tackpath-backup-key.txt
#   one of:
#     BACKUP_DIR     a local folder holding daily/<date>/ (downloaded, or the dry-run folder)
#     B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_ENDPOINT   read the latest set from Backblaze B2
#   optional: SET=daily/2026-10-11 to test a particular set
set -euo pipefail
umask 077
PROD_REF="hofijsiphyjpdvujjzfi"            # the production project: never restored into
START=$(date +%s)
fail(){ echo; echo "RESTORE TEST: FAIL - $*"; [ -n "${REPORT:-}" ] && echo "FAIL - $*" >> "$REPORT"; exit 1; }
log(){ echo "[$(date +%H:%M:%S)] $*"; [ -n "${REPORT:-}" ] && echo "$*" >> "$REPORT"; return 0; }

if [ -z "${SCRATCH_DB_URL:-}" ]; then read -r -s -p "Paste the SCRATCH project's connection string (hidden): " SCRATCH_DB_URL; echo; fi
[ -n "$SCRATCH_DB_URL" ] || fail "no scratch connection string"
case "$SCRATCH_DB_URL" in *"$PROD_REF"*) fail "that is the PRODUCTION project ($PROD_REF). Use the scratch project.";; esac
[ -n "${AGE_KEY_FILE:-}" ] && [ -f "$AGE_KEY_FILE" ] || fail "AGE_KEY_FILE does not point to the private key file"
for t in age pg_restore psql sha256sum; do command -v $t >/dev/null || fail "$t is not installed"; done

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
REPORT="$PWD/restore-report-$(date +%F).txt"; : > "$REPORT"

# 1. The scratch database must be empty of app tables (so nothing real is ever overwritten)
n=$(psql "$SCRATCH_DB_URL" -X -q -At -c "select count(*) from pg_tables where schemaname in ('public','tp_sec')") || fail "cannot connect to the scratch project"
[ "$n" = 0 ] || fail "the scratch database already has $n app tables. Use a fresh scratch project (or reset it in the Supabase dashboard)."

# 2. The latest set
if [ -n "${BACKUP_DIR:-}" ]; then
  SET="${SET:-daily/$(ls -1 "$BACKUP_DIR/daily" | sort | tail -1)}"
  [ -f "$BACKUP_DIR/$SET/MANIFEST.txt" ] || fail "no backup set at $BACKUP_DIR/$SET"
  cp "$BACKUP_DIR/$SET"/* "$WORK/"
else
  for v in B2_KEY_ID B2_APP_KEY B2_BUCKET B2_ENDPOINT; do [ -n "${!v:-}" ] || fail "$v is not set (or set BACKUP_DIR)"; done
  export AWS_ACCESS_KEY_ID="$B2_KEY_ID" AWS_SECRET_ACCESS_KEY="$B2_APP_KEY" AWS_DEFAULT_REGION="${B2_REGION:-$(echo "$B2_ENDPOINT" | sed -n 's#.*s3\.\([a-z0-9-]*\)\.backblazeb2\.com.*#\1#p')}"
  S3=(aws --only-show-errors --endpoint-url "$B2_ENDPOINT" s3)
  SET="${SET:-daily/$("${S3[@]}" ls "s3://$B2_BUCKET/daily/" | awk '/PRE/{print $2}' | tr -d / | sort | tail -1)}"
  "${S3[@]}" cp --recursive "s3://$B2_BUCKET/$SET/" "$WORK/" || fail "download of $SET failed"
fi
log "backup set: $SET"
head -2 "$WORK/MANIFEST.txt" | sed 's/^/  /'

# 3. Checksums
while read -r f _ _ _ sum; do
  [ -f "$WORK/$f" ] || fail "$f is missing"
  [ "$(sha256sum "$WORK/$f" | cut -d' ' -f1)" = "$sum" ] || fail "$f does not match its checksum"
done < <(grep '\.age ' "$WORK/MANIFEST.txt")
log "checksums: OK ($(grep -c '\.age ' "$WORK/MANIFEST.txt") files)"

# 4. Decrypt (the private key never leaves this PC)
for f in db.dump rowcounts.tsv; do age -d -i "$AGE_KEY_FILE" -o "$WORK/$f" "$WORK/$f.age" || fail "cannot decrypt $f (wrong key?)"; done
log "decrypted with the offline key"

# 5. Restore
log "restoring (this takes a few minutes)"
pg_restore --no-owner --dbname="$SCRATCH_DB_URL" "$WORK/db.dump" > "$WORK/restore.log" 2>&1 || true
ERR=$(grep -c '^pg_restore: error' "$WORK/restore.log" || true)
OTHER=$(grep '^pg_restore: error' "$WORK/restore.log" | grep -vc 'already exists' || true)
log "restore finished: $ERR errors ($OTHER other than 'already exists')"
grep '^pg_restore: error' "$WORK/restore.log" | grep -v 'already exists' | head -20 | sed 's/^/  /' | tee -a "$REPORT" || true

# 6. Verification query set
BAD=0
while IFS=$'\t' read -r tbl want; do
  got=$(psql "$SCRATCH_DB_URL" -X -q -At -c "select count(*) from ${tbl%%.*}.\"${tbl#*.}\"" 2>/dev/null || echo missing)
  if [ "$got" = "$want" ]; then echo "  ok    $tbl  $got rows" >> "$REPORT"; else echo "  FAIL  $tbl  expected $want, got $got" | tee -a "$REPORT"; BAD=$((BAD+1)); fi
done < "$WORK/rowcounts.tsv"
log "row counts: $(( $(wc -l < "$WORK/rowcounts.tsv") - BAD )) of $(wc -l < "$WORK/rowcounts.tsv") tables match"
for chk in "function public.tp_org|select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tp_org'" \
           "function public.tp_driver|select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='tp_driver'" \
           "table public.jobs|select count(*) from pg_tables where schemaname='public' and tablename='jobs'" \
           "table public.bin_bindings|select count(*) from pg_tables where schemaname='public' and tablename='bin_bindings'"; do
  name="${chk%%|*}"; got=$(psql "$SCRATCH_DB_URL" -X -q -At -c "${chk#*|}" 2>/dev/null || echo 0)
  if [ "${got:-0}" -ge 1 ] 2>/dev/null; then log "  ok    $name exists"; else log "  FAIL  $name is missing"; BAD=$((BAD+1)); fi
done

SECS=$(( $(date +%s) - START ))
[ "$BAD" = 0 ] && [ "$OTHER" = 0 ] || fail "$BAD check(s) failed, $OTHER restore error(s); see $REPORT (took ${SECS}s)"
log "took ${SECS}s"
echo; echo "RESTORE TEST: PASS ($SET restored and verified in ${SECS}s). Report: $REPORT"
echo "PASS" >> "$REPORT"
