#!/usr/bin/env bash
# Dry run of the whole backup + restore test on a LOCAL throw-away Postgres
# (no Supabase, no Backblaze, no real key). It:
#   1. starts a temporary local Postgres,
#   2. builds a stand-in "production" database the same way the security tests
#      do (Supabase roles, storage, the live tables, migrations 10-67) with
#      some rows and storage objects,
#   3. runs backup.sh with a throw-away age key into a local folder, 16 nights
#      in a row, to check the 14 / 8 / 6 retention,
#   4. runs restore-test.sh into a separate, empty "scratch" database,
#   5. checks that a restore into "production" or into a non-empty database is refused.
# Needs: postgres (initdb, pg_ctl), psql, pg_dump, pg_restore, age, node + the
# tests/ dependencies (for the fixture SQL). Run from the repo: bash backup/dry-run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
T="$(mktemp -d)"; PORT=${PORT:-55432}
# Postgres will not run as root: in a root shell (containers) the throw-away server runs as "nobody".
AS=(); if [ "$(id -u)" = 0 ]; then AS=(runuser -u nobody --); chmod 755 "$T"; mkdir -p "$T/pg"; chown nobody "$T/pg"; chown nobody "$T"; fi
cleanup(){ "${AS[@]}" "$PGBIN/pg_ctl" -D "$T/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
ok(){ echo "DRY RUN ok: $*"; }
die(){ echo "DRY RUN FAILED: $*"; exit 1; }

"${AS[@]}" "$PGBIN/initdb" -D "$T/pg" -U postgres --auth=trust >/dev/null
"${AS[@]}" "$PGBIN/pg_ctl" -D "$T/pg" -o "-p $PORT -k $T -c listen_addresses=''" -l "$T/pg/server.log" start >/dev/null
URL="postgresql://postgres@/postgres?host=$T&port=$PORT"
P(){ psql "$URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
P -c "create database prod" -c "create database scratch"
PROD="postgresql://postgres@/prod?host=$T&port=$PORT"; SCRATCH="postgresql://postgres@/scratch?host=$T&port=$PORT"

# 2. stand-in production: the security fixture's "today" schema + the migrations
( cd "$ROOT/tests" && node --input-type=module -e "import('./security/fixture.mjs').then(m=>process.stdout.write(m.TODAY))" ) > "$T/today.sql"
psql "$PROD" -X -q -v ON_ERROR_STOP=1 -f "$T/today.sql" >/dev/null
# the publication gate as production has it (as tests/security does), then the full chain
python3 - "$ROOT/supabase/security/50_publish_gate_statuses.rollback.sql" > "$T/gate.sql" <<'PY'
import sys; s=open(sys.argv[1]).read(); a=s.index('CREATE OR REPLACE FUNCTION'); b=s.rindex('$function$;')+len('$function$;'); print(s[a:b])
PY
psql "$PROD" -X -q -v ON_ERROR_STOP=1 -c 'drop function public.publish_surge_route(jsonb)' -f "$T/gate.sql" >/dev/null
for f in 10_sessions_and_rpcs 20_lockdown 50_publish_gate_statuses 60_pathiq_staging_reset 61_staging_release_gaps \
         62_gate_ignore_archived 63_jobs_exclude_archived 64_driver_hide_archived 65_bins_self_heal 67_driver_staging_spot; do
  [ -f "$ROOT/supabase/security/$f.sql" ] || continue
  psql "$PROD" -X -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/security/$f.sql" >/dev/null 2>"$T/mig.err" || { cat "$T/mig.err"; die "migration $f"; }
done
psql "$PROD" -X -q -v ON_ERROR_STOP=1 <<'SQL'
insert into public.organizations (id, name, slug) values ('11111111-1111-4111-8111-111111111111', 'Quick Haul', 'quickhaul') on conflict do nothing;
insert into public.drivers (name, phone, status, org_id) select 'Driver '||g, '40455500'||lpad(g::text,2,'0'), 'active', '11111111-1111-4111-8111-111111111111' from generate_series(1,7) g;
insert into public.jobs (org_id, title, status, job_type, surge_stops)
  select '11111111-1111-4111-8111-111111111111', 'Route '||g, 'pending', 'surge', '[]'::jsonb from generate_series(1,25) g;
insert into public.messages (job_id, sender, body) select id, 'Dispatch', 'hello' from public.jobs;
insert into storage.objects (bucket_id, name) select 'pod', 'job-'||g||'/p.jpg' from generate_series(1,12) g;
SQL
ok "stand-in production built ($(psql "$PROD" -X -q -At -c "select count(*) from pg_tables where schemaname in ('public','tp_sec')") tables)"

# 3. backups with a throw-away key, 16 nights (2026-09-26 .. 2026-10-11)
age-keygen -o "$T/test-key.txt" 2>/dev/null; grep -o 'age1.*' "$T/test-key.txt" > "$T/recipients.txt"
git -C "$ROOT" rev-parse --git-dir >/dev/null && REPO1="$ROOT" || die "not a git repo"
# older weekly / monthly sets, so the 8 weekly / 6 monthly limits are reached
for w in 2026-07-05 2026-07-12 2026-07-19 2026-07-26 2026-08-02 2026-08-09 2026-08-16 2026-08-23; do mkdir -p "$T/dest/weekly/$w"; done
for m in 2026-03-01 2026-04-01 2026-05-01 2026-06-01 2026-07-01 2026-08-01 2026-09-01; do mkdir -p "$T/dest/monthly/$m"; done
for d in $(seq 0 15); do
  day=$(date -u -d "2026-09-26 +$d day" +%F)
  SUPABASE_DB_URL="$PROD" BACKUP_DEST_DIR="$T/dest" AGE_RECIPIENTS_FILE="$T/recipients.txt" BACKUP_DATE="$day" REPOS="$REPO1" \
    bash "$ROOT/backup/backup.sh" > "$T/backup-$day.log" 2>&1 || { cat "$T/backup-$day.log"; die "backup $day"; }
done
tail -8 "$T/backup-2026-10-11.log"
[ "$(ls "$T/dest/daily" | wc -l)" = 14 ] || die "daily retention: $(ls "$T/dest/daily" | wc -l)"
[ "$(ls "$T/dest/daily" | head -1)" = 2026-09-28 ] || die "oldest daily kept: $(ls "$T/dest/daily" | head -1)"
[ "$(ls "$T/dest/weekly" | tr '\n' ' ')" = "2026-07-26 2026-08-02 2026-08-09 2026-08-16 2026-08-23 2026-09-27 2026-10-04 2026-10-11 " ] \
  || die "weekly: $(ls "$T/dest/weekly" | tr '\n' ' ')"
[ "$(ls "$T/dest/monthly" | tr '\n' ' ')" = "2026-05-01 2026-06-01 2026-07-01 2026-08-01 2026-09-01 2026-10-01 " ] || die "monthly: $(ls "$T/dest/monthly" | tr '\n' ' ')"
ok "retention: 14 daily (oldest 2026-09-28), 8 weekly (Sundays), 6 monthly (the 1st)"
if grep -rqa "Driver 1\|quickhaul\|job-1/p.jpg" "$T/dest"; then die "plain text found in the stored backup"; fi
ok "nothing readable in the stored files (all encrypted)"

# 4. restore into the empty scratch database
psql "$SCRATCH" -X -q -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" \
  -c "create schema extensions" -c "create extension pgcrypto schema extensions" 2>/dev/null || true   # what a new Supabase project has
( cd "$T" && SCRATCH_DB_URL="$SCRATCH" AGE_KEY_FILE="$T/test-key.txt" BACKUP_DIR="$T/dest" bash "$ROOT/backup/restore-test.sh" ) | tee "$T/restore.out"
grep -q "RESTORE TEST: PASS" "$T/restore.out" || die "restore test did not pass"
ok "restore test PASS"

# 5. refusals
if ( SCRATCH_DB_URL="postgresql://postgres@db.hofijsiphyjpdvujjzfi.supabase.co/postgres" AGE_KEY_FILE="$T/test-key.txt" BACKUP_DIR="$T/dest" bash "$ROOT/backup/restore-test.sh" ) > "$T/r1" 2>&1; then die "a restore into production was not refused"; fi
grep -q "PRODUCTION" "$T/r1" || die "wrong refusal: $(cat "$T/r1")"
if ( cd "$T" && SCRATCH_DB_URL="$SCRATCH" AGE_KEY_FILE="$T/test-key.txt" BACKUP_DIR="$T/dest" bash "$ROOT/backup/restore-test.sh" ) > "$T/r2" 2>&1; then die "a restore into a non-empty database was not refused"; fi
grep -q "already has" "$T/r2" || die "wrong refusal: $(cat "$T/r2")"
ok "refuses production and refuses a non-empty database"
if ( SUPABASE_DB_URL="$PROD" BACKUP_DEST_DIR="$T/x" BACKUP_DATE=2026-10-12 REPOS="$REPO1" AGE_RECIPIENTS_FILE="$ROOT/backup/age-recipients.txt" bash "$ROOT/backup/backup.sh" ) > "$T/r3" 2>&1; then
  grep -q '^age1' "$ROOT/backup/age-recipients.txt" || die "backup ran without a public key"
else grep -q "no age public key" "$T/r3" || die "wrong message: $(cat "$T/r3")"; ok "no public key yet: the backup stops and uploads nothing"; fi
echo "DRY RUN: ALL OK"
