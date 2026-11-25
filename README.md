# SBS 3D Viewer

Browser viewer that shows 3D models, Gaussian splats and 3D videos as a side-by-side (SBS) stereo
pair for AR/XR display glasses — left half of the picture to the left eye, right half to the right.

## Compatible glasses

Nothing in the viewer is tied to one model. It works with any glasses, headset or 3D monitor that
shows up as an external display and has a side-by-side 3D mode — which covers most USB-C display
glasses, such as those from XREAL, VITURE, Rokid, RayNeo and TCL.

| The display in 3D mode | Layout to choose |
|---|---|
| Becomes 32:9, e.g. 3840×1080 or 3840×1200 (most glasses) | **Side-by-side (full)** — the default |
| Stays 16:9 and stretches each half across one eye | **Half side-by-side** |
| No 3D mode | **2D** |

If depth looks inverted, tick **Swap left / right eye**. Development and testing happen on RayNeo
glasses; reports from other hardware are welcome. The optional USB extras (head tracking, switching
3D mode from the page) are RayNeo-only for now — see [Head tracking](#head-tracking-experimental).

## Supported devices

⭐ = recommended.

| Device | Side-by-side 3D | Head tracking (WebHID) | 3D mode switch from page | WebXR VR | WebXR AR (passthrough) | Tested |
|---|:-:|:-:|:-:|:-:|:-:|---|
| ⭐ **RayNeo GT / GT Max** | ✅ | ✅ | ⚠️ ¹ | — | — | Yes (development hardware) |
| Other RayNeo glasses (Air series) | ✅ | ⚠️ ² | ⚠️ ¹ | — | — | No |
| XREAL, VITURE, Rokid, TCL and other USB-C display glasses | ✅ | — | — | — | — | No |
| 3D monitors and TVs with an SBS mode | ✅ | — | — | — | — | No |
| ⭐ **Meta Quest 3 / 3S** (Meta Quest Browser) | — | — | — | ✅ | ✅ | Emulated (IWER) |
| Pico 4 / 4 Ultra (Pico Browser) | — | — | — | ✅ | ⚠️ ³ | No |
| Android XR headsets (Chrome) | — | — | — | ✅ | ✅ | No |
| Apple Vision Pro (Safari) | — | — | — | ✅ | — ⁴ | No |
| PC VR headsets via OpenXR (SteamVR, WMR) in Chrome / Edge | — | — | — | ✅ | — | No |

✅ supported · ⚠️ partial or unverified · — not available

1. Uses display commands known from the RayNeo Air firmware; GT Max firmware may ignore them.
   Use the button on the glasses if the screen doesn't change.
2. Only the GT / GT Max USB id (`3941:af50`) is matched. Other models need their id added in
   `src/headtracking.js`.
3. Depends on the Pico Browser version.
4. Safari on visionOS offers `immersive-vr` only.

**Why these are recommended:**

- **RayNeo GT / GT Max** is the development hardware. It is the only display glasses with every
  glasses feature: side-by-side 3D, head tracking, and the pinned screen.
- **Meta Quest 3 / 3S** has the most complete WebXR browser. Both VR and passthrough AR work, and
  so do controller input and the recentre gesture.

Display glasses are never WebXR devices; see [WebXR headsets](#webxr-headsets).

## Run

```sh
npm install
npm run dev          # http://localhost:5173 (or the forwarded Network URL)
npm run build        # static site in dist/ (host anywhere over https)
```

The dev server uses a self-signed HTTPS certificate. To reach it by a host name other than
`localhost`, copy `.env.example` to `.env.local` and list the name(s) in `DEV_HOSTS`. `.env.local`
is ignored by git, so machine-specific settings stay out of the repository.

## Use with the glasses

1. Plug the glasses into the computer (USB-C DisplayPort) and use them as an extended display.
2. Switch the glasses to their side-by-side 3D mode, using the button, menu or companion app
   their manual describes. On most glasses the display then re-enumerates as 32:9 (3840×1080).
3. Move the browser window to that display and press **F** (fullscreen).

The page shows a reminder while the window is not 32:9 and the full side-by-side layout is
selected.

Controls: drag orbit · right-drag / two-finger pan · wheel / pinch zoom ·
view gizmo (top right): drag the ball to orbit, click an axis to look along it, drag ✥ to pan ·
arrow keys orbit · `Shift` + arrows pan ·
`F` fullscreen · `H` hide panel · `R` reset view · `C` recentre head tracking · `Space` auto-rotate.
The settings panel can be dragged by its title, resized from its lower-right corner, and
reopened with `H` or the **Settings** button.

Deep link: `/?url=https://…/model.glb` (`&format=glb` if the URL has no extension, `&layout=sbs|hsbs|mono`).

## Opening files

**Browse files…** opens a file browser inside the page, drawn for both eyes. Choose a folder once
with the system dialog; Chrome/Edge remember it between visits, other browsers for the current
visit only. Textures, `.bin` and `.mtl` files beside a model are picked up automatically.
"System dialog…" is still there for one-off files, as is drag and drop.

## Formats

- **Gaussian splats** (Spark): `.ply` (incl. compressed), `.spz`, `.splat`, `.ksplat`, `.sog`, `.zip` (SOG), `.rad`
- **Models** (three.js): `.glb/.gltf` (Draco, KTX2, Meshopt), `.vrm`, `.obj` (+`.mtl`), `.fbx`, `.stl`,
  `.ply`, `.dae`, `.3mf`, `.usdz/.usd/.usda/.usdc`, `.3ds`, `.3dm`, `.amf`, `.wrl`, `.pcd`, `.xyz`,
  `.vtk/.vtp`, `.gcode`, `.kmz`, `.vox`, `.lwo`, `.md2`, `.drc`

## 3D video

Open a video file (file browser, drag and drop) or paste a direct video URL or a YouTube link.

- **Layouts:** side-by-side and top-bottom, full or half resolution, plus plain 2D; swap eyes with
  the Display checkbox. **Projections:** flat screen, VR180 and VR360 (equirectangular; drag or use
  head tracking to look around).
- The layout is guessed from the file name (`SBS`, `HSBS`, `LR`, `TB`, `OU`, `3DH`, `3DV`, `180`,
  `360` …) and frame shape, and can be changed in the Video section. Untagged files are assumed
  side-by-side.
- With head tracking on, a flat video sits on the pinned screen. VR180/360 video follows the
  head-tracking mode: look around inside it, or view it through the pinned screen.
- **Codecs** are whatever the browser decodes: H.264 / HEVC in MP4/MOV, VP9 / AV1 in WebM/MKV.
  AVI, WMV, Blu-ray 3D (MVC) and Apple spatial video (MV-HEVC) need converting to SBS first.
- **YouTube** plays through the official embed, which is stretched so each half of an SBS frame
  covers one eye. Top-bottom videos are shown as one undistorted frame. Head tracking pins the
  frame in space by sliding the embed (full size only — no "Screen size", no head roll), and in
  look-around mode turns the view of a 360 video. 3D VR180/360 and eye swap require downloading
  the video, as do videos whose owner disabled embedding.
- YouTube and direct video URLs are kept in **Video history** in the viewer. Select an item to
  play it again, remove individual entries with `×`, or use **Clear all**.
- YouTube playback includes an **Auto quality** menu; higher resolutions are requests to YouTube
  and are only used when available for that video and connection.
- Keys: `Space` play/pause · `←` `→` skip 10 s · `M` mute.

A `.ply` is routed to the splat or mesh loader by inspecting its header. For multi-file models
(`.gltf` + `.bin` + textures, `.obj` + `.mtl`) select or drop all the files together.

URLs are fetched directly; if the host sends no CORS headers the dev/preview server's
`/proxy/…` route is used instead. A static deployment has no proxy.

## Head tracking (experimental)

Head tracking currently supports **RayNeo glasses only** (USB id `3941:af50`). Everything else
in the viewer works without it, and glasses that anchor the screen themselves can keep doing so.

"Start head tracking" reads the glasses' IMU over WebHID (Chrome/Edge desktop only) using a
community-reverse-engineered protocol — see `src/headtracking.js`, which is also the place to add
other glasses. Two modes:

- **Look around** — turning your head turns the camera (models) or the view inside a VR video.
- **Pinned screen (3D canvas)** — the stereo image sits on a virtual screen that stays put in
  space, like a 3D cinema canvas; "Screen size" sets how much of the view it fills. Flat videos
  always use this while head tracking is on.

Press `C` (or "Recentre") while looking straight ahead to re-anchor. Set **Glasses FOV** to the
diagonal field of view from the glasses' spec sheet so the pinned screen stays still in space as you turn.

**Glasses 3D on / Glasses 2D** ask the glasses to switch 3D mode over the same USB connection;
if the firmware ignores it, use the button on the glasses.

On Linux the browser needs hidraw access:

```sh
echo 'KERNEL=="hidraw*", ATTRS{idVendor}=="3941", ATTRS{idProduct}=="af50", MODE="0660", TAG+="uaccess"' \
  | sudo tee /etc/udev/rules.d/70-rayneo.rules && sudo udevadm control --reload && sudo udevadm trigger
```

## WebXR headsets

When the browser exposes a WebXR runtime, the **WebXR headset** section offers **Enter VR** and,
where passthrough is supported, **Enter AR**. Examples: the Quest, Pico and Android XR browsers,
Safari on Apple Vision Pro, desktop Chrome/Edge with an OpenXR runtime (SteamVR, WMR), or the
Immersive Web Emulator extension for testing. The runtime does the stereo rendering and tracking.
The side-by-side settings and the WebHID head tracker are not used in a session.

- **Models and splats.** What the orbit camera shows when you enter is placed in front of you,
  level with the floor. **Depth** sets the scale in the same way it sets on-screen stereo: at
  1.00× the orbit target is about 1.9 m away. **Reset view** and loading a new file refit the view.
- **Video.** A flat video is a screen fixed in the room 2.5 m ahead, sized with **Screen size**.
  VR180 and VR360 video surround you. Each eye gets its own half of the frame. YouTube can't be shown
  in a session.
- **In the headset:** trigger or pinch plays and pauses a video. Grip, or `C`, recentres.

Display glasses such as RayNeo, XREAL and VITURE never appear here. To the browser they are a
plain external monitor and register no XR runtime, so `immersive-vr` is not offered on them, and
`inline` sessions give no stereo and no tracking. On glasses, use the side-by-side layout and
[head tracking](#head-tracking-experimental) instead.

## License

[MIT](LICENSE). Bundled third-party software and acknowledgements are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Product names are trademarks of their owners; this project is not affiliated with any glasses
manufacturer.
