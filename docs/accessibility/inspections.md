# Inspections

Rows of the [conformance report](acr.md) that a person wrote down after looking, rather than
a script measuring them. `scripts/a11y-audit/report.mjs` merges them into the report and marks
each as an **Inspection**; it never lets one lower a measured failure. A criterion that is not
here and is not decided by a measurement is "Not Evaluated".

An inspection is only worth writing if someone can repeat it: name the method (the command
or the pages looked at), say what was found, and date it. Update the date when you look again,
and look again when the code the inspection is about changes (the final audit of a release runs
after the application has settled).

Format, one block per criterion (the generator reads it):

```
### 1.2.1
- Status: Supports | Partially Supports | Does Not Support | Not Applicable
- Method: what was looked at, and how
- Remarks: what the reader should know
- Date: YYYY-MM-DD
```

### 1.2.1
- Status: Not Applicable
- Method: `grep -rniE "<audio|<video|<track[ >]|MediaRecorder|new Audio\(|getUserMedia|SpeechRecognition|\.play\(\)" apps/web/src` returned no matches on the build audited (commit 68f91a59).
- Remarks: The product's own interface contains no prerecorded audio or video, so there is nothing to caption or describe. This is about the interface only: media that a person uploads, or that a model writes into an HTML artifact, is user-generated content (see Known limitations).
- Date: 2026-10-15

### 1.2.2
- Status: Not Applicable
- Method: The same search as 1.2.1: no audio or video elements in `apps/web/src`.
- Remarks: No prerecorded synchronized media in the product's own interface. User-generated media is out of scope as the limitations say.
- Date: 2026-10-15

### 1.2.3
- Status: Not Applicable
- Method: The same search as 1.2.1.
- Remarks: No prerecorded video in the product's own interface.
- Date: 2026-10-15

### 1.2.4
- Status: Not Applicable
- Method: The same search as 1.2.1, which also looks for microphone and speech APIs (`getUserMedia`, `SpeechRecognition`, `MediaRecorder`): none.
- Remarks: No live audio or synchronized media in the product's own interface.
- Date: 2026-10-15

### 1.2.5
- Status: Not Applicable
- Method: The same search as 1.2.1.
- Remarks: No prerecorded video in the product's own interface.
- Date: 2026-10-15

### 1.4.2
- Status: Not Applicable
- Method: The same search as 1.2.1: no audio elements and no `.play()` call in `apps/web/src`.
- Remarks: Nothing in the interface plays sound by itself.
- Date: 2026-10-15

### 1.3.4
- Status: Supports
- Method: `grep -rniE "orientation\.lock|screen\.orientation|@media[^{]*orientation|\(orientation" apps/web/src` returned no matches; the web manifest served by `/api/manifest.webmanifest` (read on the audited instance) has no `orientation` member; the measured check also loaded the chat home page at 390 by 844 and 844 by 390 px and found the message box in both and no request to rotate.
- Remarks: Neither the stylesheets, the scripts nor the manifest restrict the orientation. The measured orientation check covers one page; the source search covers all of them.
- Date: 2026-10-15

### 2.3.1
- Status: Supports
- Method: `grep -rniE "@keyframes|animate-(ping|pulse|bounce|spin)" apps/web/src` and a read of each hit: one keyframe animation of our own (`oci-search-target` in `styles/global.css`, a single 2.4 s fade of a highlight) and Tailwind's spin (1 s turn), pulse (2 s) and bounce (1 s).
- Remarks: Nothing in the interface flashes, and the fastest repeating animation completes one cycle a second, below the three-flashes threshold. User-generated and model-generated content (HTML artifacts) can contain anything and is out of scope as the limitations say.
- Date: 2026-10-15

### 2.5.4
- Status: Not Applicable
- Method: `grep -rniE "devicemotion|deviceorientation|DeviceMotionEvent" apps/web/src` returned no matches.
- Remarks: No function is operated by moving or tilting the device.
- Date: 2026-10-15

### 2.5.7
- Status: Partially Supports
- Method: `grep -rniE "draggable|onDrag|onDrop|dragover|dragstart|setPointerCapture|onPointerMove|pointermove" apps/web/src` found one dragging movement in the application: the artifact panel's resize handle (`components/artifacts/panel-resize.tsx`). The handle was also driven in the keyboard walkthrough (audit fact `dragging`).
- Remarks: The handle can be dragged. Without dragging it can be operated from the keyboard (ArrowLeft and ArrowRight in 32 px steps, Home and End, Enter to reset) and, with a pointer, double-clicked to restore the default width. There is no pointer-operable way to choose another width without dragging (no buttons or presets), which is what 2.5.7 asks for a person who uses a pointer but cannot drag. Recorded as a defect in findings.md. The same search found no drag-and-drop handlers for files (`onDrop`, `dragover`), so nothing else in the application is dragged.
- Date: 2026-10-15

### 3.2.6
- Status: Supports
- Method: `grep -rniE "mailto:|help ?url|support url|contact (us|support|your)|get help|\bhelp\b" apps/web/src` and a read of the hits: the only help mechanism in the interface is the "Need help?" card (`HelpCard` in `components/settings/settings-layout.tsx`), rendered in the `aside` "Usage and help" of the Settings layout, so it is in the same place on every Settings tab. Nothing else (no help link, chat widget or contact address) is repeated on the chat, project, sign-in or administration pages. The audit's own look at five pages (`facts.consistentHelp`) found no link or button named help or contact, which agrees.
- Remarks: A help mechanism is present on the Settings pages only and in the same relative place on all of them, so the criterion's requirement (the same relative order when repeated) holds. The card is text that sends people to the administrator who runs the instance; it gives no contact details. Inspected on the build audited; an instance's own sign-in message (Branding) is the administrator's content.
- Date: 2026-10-15
