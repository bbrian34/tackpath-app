# F20X Scanner Recovery — TackPath

**Device:** FARSET F20X / ARBOR G47
**Android:** 12
**Scanner package:** com.eastaeon.scandecoderservice

## SYMPTOM

The physical scan trigger stops producing scans, or:

- 1D barcodes don't scan
- QR codes don't scan
- TackPath receives nothing

## STEP 1 — DO NOT MODIFY THE APK

Do **not** uninstall the scanner service.
Do **not** disable it.
Do **not** edit/rebuild ScanDecoderService.apk.
Do **not** start changing scanner settings randomly.

First try the simple recovery.

## STEP 2 — REBOOT THE F20X

Perform a normal Android reboot.
Wait until the device is completely back at the normal Android screen.

**Do not use Recovery Mode options.**

If the Android robot / "No command" screen appears accidentally:
- Hold the Power button until the device restarts.
- If a Recovery menu appears, choose **Reboot system now**.
- NEVER choose Wipe data/factory reset.

## STEP 3 — TEST SCANNING

Open the TackPath scanning screen (PathIQ / stow.html).

Test:
- A normal 1D barcode.
- A QR code.

### IF BOTH WORK

**STOP.** The scanner is recovered. Do not run additional ADB commands.

## STEP 4 — ONLY IF REBOOT DOES NOT FIX IT

Connect the F20X to the PC with ADB.

Confirm the scanner package:
```
adb shell pm list packages | findstr /i "scandecoder"
```

Expected:
```
package:com.eastaeon.scandecoderservice
```

Then investigate the scanner service before changing anything.

## KNOWN SCANNER COMPONENTS

Real scanner service:
```
com.eastaeon.scandecoderservice
```

Scanner settings broadcast:
```
com.android.scanner.service_settings
```

Scanner start broadcast:
```
com.eastaeon.scandecoderservice.ACTION_START
```

QR decoder configuration key found inside the APK:
```
sym_qr_enable
```

QR configuration exists in:
```
res/xml/simple_configuration_settings.xml
res/xml/configuration_settings.xml
res/xml/configuration_settings_ov9281.xml
```

## IMPORTANT LESSON FROM OUR REAL TEST

We tested:
```
adb shell am broadcast -a com.android.scanner.service_settings --ez sym_qr_enable true
```

Android accepted the broadcast:
```
Broadcast completed: result=0
```

We then force-stopped the scanner service and attempted to restart it.
**That caused scanning to stop temporarily.**

A **normal device reboot restored the scanner completely**, including both
1D and QR scanning.

Therefore:

**Do not use `am force-stop` as the first recovery step.**
A normal reboot is our first-line recovery procedure.

## IF WE HAVE TO CONTINUE DEBUGGING

Do not start over. We already established:

- The APK is genuine for this device.
- Package: com.eastaeon.scandecoderservice
- QR configuration key: sym_qr_enable
- QR min/max keys also exist.
- The scanner registers com.android.scanner.service_settings.
- The scanner has a ServiceReceiver and ShunFengReceiver.
- The scanner has an ACTION_START broadcast.
- The physical scanner can successfully decode both 1D and QR codes.

**Start the next investigation from these findings.**

## RELATED

The native Android bridge that catches this scanner's broadcast and feeds
it into PathIQ (stow.html) is FarsetScannerPlugin.java, listening for:
- com.scannerservice.broadcast
- android.intent.action.SCANRESULT
- com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED
- nlscan.action.SCANNER_RESULT

This is a separate layer from the scanner's own QR enable/disable state
documented above. If barcodes work but QR doesn't reach the app at all,
check this recovery doc FIRST, since the hardware itself may not be
decoding QR at all, before assuming the bridge code is at fault.
