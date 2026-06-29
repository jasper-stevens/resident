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

Save the device ID once so you do not have to copy it every session:

```bash
echo 'sim-xxxxxxxx' > .resident-device-id
```

When generating apps for this surface, point `create-app` / `validate-app` at the bundled device skill:

```bash
validate.sh --device-skill tools/portrait-simulator/DEVICE-SKILL.md device-apps/foo.lua
```

## What you get

| Feature | Portrait simulator | Official online simulator |
| --- | --- | --- |
| Display | 135×240 portrait | 240×135 landscape |
| Relay | `resident.inanimate.tech` | same |
| Push via `sim-…` ID | yes | yes |
| Drag-and-drop `.lua` | yes | yes |
| Buttons | 2 (A / B) | 2 |
| 3D M5Stick chrome | no | yes |

## Files

- `sandbox.js` — Fengari runtime + `screen` / `imu` / `buzzer` stubs
- `app.js` — UI, WebSocket relay client, tick loop
- `DEVICE-SKILL.md` — Lua surface for agents (portrait dimensions)

## Self-hosted relay

Change the **Relay host** field before connecting, or edit `DEFAULT_RELAY` in `app.js`. The WebSocket URL shape is:

`wss://<host>/devices/<deviceId>?type=simulator`
