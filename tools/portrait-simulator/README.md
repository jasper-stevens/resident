# Portrait Simulator

Local in-browser Resident sandbox with a **135×240 portrait** display. It uses the same Fengari Lua runtime and relay protocol as the [official M5Stick simulator](https://resident.inanimate.tech/#try-it-now), but lays out the screen vertically so portrait-first apps render correctly without coordinate transforms.

## Run it

```bash
./tools/portrait-simulator/serve.sh
```

Open [http://localhost:5179](http://localhost:5179), click **Connect**, then push apps to the shown `sim-…` device ID.

Requires Python 3 (for the tiny static file server) and a modern browser. Lua runs via a vendored [fengari-web](https://github.com/fengari-lua/fengari-web) bundle (no CDN).

## Push apps

From the repo root, using the bundled push script:

```bash
tools/agent-plugin/skills/push-app/tools/push.sh \
  --device-id sim-xxxxxxxx \
  device-apps/your-app.lua
```

When generating apps for this surface, point `create-app` / `validate-app` at the bundled device skill:

```bash
validate.sh --device-skill tools/portrait-simulator/DEVICE-SKILL.md device-apps/foo.lua
```

## Field recorder (mic + Supabase)

The simulator implements real `rec` and `gps` drivers for `device-apps/field-recorder.lua`:

- **Mic recording** with live waveform (Web Audio API)
- **Local playback** from IndexedDB (always available)
- **Cloud upload/playback** via Supabase when **WiFi: on**
- **GPS** from browser geolocation

Setup Supabase once — see [SUPABASE.md](./SUPABASE.md).

## What you get

| Feature | Portrait simulator | Official online simulator |
| --- | --- | --- |
| Display | 135×240 portrait | 240×135 landscape |
| Relay | `resident.inanimate.tech` | same |
| Push via `sim-…` ID | yes | yes |
| Drag-and-drop `.lua` | yes | yes |
| Buttons | 2 (A / B) | 2 |
| Mic / speaker / GPS | yes (`rec`, `gps`) | no |
| WiFi simulation | toggle button | no |
| 3D M5Stick chrome | no | yes |

## Files

- `sandbox.js` — Fengari runtime + driver modules
- `app.js` — UI, WebSocket relay, tick loop, WiFi toggle
- `backends/` — Mac implementations of `rec` / `gps`
- `DEVICE-SKILL.md` — Lua surface for agents
- `SUPABASE.md` — cloud storage setup walkthrough

Device swap notes: [docs/field-recorder-api.md](../docs/field-recorder-api.md)

## Self-hosted relay

Change the **Relay host** field before connecting, or edit `DEFAULT_RELAY` in `app.js`. The WebSocket URL shape is:

`wss://<host>/devices/<deviceId>?type=simulator`
