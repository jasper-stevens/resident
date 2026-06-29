# Supabase setup for Field Recorder

Step-by-step guide for connecting the portrait simulator to Supabase.
You only need to do this once.

## 1. Create a project

1. Go to [supabase.com](https://supabase.com) and sign in.
2. Click **New project**, pick an organisation, name, password, and region.
3. Wait for the project to finish provisioning.

## 2. Create the database table

1. In the Supabase dashboard, open **SQL Editor**.
2. Click **New query** and paste:

```sql
create table recordings (
  id           uuid primary key,
  device_id    text not null,
  created_at   timestamptz not null default now(),
  gps_label    text,
  duration_ms  int not null,
  waveform     jsonb not null default '[]',
  storage_path text not null,
  uploaded     boolean not null default true
);

alter table recordings enable row level security;

create policy "anon insert recordings"
  on recordings for insert to anon
  with check (true);

create policy "anon select recordings"
  on recordings for select to anon
  using (true);
```

3. Click **Run**.

## 3. Create the storage bucket

1. Open **Storage** in the sidebar.
2. Click **New bucket**, name it `recordings`.
3. Enable **Public bucket** for development (you can lock this down later).
4. Open the bucket → **Policies** → **New policy** → **For full customization**:

**Allow uploads (INSERT):**

```sql
create policy "anon upload recordings"
on storage.objects for insert to anon
with check (bucket_id = 'recordings');
```

**Allow downloads (SELECT):**

```sql
create policy "anon read recordings"
on storage.objects for select to anon
using (bucket_id = 'recordings');
```

## 4. Copy your API credentials

1. Open **Project Settings** → **API**.
2. Copy **Project URL** (e.g. `https://abcdefgh.supabase.co`).
3. Copy the **anon public** key under **Project API keys**.

## 5. Configure the simulator

```bash
cp tools/portrait-simulator/supabase.config.example.json \
   tools/portrait-simulator/supabase.config.json
```

Edit `supabase.config.json` with your URL, anon key, and bucket name.

## 6. Test the flow

1. Run `./tools/portrait-simulator/serve.sh` and open the page.
2. Push `device-apps/field-recorder.lua` to your simulator device ID.
3. Allow microphone access when prompted (first recording).
4. Record a clip with **Btn A**.
5. Toggle **WiFi: on** — the clip should upload automatically.
6. Check **Storage** → `recordings` and **Table Editor** → `recordings` in Supabase.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Upload fails with 401 | Check anon key in `supabase.config.json` |
| Upload fails with 403 | Add storage RLS policies (step 3) |
| Insert fails | Run the SQL migration (step 2) |
| No mic | Grant browser microphone permission; use `https://` or `localhost` |
| Cloud clips not listed | Toggle WiFi on; confirm rows exist for your `sim-…` device ID |

`supabase.config.json` is gitignored — never commit API keys.
