# PathIQ App Not Reflecting Source Changes — TackPath

**Project:** PathIQ (stow.html wrapped as a Capacitor Android app)
**Package:** com.tackpath.pathiq
**Local path:** C:\Users\bbald\Downloads\pathiq-app

## SYMPTOM

Real, verified-correct changes are pushed to stow.html and confirmed
live on the actual website. A full rebuild is run - `npx cap sync`,
`gradlew clean`, `gradlew assembleDebug`, uninstall, reinstall - every
step reports success. The installed app on the device still shows the
old, pre-change behavior, sometimes for hours, across many rebuild
attempts, even ones that delete the entire `build` folder and clear
the app's data with `pm clear`.

## THE ACTUAL ROOT CAUSE

A stale, duplicate copy of the web assets existed at:

```
android\assets\public\index.html
```

This is NOT the correct location. The real, correct path Capacitor
actually uses is:

```
www\index.html
        ↓ (npx cap sync copies it here)
android\app\src\main\assets\public\index.html
```

The stray duplicate at `android\assets\public\index.html` (missing
the `app\src\main\` portion of the path) was sitting there from an
earlier point in setup and was being picked up instead of, or
alongside, the correct one - meaning every "successful" rebuild was
still packaging old content, even though the true source (`www\index.html`)
and the correct bundled location were both genuinely correct and
verified independently.

## THE FIX

1. Delete the stale duplicate folder entirely:
   ```
   rmdir /s /q android\assets
   ```

2. Run the normal full rebuild:
   ```
   npx cap sync android
   cd android
   gradlew clean
   gradlew assembleDebug
   adb uninstall com.tackpath.pathiq
   adb install app\build\outputs\apk\debug\app-debug.apk
   ```

## PERMANENT RULE

**If PathIQ ever mysteriously shows old UI after real, confirmed
source changes, check this path FIRST, before assuming the build
process itself is broken or spending hours on cache-clearing:**

```
android\assets\
```

If a stale duplicate exists there again, remove it, then run the
rebuild sequence above. This one folder explained an entire night of
otherwise correct-looking builds silently packaging old content.
