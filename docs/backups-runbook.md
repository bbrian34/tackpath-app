# TackPath backups: setup, restore test, recovery

Every night at 07:17 UTC (3:17 am Eastern in summer), GitHub Actions makes one
encrypted backup set and stores it in **Backblaze B2**. B2 is a different
company from Supabase, so a Supabase outage, account problem or deleted
project cannot take the backups with it. Once a month, you restore the latest
set into a **scratch** Supabase project to prove the backups work.

| What | Where in the set |
|---|---|
| The database: every app schema (`public`, the private `tp_sec`, `operations`), with all tables, rows, functions (`tp_org`, `tp_driver`, the publication gate, …), triggers, row security and grants | `db.dump.age` |
| The exact row count of every table at backup time | `rowcounts.tsv.age` |
| The list of every file in every Storage bucket (bucket, path, size, date) | `storage-objects.csv.age` |
| A full code mirror of `tackpath-app` and `tackpath-driver` (all branches and tags) | `tackpath-app.bundle.age`, `tackpath-driver.bundle.age` |
| Sizes and SHA-256 checksums of the encrypted files (no data) | `MANIFEST.txt` |

**Retention:**
- `daily/` keeps the last 14 nights.
- `weekly/` keeps a copy every Sunday, the last 8.
- `monthly/` keeps a copy on the 1st, the last 6.

**Encryption:** every file is encrypted with [age](https://age-encryption.org)
to the public key in `backup/age-recipients.txt`. Only you hold the private
key, offline. Without it, nobody can read the backups: not GitHub, not
Backblaze, not Claude.

**Read-only:** the job only *reads* production. `pg_dump` runs in a single
read-only transaction, and the row count and file list are plain read-only
SELECTs.

**Not in the backup:**
- The *contents* of Storage files (the proof-of-delivery photos). Only their
  list is included.
- Supabase Auth users (TackPath does not use Supabase Auth).
- Edge-function secrets and project settings in the Supabase dashboard.

Write those settings down once, in your password manager.

---

## A. One-time setup (about 45 minutes, all on the PC)

Do the parts in order. Each secret goes **straight from where it is shown into
GitHub** (part A5). Never paste one into a chat, an email, a document or a
file.

### A1. Backblaze B2 account and bucket (PC, web browser)

1. On the PC, go to <https://www.backblaze.com/sign-up/cloud-storage> and
   create an account. No card is needed; the first 10 GB are free, and the
   backups use far less.
2. Sign in. In the left menu, click **B2 Cloud Storage → Buckets → Create a Bucket**.
3. Set:
   - Bucket name: `tackpath-backups-` plus a few random letters (bucket names
     are global), for example `tackpath-backups-k7q2`.
   - Files in bucket: **Private**.
   - Default encryption: **Enable**.
   - Object Lock: **Disable**.

   Click **Create a Bucket**.
4. On the new bucket's card, click **Lifecycle Settings** and choose **Keep
   only the last version of the file** → **Update Bucket**. Without this, B2
   keeps deleted copies and the 14/8/6 pruning would not free any space.
5. On the bucket's card, note the **Endpoint**, for example
   `s3.us-west-004.backblazeb2.com`. It is not a secret.
6. In the left menu, click **Application Keys → Add a New Application Key**:
   - Name: `tackpath-nightly-backup`.
   - Allow access to bucket: **only the new bucket**.
   - Type of access: **Read and Write**.
   - Leave the other options empty.

   Click **Create New Key**.
7. The page shows **keyID** and **applicationKey** once. Keep the page open
   and do A5 now. If you lose it, delete the key and make a new one.

### A2. The encryption key (PC, plus two USB sticks and a printer)

The private key is the only way to read the backups. Lose every copy and the
backups are useless; leak it and they are readable. Keep **two USB copies and
one paper copy**, never on the PC's disk and never online.

1. On the PC, open **PowerShell** (Start menu → type PowerShell → Enter) and
   install age:

   ```
   winget install --id FiloSottile.age
   ```

   Close and reopen PowerShell.
2. Plug in USB stick 1. In File Explorer, check its drive letter, for
   example `E:`.
3. Generate the key **directly onto the stick**:

   ```
   age-keygen -o E:\tackpath-backup-key.txt
   ```

   It prints `Public key: age1...`. Copy that `age1...` line; it is the
   public key and safe to share.
4. Plug in USB stick 2 and copy the file to it, for example
   `copy E:\tackpath-backup-key.txt F:\`.
5. Print the key file. Open `E:\tackpath-backup-key.txt` in Notepad, File →
   Print, and close Notepad **without saving anywhere else**. The important
   line starts with `AGE-SECRET-KEY-1`.
6. Store stick 1 and the paper in a locked drawer or safe at home, and stick 2
   somewhere else (for example a family member's house or a safe-deposit box).
   Label them "TackPath backup key — do not lose".
7. Add the public key to the repo. On the PC, in the browser, open
   <https://github.com/bbrian34/tackpath-app/blob/main/backup/age-recipients.txt>
   → pencil icon (Edit). On the last line, paste the `age1...` line, then
   **Commit changes**.

Never put the `AGE-SECRET-KEY` line in GitHub, a secret, an email, a chat or a
cloud drive.

### A3. The Supabase connection string (PC, web browser)

1. On the PC, open the Supabase dashboard → the **production** TackPath
   project → **Connect** (top of the page).
2. Choose **Session pooler**. GitHub's machines cannot reach the "Direct"
   address. Copy the URI. It looks like
   `postgresql://postgres.hofijsiphyjpdvujjzfi:[YOUR-PASSWORD]@aws-0-….pooler.supabase.com:5432/postgres`.
3. Replace `[YOUR-PASSWORD]` with the database password. That is the one set
   when the project was made, shown nowhere. If you don't know it: Project
   Settings → Database → **Reset database password**. The TackPath pages and
   edge functions do not use this password, so resetting it does not break
   them.
4. Keep the full string only long enough to paste it in A5.

### A4. Read-only GitHub token for the code mirror (PC, web browser)

1. On the PC: GitHub → your photo → **Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new token**.
2. Set:
   - Name: `tackpath-backup-mirror`.
   - Expiration: **1 year** (put a calendar reminder 11 months out).
   - Resource owner: `bbrian34`.
   - Repository access: **Only select repositories** → `tackpath-app` and
     `tackpath-driver`.
   - Permissions → Repository → **Contents: Read-only**. Nothing else.
3. **Generate token** and copy it. It is shown once.

### A5. Put the secrets into GitHub (PC, web browser)

1. On the PC, open <https://github.com/bbrian34/tackpath-app/settings/secrets/actions>.
2. Click **New repository secret** once for each row:

| Name | Value |
|---|---|
| `SUPABASE_DB_URL` | the full connection string from A3 |
| `B2_KEY_ID` | keyID from A1 step 7 |
| `B2_APP_KEY` | applicationKey from A1 step 7 |
| `B2_BUCKET` | the bucket name, e.g. `tackpath-backups-k7q2` |
| `B2_ENDPOINT` | `https://` + the endpoint from A1 step 5, e.g. `https://s3.us-west-004.backblazeb2.com` |
| `MIRROR_TOKEN` | the token from A4 |

3. Close the Backblaze key page and anything else that showed a secret.

GitHub hides secret values in the logs. The scripts never print them and
never write them to a file.

### A6. Failure alerts (PC, web browser)

A failed backup does two things:
- **GitHub's own email.** The failed run itself sends this, but only if
  notifications are on. Turn them on: GitHub → your photo → **Settings →
  Notifications → System → Actions**, tick **Email** and choose **Only notify
  for failed workflows**.
- **An issue.** The job opens an issue titled "Nightly backup FAILED - date".
  You are the repo owner, so GitHub emails you about it.

### A7. First run, then switch it on (PC, web browser)

1. On the PC, open <https://github.com/bbrian34/tackpath-app/actions> →
   **Nightly backup** → **Run workflow** → **Run workflow**.
2. Wait about 3–6 minutes for a green tick. Open the run: the last lines say
   `BACKUP OK` and list the files. If it is red, see *If something fails*.
3. In Backblaze → Buckets → **Browse Files**, you see
   `daily/<today>/` with 5 `.age` files and `MANIFEST.txt`.
4. Switch the nightly schedule on. Open
   <https://github.com/bbrian34/tackpath-app/settings/variables/actions> →
   **New repository variable**, name `BACKUP_ENABLED`, value `true`.

Until `BACKUP_ENABLED` is `true`, the schedule does nothing. A run starts only
from the button.

### A8. The scratch project for restore tests (PC, web browser)

1. On the PC, Supabase dashboard → **New project**. Name it
   `tackpath-restore-test`, the same organization, any region. Save its
   database password in your password manager. The free plan allows two
   projects.
2. This project is **only** for restore tests. Never point anything else at
   it. The restore script refuses to run against production
   (`hofijsiphyjpdvujjzfi`) and against any database that already holds app
   tables.

---

## B. Every night (automatic)

Nothing to do. If a night fails, you get the email and the issue. One failed
night is not urgent, since the previous 13 are still there. Fix it within a
few days.

GitHub pauses scheduled workflows in a repository with no commits for 60
days, and emails you before it does. If that happens: Actions → Nightly
backup → **Enable workflow**.

---

## C. One-time PC setup for restore tests (about 20 minutes)

The restore test runs on the PC in **Ubuntu on Windows (WSL)**, so the private
key never leaves your desk.

1. On the PC, open **PowerShell as administrator** (Start → PowerShell →
   right-click → Run as administrator) and run `wsl --install -d Ubuntu`.
   Restart the PC if asked, open **Ubuntu** from the Start menu, and choose a
   user name and password.
2. In the Ubuntu window, run these lines one at a time:

   ```
   sudo apt-get update && sudo apt-get install -y git age curl ca-certificates lsb-release
   sudo install -d /usr/share/postgresql-common/pgdg
   sudo curl -fsSo /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
   echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
   sudo apt-get update && sudo apt-get install -y postgresql-client-17
   git clone https://github.com/bbrian34/tackpath-app.git ~/tackpath-app
   ```

---

## D. Monthly restore test (about 30 minutes, PC)

On the 1st of each month, GitHub opens an issue "Monthly restore test - Month
Year". To run the test:

1. **Wake the scratch project** (PC, browser). Supabase → `tackpath-restore-test`.
   If it says *Paused*, click **Restore project** and wait for it. Free
   projects pause after a week unused.
2. **Download last night's set** (PC, browser). Backblaze → Buckets →
   **Browse Files** → `daily` → the newest date. Download all 6 files into
   `C:\tackpath-restore\daily\<that date>\`, keeping the date folder. They are
   encrypted, so the download is safe.
3. **Plug in USB key stick 1** (PC). Note its letter, for example `E:`.
4. **Get the scratch connection string** (PC, browser). Supabase →
   `tackpath-restore-test` → **Connect** → *Session pooler* → copy, and put in
   its password. Check that the string says `tackpath-restore-test`'s
   project, **not** `hofijsiphyjpdvujjzfi`.
5. **Run the test** (PC, Ubuntu window). Change `e` to your USB letter:

   ```
   cd ~/tackpath-app && git pull
   BACKUP_DIR=/mnt/c/tackpath-restore AGE_KEY_FILE=/mnt/e/tackpath-backup-key.txt bash backup/restore-test.sh
   ```

   Paste the scratch connection string when asked. It stays hidden.
6. It checks:
   - the checksums;
   - that the files decrypt with your key;
   - the restore itself;
   - every table's row count against the night's count;
   - that `tp_org`, `tp_driver`, `jobs` and `bin_bindings` exist.

   The last line is **RESTORE TEST: PASS** or **FAIL**, and it writes
   `restore-report-<date>.txt` (no secrets in it).
7. **Clean up:**
   - Unplug the USB stick and put it back.
   - Delete `C:\tackpath-restore`.
   - In Supabase, **delete** the scratch project (Settings → General → Delete
     project) and create a fresh `tackpath-restore-test` (A8) for next month.
     A fresh project is the simplest way to start empty.
8. Paste the last lines of the report into the reminder issue and close it.

**How long it takes:**
- On the PC: about 30 minutes, nearly all of it waking the project, the
  downloads and the cleanup.
- The script: under 2 minutes for today's database. The local dry run (25
  routes, 24 tables) restored and verified in about 1 second.
- The nightly job: about 3–6 minutes, mostly installing the Postgres client.

Write the real numbers from your first run here: ______.

---

## E. Real recovery (if production is lost)

1. Create a new Supabase project (A8, but name it for production).
2. Run part D against it, with `restore-test.sh` and that project's
   connection string. Because the new project is empty, the script restores
   into it and verifies it the same way.
3. In the Supabase dashboard, re-enter the settings from your password manager
   (edge function secrets, Storage buckets).
4. Point the pages at the new project: its URL and publishable key in the
   pages' `SB_URL` / `SB_KEY`, through a normal code change and PR.
5. Code, if GitHub were lost: decrypt a bundle and clone it:

   ```
   age -d -i /mnt/e/tackpath-backup-key.txt -o app.bundle tackpath-app.bundle.age
   git clone app.bundle tackpath-app
   ```

---

## If something fails

| Message | What to do |
|---|---|
| `no age public key in backup/age-recipients.txt` | Do A2 step 7. |
| `SUPABASE_DB_URL is not set` / `B2_… is not set` | Check the secret names in A5. They must match exactly. |
| `could not connect to the database` | Use the **Session pooler** string (A3) and check the password. A paused production project would also cause this. |
| `pg_dump failed` with "server version mismatch" | Supabase upgraded Postgres. Change `postgresql-client-17` (and `/17/`) in `.github/workflows/nightly-backup.yml` to the new number. |
| `upload … failed` / `does not match` | Check `B2_KEY_ID` / `B2_APP_KEY`, that the key belongs to this bucket and is Read and Write, and that the endpoint starts with `https://`. |
| `could not mirror bbrian34/…` | The token from A4 expired or lacks Contents read on that repo. Make a new one and update `MIRROR_TOKEN`. |
| Restore test: `cannot decrypt` | Wrong key file, or the set was made before the current key was added. |
| Restore test: `already has N app tables` | The scratch project isn't empty. Delete it and make a fresh one (D7). |
| Restore test: `restore error(s)` that all mention schema `public` (owner or comment) | Supabase owns the `public` schema itself, so these are harmless when every row count and object check above them says `ok`. Note it in the issue. The dry run only had "already exists" errors, which the script already ignores. |
| Restore test: a row count is off | Re-download the set and run again. If it repeats, keep the report and look at the night's backup log. |

## Files

- `backup/backup.sh`: the nightly backup.
- `backup/restore-test.sh`: the restore test.
- `backup/dry-run.sh`: the whole thing on a local throw-away Postgres with a
  throw-away key. Run it with `bash backup/dry-run.sh` before changing either
  script.
- `backup/age-recipients.txt`: the public key(s).
- `.github/workflows/nightly-backup.yml`: the nightly job.
- `.github/workflows/restore-test-reminder.yml`: the monthly reminder issue.

This repository is also the public website (GitHub Pages), so these files can
be read by anyone. They contain no secrets: the public key is meant to be
public, and every secret lives only in GitHub Actions secrets or offline.
