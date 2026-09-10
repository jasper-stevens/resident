# Field Recorder Viewer

Browse cloud recordings uploaded from **any** field recorder device — M5Stick
hardware or the portrait simulator — as long as they use the same Supabase
project and `recordings` table.

## Run locally

**Option A — viewer only** (port 5180):

```bash
./tools/field-recorder-viewer/serve.sh
```

Open [http://localhost:5180](http://localhost:5180).

**Option B — simulator + viewer on one port**:

```bash
./tools/serve-tools.sh
```

- Simulator: [http://localhost:5179/portrait-simulator/](http://localhost:5179/portrait-simulator/)
- Viewer: [http://localhost:5179/field-recorder-viewer/](http://localhost:5179/field-recorder-viewer/)

## Supabase config

```bash
cp tools/field-recorder-viewer/supabase.config.example.json \
   tools/field-recorder-viewer/supabase.config.json
```

Edit with your project URL, anon key, and bucket name. See [SUPABASE.md](../portrait-simulator/SUPABASE.md).

## Deploy (Vercel)

Deploy the `tools/field-recorder-viewer/` folder as a static site. For production credentials, inject `window.__SUPABASE__` before `app.js` loads instead of committing `supabase.config.json`.
