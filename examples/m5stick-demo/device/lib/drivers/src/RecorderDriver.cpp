#include "RecorderDriver.h"
#include "GpsDriver.h"

#include <Arduino.h>
#include <FS.h>
#include <SPIFFS.h>
#include <M5Unified.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <esp_random.h>
#include <esp_heap_caps.h>
#include <math.h>
#include <ctype.h>

#if __has_include("RecorderSupabaseConfig.h")
#include "RecorderSupabaseConfig.h"
#endif

extern "C" {
#include "lua/lua.h"
#include "lua/lauxlib.h"
}

static constexpr const char* INDEX_PATH = "/rec/index.json";
static constexpr const char* REC_DIR = "/rec";

void RecorderDriver::registerModule(Resident::LuaModule& m) {
  m.method<RecorderDriver, &RecorderDriver::clipsRemaining>("clips_remaining")
   .method<RecorderDriver, &RecorderDriver::clipsOnDevice>("clips_on_device")
   .method<RecorderDriver, &RecorderDriver::clipsUploaded>("clips_uploaded")
   .method<RecorderDriver, &RecorderDriver::isRecording>("is_recording")
   .method<RecorderDriver, &RecorderDriver::isSyncing>("is_syncing")
   .method<RecorderDriver, &RecorderDriver::isPlaying>("is_playing")
   .method<RecorderDriver, &RecorderDriver::amplitude>("amplitude")
   .method<RecorderDriver, &RecorderDriver::start>("start")
   .method<RecorderDriver, &RecorderDriver::stop>("stop")
   .method<RecorderDriver, &RecorderDriver::play>("play")
   .method<RecorderDriver, &RecorderDriver::stopPlayback>("stop_playback")
   .method<RecorderDriver, &RecorderDriver::deleteUploaded>("delete_uploaded")
   .method<RecorderDriver, &RecorderDriver::list>("list")
   .method<RecorderDriver, &RecorderDriver::wifiUp>("wifi_up")
   .method<RecorderDriver, &RecorderDriver::wifiConnecting>("wifi_connecting")
   .method<RecorderDriver, &RecorderDriver::connectWifi>("connect_wifi")
   .method<RecorderDriver, &RecorderDriver::disconnectWifi>("disconnect_wifi");
}

void RecorderDriver::begin() {
  if (!SPIFFS.begin(true)) {
    Serial.println("[rec] SPIFFS mount failed");
    return;
  }
  if (!SPIFFS.exists(REC_DIR)) {
    SPIFFS.mkdir(REC_DIR);
  }

  _pcmCapacity = (SAMPLE_RATE * REC_DUR_MS) / 1000;
  _pcm = static_cast<int16_t*>(heap_caps_malloc(_pcmCapacity * sizeof(int16_t),
                                                MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!_pcm) {
    _pcm = static_cast<int16_t*>(malloc(_pcmCapacity * sizeof(int16_t)));
  }
  if (!_pcm) {
    Serial.println("[rec] PCM buffer alloc failed");
    return;
  }

  loadIndex();
  ensureMic();
  Serial.printf("[rec] ready clips=%u capacity=%u samples\n", _clipCount, (unsigned)_pcmCapacity);
}

void RecorderDriver::onAppReset() {
  stopInternal();
}

void RecorderDriver::onAppRunning(bool running) {
  _appRunning = running;
  if (running) {
    ensureMic();
    if (_courierStateFn) {
      // WiFi may have connected before the app loaded; force-sync so Lua sees it.
      applyWifiState(courierWifiUp(_courierStateFn()), true, true);
      if (_wifiUp) maybeSyncPending();
    }
  } else {
    stopInternal();
  }
}

bool RecorderDriver::courierWifiUp(Courier::State state) {
  return state == Courier::State::WifiConnected ||
         state == Courier::State::TransportsConnecting ||
         state == Courier::State::Connected ||
         state == Courier::State::Reconnecting;
}

void RecorderDriver::applyWifiState(bool wifi, bool emitEvent, bool forceEmit) {
  bool changed = wifi != _wifiUp;
  if (!wifi && _wifiUp) clearCloudList();
  _wifiUp = wifi;
  if (emitEvent && _appRunning && (changed || forceEmit)) {
    sendEvent(wifi ? "wifi_connected" : "wifi_disconnected", nullptr, 0);
  }
}

void RecorderDriver::onCourierState(Courier::State state) {
  bool wasUp = _wifiUp;
  applyWifiState(courierWifiUp(state), true);
  if (!wasUp && _wifiUp) maybeSyncPending();
}

bool RecorderDriver::supabaseConfigured() {
#if __has_include("RecorderSupabaseConfig.h")
  return RECORDER_SUPABASE_URL[0] != '\0' &&
         RECORDER_SUPABASE_ANON_KEY[0] != '\0' &&
         RECORDER_SUPABASE_BUCKET[0] != '\0' &&
         strcmp(RECORDER_SUPABASE_URL, "https://YOUR_PROJECT.supabase.co") != 0 &&
         strcmp(RECORDER_SUPABASE_ANON_KEY, "YOUR_ANON_KEY") != 0;
#else
  return false;
#endif
}

bool RecorderDriver::isUuidString(const char* s) {
  if (!s || strlen(s) != 36) return false;
  for (int i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (s[i] != '-') return false;
    } else if (!isxdigit(static_cast<unsigned char>(s[i]))) {
      return false;
    }
  }
  return true;
}

void RecorderDriver::generateUuid(char* out, size_t len) {
  uint8_t u[16];
  esp_fill_random(u, sizeof(u));
  u[6] = static_cast<uint8_t>((u[6] & 0x0f) | 0x40);
  u[8] = static_cast<uint8_t>((u[8] & 0x3f) | 0x80);
  snprintf(out, len,
           "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11],
           u[12], u[13], u[14], u[15]);
}

bool RecorderDriver::ensureClipUuid(ClipMeta& clip) {
  if (isUuidString(clip.id)) return true;

  char newId[37];
  generateUuid(newId, sizeof(newId));
  char newPath[32];
  snprintf(newPath, sizeof(newPath), "%s/%s.wav", REC_DIR, newId);
  if (SPIFFS.exists(clip.wavPath)) {
    if (!SPIFFS.rename(clip.wavPath, newPath)) {
      File src = SPIFFS.open(clip.wavPath, FILE_READ);
      File dst = SPIFFS.open(newPath, FILE_WRITE);
      if (!src || !dst) return false;
      uint8_t buf[512];
      while (src.available()) {
        size_t n = src.read(buf, sizeof(buf));
        if (n == 0) break;
        dst.write(buf, n);
      }
      src.close();
      dst.close();
      SPIFFS.remove(clip.wavPath);
    }
  }
  strncpy(clip.id, newId, sizeof(clip.id) - 1);
  clip.id[sizeof(clip.id) - 1] = '\0';
  strncpy(clip.wavPath, newPath, sizeof(clip.wavPath) - 1);
  clip.wavPath[sizeof(clip.wavPath) - 1] = '\0';
  saveIndex();
  return true;
}

void RecorderDriver::maybeSyncPending() {
  if (!_wifiUp || _syncing || _recording || _playing || !supabaseConfigured()) return;
  syncPending();
}

void RecorderDriver::advanceGroupAfterSync() {
  _currentGroupId++;
  _nextCaptureIndex = 1;
  saveIndex();
}

bool RecorderDriver::uploadClip(ClipMeta& clip) {
  if (!supabaseConfigured()) return false;
#if !__has_include("RecorderSupabaseConfig.h")
  (void)clip;
  return false;
#else
  if (!ensureClipUuid(clip)) return false;

  const char* deviceId = _deviceIdFn ? _deviceIdFn() : nullptr;
  if (!deviceId || !deviceId[0]) return false;

  File f = SPIFFS.open(clip.wavPath, FILE_READ);
  if (!f) {
    Serial.printf("[rec] upload open failed: %s\n", clip.wavPath);
    return false;
  }
  size_t sz = f.size();
  if (sz == 0 || sz > 400000) {
    f.close();
    return false;
  }

  uint8_t* wav = static_cast<uint8_t*>(malloc(sz));
  if (!wav) {
    f.close();
    return false;
  }
  size_t got = f.read(wav, sz);
  f.close();
  if (got != sz) {
    free(wav);
    return false;
  }

  char storagePath[64];
  snprintf(storagePath, sizeof(storagePath), "%s/%s.wav", deviceId, clip.id);

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;

  String uploadUrl = String(RECORDER_SUPABASE_URL) + "/storage/v1/object/" +
                     RECORDER_SUPABASE_BUCKET + "/" + storagePath;
  if (!http.begin(client, uploadUrl)) {
    free(wav);
    return false;
  }
  http.addHeader("apikey", RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "audio/wav");
  http.addHeader("x-upsert", "true");

  int code = http.POST(wav, sz);
  http.end();
  free(wav);
  if (code < 200 || code >= 300) {
    Serial.printf("[rec] storage upload HTTP %d for %s\n", code, clip.id);
    return false;
  }

  JsonDocument doc;
  doc["id"] = clip.id;
  doc["device_id"] = deviceId;
  doc["gps_label"] = clip.gps;
  doc["duration_ms"] = clip.durationMs;
  doc["storage_path"] = storagePath;
  doc["group_id"] = clip.groupId;
  doc["capture_index"] = clip.captureIndex;
  doc["uploaded"] = true;
  JsonArray wave = doc["waveform"].to<JsonArray>();
  for (uint8_t i = 0; i < N_BARS; i++) wave.add(clip.wave[i]);

  String insertUrl = String(RECORDER_SUPABASE_URL) + "/rest/v1/recordings";
  if (!http.begin(client, insertUrl)) return false;
  http.addHeader("apikey", RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Prefer", "return=minimal");

  String body;
  serializeJson(doc, body);
  code = http.POST(body);
  http.end();
  if (code < 200 || code >= 300) {
    Serial.printf("[rec] recordings insert HTTP %d for %s\n", code, clip.id);
    return false;
  }

  Serial.printf("[rec] uploaded %s\n", clip.id);
  return true;
#endif
}

void RecorderDriver::syncPending() {
  if (_syncing || !_wifiUp || !supabaseConfigured()) return;

  uint8_t pending = 0;
  for (uint8_t i = 0; i < _clipCount; i++) {
    if (!_clips[i].uploaded) pending++;
  }
  if (pending == 0) {
    refreshCloudList();
    return;
  }

  _syncing = true;
  sendEvent("sync_started", nullptr, 0);

  uint8_t uploaded = 0;
  for (uint8_t i = 0; i < _clipCount; i++) {
    if (_clips[i].uploaded) continue;
    if (uploadClip(_clips[i])) {
      _clips[i].uploaded = true;
      saveIndex();
      uploaded++;
      Resident::EventField fields[] = {
        {"id", Resident::EventField::STRING, {.s = _clips[i].id}},
      };
      sendEvent("upload_complete", fields, 1);
    }
  }

  _syncing = false;
  sendEvent("sync_finished", nullptr, 0);
  if (uploaded > 0) advanceGroupAfterSync();
  refreshCloudList();
}

void RecorderDriver::clearCloudList() {
  _cloudClipCount = 0;
  for (uint8_t i = 0; i < MAX_CLOUD_CLIPS; i++) {
    _cloudClips[i] = {};
  }
}

static uint32_t parseCreatedAtSortMs(const char* iso) {
  if (!iso || !iso[0]) return 0;
  int y = 0, mo = 0, d = 0, h = 0, mi = 0;
  if (sscanf(iso, "%d-%d-%dT%d:%d", &y, &mo, &d, &h, &mi) >= 5) {
    return static_cast<uint32_t>(y) * 100000000UL + static_cast<uint32_t>(mo) * 1000000UL +
           static_cast<uint32_t>(d) * 10000UL + static_cast<uint32_t>(h) * 100UL +
           static_cast<uint32_t>(mi);
  }
  return 0;
}

static void formatCloudTs(char* out, size_t outLen, const char* createdAt) {
  if (!createdAt || strlen(createdAt) < 16) {
    strncpy(out, "?", outLen - 1);
    out[outLen - 1] = '\0';
    return;
  }
  char tmp[20];
  strncpy(tmp, createdAt, 16);
  tmp[16] = '\0';
  for (int i = 0; tmp[i]; i++) {
    if (tmp[i] == 'T') tmp[i] = ' ';
  }
  strncpy(out, tmp, outLen - 1);
  out[outLen - 1] = '\0';
}

void RecorderDriver::refreshCloudList() {
  clearCloudList();
  if (!_wifiUp || !supabaseConfigured()) return;

#if !__has_include("RecorderSupabaseConfig.h")
  return;
#else
  const char* deviceId = _deviceIdFn ? _deviceIdFn() : nullptr;
  if (!deviceId || !deviceId[0]) return;

  String url = String(RECORDER_SUPABASE_URL) +
               "/rest/v1/recordings?select=id,created_at,gps_label,duration_ms,waveform,storage_path,"
               "group_id,capture_index&device_id=eq." +
               deviceId + "&order=created_at.desc";

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return;
  http.addHeader("apikey", RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + RECORDER_SUPABASE_ANON_KEY);

  int code = http.GET();
  if (code < 200 || code >= 300) {
    Serial.printf("[rec] cloud list HTTP %d\n", code);
    http.end();
    return;
  }

  String body = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    Serial.println("[rec] cloud list JSON parse failed");
    return;
  }

  JsonArray arr = doc.as<JsonArray>();
  if (arr.isNull()) return;

  for (JsonObject row : arr) {
    if (_cloudClipCount >= MAX_CLOUD_CLIPS) break;

    CloudClip& c = _cloudClips[_cloudClipCount++];
    strlcpy(c.id, row["id"] | "", sizeof(c.id));
    c.groupId = row["group_id"] | 1;
    c.captureIndex = row["capture_index"] | 1;
    formatLabel(c.label, sizeof(c.label), c.groupId, c.captureIndex);
    formatCloudTs(c.ts, sizeof(c.ts), row["created_at"] | "");
    strlcpy(c.gps, row["gps_label"] | "no fix", sizeof(c.gps));
    strlcpy(c.storagePath, row["storage_path"] | "", sizeof(c.storagePath));
    c.durationMs = row["duration_ms"] | REC_DUR_MS;
    c.sortMs = parseCreatedAtSortMs(row["created_at"] | "");

    JsonArray wave = row["waveform"].as<JsonArray>();
    uint8_t wi = 0;
    for (JsonVariant v : wave) {
      if (wi >= N_BARS) break;
      c.wave[wi++] = v.as<float>();
    }
  }

  Serial.printf("[rec] cloud list: %u clips\n", _cloudClipCount);
#endif
}

bool RecorderDriver::fetchCloudWav(const char* storagePath, uint8_t** outBuf, size_t* outSize) {
  *outBuf = nullptr;
  *outSize = 0;
  if (!storagePath || !storagePath[0] || !_wifiUp || !supabaseConfigured()) return false;

#if !__has_include("RecorderSupabaseConfig.h")
  (void)storagePath;
  return false;
#else
  String url = String(RECORDER_SUPABASE_URL) + "/storage/v1/object/" +
               RECORDER_SUPABASE_BUCKET + "/" + storagePath;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return false;
  http.addHeader("apikey", RECORDER_SUPABASE_ANON_KEY);
  http.addHeader("Authorization", String("Bearer ") + RECORDER_SUPABASE_ANON_KEY);

  int code = http.GET();
  if (code < 200 || code >= 300) {
    Serial.printf("[rec] cloud fetch HTTP %d\n", code);
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();
  if (payload.length() == 0 || payload.length() > 400000) return false;

  uint8_t* buf = static_cast<uint8_t*>(malloc(payload.length()));
  if (!buf) return false;
  memcpy(buf, payload.c_str(), payload.length());

  *outBuf = buf;
  *outSize = payload.length();
  return true;
#endif
}

RecorderDriver::CloudClip* RecorderDriver::findCloudClip(const char* id) {
  if (!id) return nullptr;
  for (uint8_t i = 0; i < _cloudClipCount; i++) {
    if (strcmp(_cloudClips[i].id, id) == 0) return &_cloudClips[i];
  }
  return nullptr;
}

bool RecorderDriver::playWavBuffer(uint8_t* buf, size_t sz, const char* id) {
  if (_playBuf) free(_playBuf);
  _playBuf = buf;
  _playBufSize = sz;

  ensureSpeaker();
  bool ok = M5.Speaker.playWav(_playBuf, _playBufSize, 1, 0, true);
  if (!ok) {
    Serial.println("[rec] playWav failed");
    free(_playBuf);
    _playBuf = nullptr;
    _playBufSize = 0;
    ensureMic();
    return false;
  }

  strncpy(_playingId, id, sizeof(_playingId) - 1);
  _playingId[sizeof(_playingId) - 1] = '\0';
  _playing = true;
  _playbackActive = true;
  return true;
}

void RecorderDriver::pushClipToLua(lua_State* L, const ClipMeta& c, const char* source) {
  lua_createtable(L, 0, 9);
  lua_pushstring(L, c.id);
  lua_setfield(L, -2, "id");
  lua_pushstring(L, c.label);
  lua_setfield(L, -2, "label");
  lua_pushinteger(L, c.groupId);
  lua_setfield(L, -2, "group_id");
  lua_pushinteger(L, c.captureIndex);
  lua_setfield(L, -2, "capture_index");
  lua_pushstring(L, c.ts);
  lua_setfield(L, -2, "ts");
  lua_pushstring(L, c.gps);
  lua_setfield(L, -2, "gps");
  lua_pushstring(L, source);
  lua_setfield(L, -2, "source");
  lua_pushinteger(L, c.durationMs);
  lua_setfield(L, -2, "duration_ms");

  lua_createtable(L, N_BARS, 0);
  for (uint8_t w = 0; w < N_BARS; w++) {
    lua_pushnumber(L, c.wave[w]);
    lua_rawseti(L, -2, w + 1);
  }
  lua_setfield(L, -2, "wave");
}

void RecorderDriver::pushCloudClipToLua(lua_State* L, const CloudClip& c) {
  lua_createtable(L, 0, 9);
  lua_pushstring(L, c.id);
  lua_setfield(L, -2, "id");
  lua_pushstring(L, c.label);
  lua_setfield(L, -2, "label");
  lua_pushinteger(L, c.groupId);
  lua_setfield(L, -2, "group_id");
  lua_pushinteger(L, c.captureIndex);
  lua_setfield(L, -2, "capture_index");
  lua_pushstring(L, c.ts);
  lua_setfield(L, -2, "ts");
  lua_pushstring(L, c.gps);
  lua_setfield(L, -2, "gps");
  lua_pushstring(L, "cloud");
  lua_setfield(L, -2, "source");
  lua_pushinteger(L, c.durationMs);
  lua_setfield(L, -2, "duration_ms");

  lua_createtable(L, N_BARS, 0);
  for (uint8_t w = 0; w < N_BARS; w++) {
    lua_pushnumber(L, c.wave[w]);
    lua_rawseti(L, -2, w + 1);
  }
  lua_setfield(L, -2, "wave");
}

void RecorderDriver::ensureMic() {
  if (_micReady) return;
  M5.Mic.begin();
  _micReady = true;
}

void RecorderDriver::releaseMic() {
  if (!_micReady) return;
  M5.Mic.end();
  _micReady = false;
}

void RecorderDriver::releaseSpeaker() {
#if defined(BOARD_M5STICKS3)
  M5.Power.setExtOutput(true);
#endif
  M5.Speaker.stop();
  if (_speakerReady) {
    M5.Speaker.end();
    _speakerReady = false;
  }
}

void RecorderDriver::finishPlayback(bool restoreMic) {
  releaseSpeaker();
  _playing = false;
  _playbackActive = false;
  _playingId[0] = '\0';
  if (_playBuf) {
    free(_playBuf);
    _playBuf = nullptr;
    _playBufSize = 0;
  }
  if (restoreMic) ensureMic();
}

void RecorderDriver::ensureSpeaker() {
#if defined(BOARD_M5STICKS3)
  M5.Power.setExtOutput(true);
#endif
  releaseMic();
  releaseSpeaker();
  M5.Speaker.begin();
  M5.Speaker.setVolume(255);
  _speakerReady = true;
}

void RecorderDriver::stopInternal() {
  if (_recording) {
    saveRecording(true);
  }
  finishPlayback(false);
}

float RecorderDriver::frameAmplitude(const int16_t* samples, size_t count) const {
  if (count == 0) return 0.0f;
  int64_t sum = 0;
  int16_t peak = 0;
  for (size_t i = 0; i < count; i++) {
    int16_t v = samples[i];
    if (v < 0) v = static_cast<int16_t>(-v);
    if (v > peak) peak = v;
    sum += static_cast<int64_t>(samples[i]) * samples[i];
  }
  float rms = sqrtf(static_cast<float>(sum) / static_cast<float>(count)) / 32768.0f;
  float pk = static_cast<float>(peak) / 32768.0f;
  float amp = pk > rms ? pk : rms;
  if (amp > 1.0f) amp = 1.0f;
  return amp;
}

void RecorderDriver::formatTs(char* out, size_t outLen) {
  unsigned long sec = millis() / 1000UL;
  unsigned mins = (sec / 60UL) % 60UL;
  unsigned hrs = (sec / 3600UL) % 24UL;
  snprintf(out, outLen, "Today %02u:%02u", hrs, mins);
}

void RecorderDriver::formatLabel(char* out, size_t outLen, uint16_t groupId, uint16_t captureIndex) {
  char letter = 'A';
  if (captureIndex >= 1 && captureIndex <= 26) {
    letter = static_cast<char>('A' + captureIndex - 1);
  }
  snprintf(out, outLen, "%03u.%c", groupId, letter);
}

void RecorderDriver::nextCaptureSlot(uint16_t& groupId, uint16_t& captureIndex) {
  groupId = _currentGroupId;
  captureIndex = _nextCaptureIndex;
  _nextCaptureIndex++;
  if (_nextCaptureIndex > 26) {
    _nextCaptureIndex = 1;
    _currentGroupId++;
  }
}

void RecorderDriver::pushWaveToMeta(ClipMeta& meta) {
  if (_pcmCount == 0) {
    for (uint8_t i = 0; i < N_BARS; i++) meta.wave[i] = 0.0f;
    return;
  }
  const size_t span = max<size_t>(1, _pcmCount / N_BARS);
  for (uint8_t b = 0; b < N_BARS; b++) {
    size_t start = b * span;
    size_t end = min(start + span, _pcmCount);
    if (start >= _pcmCount) {
      meta.wave[b] = 0.0f;
      continue;
    }
    meta.wave[b] = frameAmplitude(_pcm + start, end - start);
  }
}

bool RecorderDriver::writeWavFile(const char* path, const int16_t* samples, size_t count,
                                    uint32_t sampleRate) {
  File f = SPIFFS.open(path, FILE_WRITE);
  if (!f) return false;

  uint32_t byteRate = sampleRate * 2;
  uint32_t dataSize = static_cast<uint32_t>(count * sizeof(int16_t));
  uint32_t chunkSize = 36 + dataSize;

  f.write((const uint8_t*)"RIFF", 4);
  f.write((uint8_t*)&chunkSize, 4);
  f.write((const uint8_t*)"WAVE", 4);
  f.write((const uint8_t*)"fmt ", 4);
  uint32_t fmtSize = 16;
  f.write((uint8_t*)&fmtSize, 4);
  uint16_t audioFormat = 1;
  uint16_t numChannels = 1;
  uint16_t bitsPerSample = 16;
  f.write((uint8_t*)&audioFormat, 2);
  f.write((uint8_t*)&numChannels, 2);
  f.write((uint8_t*)&sampleRate, 4);
  f.write((uint8_t*)&byteRate, 4);
  uint16_t blockAlign = 2;
  f.write((uint8_t*)&blockAlign, 2);
  f.write((uint8_t*)&bitsPerSample, 2);
  f.write((const uint8_t*)"data", 4);
  f.write((uint8_t*)&dataSize, 4);
  f.write(reinterpret_cast<const uint8_t*>(samples), dataSize);
  f.close();
  return true;
}

bool RecorderDriver::saveRecording(bool manualStop) {
  _recording = false;
  if (_pcmCount == 0) return false;
  if (_clipCount >= MAX_CLIPS) return false;

  ClipMeta meta{};
  generateUuid(meta.id, sizeof(meta.id));
  nextCaptureSlot(meta.groupId, meta.captureIndex);
  formatLabel(meta.label, sizeof(meta.label), meta.groupId, meta.captureIndex);
  formatTs(meta.ts, sizeof(meta.ts));
  if (_gps) {
    strncpy(meta.gps, _gps->label(), sizeof(meta.gps) - 1);
  } else {
    strncpy(meta.gps, "no fix", sizeof(meta.gps) - 1);
  }
  meta.durationMs = manualStop
                      ? static_cast<uint32_t>(millis() - _recStartMs)
                      : REC_DUR_MS;
  meta.sortMs = millis();
  meta.uploaded = false;
  snprintf(meta.wavPath, sizeof(meta.wavPath), "%s/%s.wav", REC_DIR, meta.id);

  pushWaveToMeta(meta);
  if (!writeWavFile(meta.wavPath, _pcm, _pcmCount, SAMPLE_RATE)) {
    Serial.println("[rec] wav write failed");
    return false;
  }

  _clips[_clipCount++] = meta;
  saveIndex();

  Resident::EventField fields[] = {
    {"id", Resident::EventField::STRING, {.s = meta.id}},
    {"label", Resident::EventField::STRING, {.s = meta.label}},
    {"group_id", Resident::EventField::INT, {.i = static_cast<int>(meta.groupId)}},
    {"capture_index", Resident::EventField::INT, {.i = static_cast<int>(meta.captureIndex)}},
    {"ts", Resident::EventField::STRING, {.s = meta.ts}},
    {"gps", Resident::EventField::STRING, {.s = meta.gps}},
    {"duration_ms", Resident::EventField::INT, {.i = static_cast<int>(meta.durationMs)}},
  };
  sendEvent("recording_finished", fields, 7);

  _pcmCount = 0;
  _amplitude = 0.0f;
  if (_wifiUp) maybeSyncPending();
  return true;
}

bool RecorderDriver::loadIndex() {
  _clipCount = 0;
  for (uint8_t i = 0; i < MAX_CLIPS; i++) _clips[i] = {};

  if (!SPIFFS.exists(INDEX_PATH)) return true;

  File f = SPIFFS.open(INDEX_PATH, FILE_READ);
  if (!f) return false;

  JsonDocument doc;
  if (deserializeJson(doc, f)) {
    f.close();
    return false;
  }
  f.close();

  _currentGroupId = doc["current_group"] | 1;
  _nextCaptureIndex = doc["next_capture"] | 1;

  JsonArray arr = doc["clips"].as<JsonArray>();
  for (JsonObject c : arr) {
    if (_clipCount >= MAX_CLIPS) break;
    ClipMeta& m = _clips[_clipCount++];
    strlcpy(m.id, c["id"] | "", sizeof(m.id));
    strlcpy(m.label, c["label"] | "", sizeof(m.label));
    strlcpy(m.ts, c["ts"] | "", sizeof(m.ts));
    strlcpy(m.gps, c["gps"] | "", sizeof(m.gps));
    strlcpy(m.wavPath, c["wav"] | "", sizeof(m.wavPath));
    m.groupId = c["group_id"] | 1;
    m.captureIndex = c["capture_index"] | 1;
    m.durationMs = c["duration_ms"] | REC_DUR_MS;
    m.sortMs = c["sort_ms"] | 0;
    m.uploaded = c["uploaded"] | false;
    m.inUse = true;
    JsonArray wave = c["wave"].as<JsonArray>();
    uint8_t wi = 0;
    for (JsonVariant v : wave) {
      if (wi >= N_BARS) break;
      m.wave[wi++] = v.as<float>();
    }
  }
  return true;
}

bool RecorderDriver::saveIndex() {
  JsonDocument doc;
  doc["current_group"] = _currentGroupId;
  doc["next_capture"] = _nextCaptureIndex;
  JsonArray arr = doc["clips"].to<JsonArray>();
  for (uint8_t i = 0; i < _clipCount; i++) {
    const ClipMeta& m = _clips[i];
    JsonObject c = arr.add<JsonObject>();
    c["id"] = m.id;
    c["label"] = m.label;
    c["ts"] = m.ts;
    c["gps"] = m.gps;
    c["wav"] = m.wavPath;
    c["group_id"] = m.groupId;
    c["capture_index"] = m.captureIndex;
    c["duration_ms"] = m.durationMs;
    c["sort_ms"] = m.sortMs;
    c["uploaded"] = m.uploaded;
    JsonArray wave = c["wave"].to<JsonArray>();
    for (uint8_t w = 0; w < N_BARS; w++) wave.add(m.wave[w]);
  }

  File f = SPIFFS.open(INDEX_PATH, FILE_WRITE);
  if (!f) return false;
  if (serializeJson(doc, f) == 0) {
    f.close();
    return false;
  }
  f.close();
  return true;
}

void RecorderDriver::removeClipFile(const char* path) {
  if (path && path[0]) SPIFFS.remove(path);
}

RecorderDriver::ClipMeta* RecorderDriver::findClip(const char* id) {
  if (!id) return nullptr;
  for (uint8_t i = 0; i < _clipCount; i++) {
    if (strcmp(_clips[i].id, id) == 0) return &_clips[i];
  }
  return nullptr;
}

void RecorderDriver::update() {
  if (_recording && _micReady) {
    if (M5.Mic.record(_frame, FRAME_SAMPLES, SAMPLE_RATE)) {
      size_t remain = _pcmCapacity - _pcmCount;
      size_t take = min(remain, FRAME_SAMPLES);
      if (take > 0) {
        memcpy(_pcm + _pcmCount, _frame, take * sizeof(int16_t));
        _pcmCount += take;
      }
      _amplitude = frameAmplitude(_frame, FRAME_SAMPLES);
    }
    if (millis() - _recStartMs >= REC_DUR_MS) {
      saveRecording(false);
    }
  }

  if (_playbackActive && !M5.Speaker.isPlaying()) {
    _playbackActive = false;
    _playing = false;
    Resident::EventField fields[] = {
      {"id", Resident::EventField::STRING, {.s = _playingId}},
    };
    sendEvent("playback_finished", fields, 1);
    finishPlayback(true);
  }
}

int RecorderDriver::clipsRemaining(lua_State* L) {
  int rem = static_cast<int>(MAX_CLIPS) - static_cast<int>(_clipCount);
  if (rem < 0) rem = 0;
  lua_pushinteger(L, rem);
  return 1;
}

int RecorderDriver::clipsOnDevice(lua_State* L) {
  lua_pushinteger(L, _clipCount);
  return 1;
}

int RecorderDriver::clipsUploaded(lua_State* L) {
  int upl = 0;
  for (uint8_t i = 0; i < _clipCount; i++) {
    if (_clips[i].uploaded) upl++;
  }
  lua_pushinteger(L, upl);
  return 1;
}

int RecorderDriver::isRecording(lua_State* L) {
  lua_pushboolean(L, _recording);
  return 1;
}

int RecorderDriver::isSyncing(lua_State* L) {
  lua_pushboolean(L, _syncing);
  return 1;
}

int RecorderDriver::isPlaying(lua_State* L) {
  lua_pushboolean(L, _playing);
  return 1;
}

int RecorderDriver::amplitude(lua_State* L) {
  lua_pushnumber(L, _amplitude);
  return 1;
}

int RecorderDriver::start(lua_State* L) {
  if (_recording || !_pcm) {
    lua_pushboolean(L, false);
    return 1;
  }
  if (_clipCount >= MAX_CLIPS) {
    lua_pushboolean(L, false);
    return 1;
  }

  ensureMic();
  if (_playing) {
    finishPlayback(false);
  }

  _pcmCount = 0;
  _amplitude = 0.0f;
  _recording = true;
  _recStartMs = millis();
  sendEvent("recording_started", nullptr, 0);
  lua_pushboolean(L, true);
  return 1;
}

int RecorderDriver::stop(lua_State* L) {
  bool ok = _recording;
  if (ok) saveRecording(true);
  lua_pushboolean(L, ok);
  return 1;
}

int RecorderDriver::play(lua_State* L) {
  const char* id = luaL_checkstring(L, 1);
  if (_recording) saveRecording(true);
  if (_playing || _playbackActive || _playBuf) {
    finishPlayback(false);
  }

  bool loaded = false;
  ClipMeta* clip = findClip(id);
  if (clip) {
    File f = SPIFFS.open(clip->wavPath, FILE_READ);
    if (f) {
      size_t sz = f.size();
      if (sz > 0 && sz <= 400000) {
        uint8_t* buf = static_cast<uint8_t*>(malloc(sz));
        if (buf) {
          size_t got = f.read(buf, sz);
          f.close();
          if (got == sz) {
            loaded = playWavBuffer(buf, sz, id);
          } else {
            free(buf);
          }
        } else {
          f.close();
        }
      } else {
        f.close();
      }
    }
  }

  if (!loaded && _wifiUp) {
    CloudClip* cloud = findCloudClip(id);
    if (cloud) {
      uint8_t* buf = nullptr;
      size_t sz = 0;
      if (fetchCloudWav(cloud->storagePath, &buf, &sz)) {
        loaded = playWavBuffer(buf, sz, id);
      }
    }
  }

  lua_pushboolean(L, loaded);
  return 1;
}

int RecorderDriver::stopPlayback(lua_State* L) {
  finishPlayback(true);
  return 0;
}

int RecorderDriver::deleteUploaded(lua_State* L) {
  for (uint8_t i = 0; i < _clipCount;) {
    if (_clips[i].uploaded) {
      removeClipFile(_clips[i].wavPath);
      for (uint8_t j = i + 1; j < _clipCount; j++) {
        _clips[j - 1] = _clips[j];
      }
      _clipCount--;
    } else {
      i++;
    }
  }
  saveIndex();
  refreshCloudList();
  return 0;
}

int RecorderDriver::wifiUp(lua_State* L) {
  lua_pushboolean(L, _wifiUp);
  return 1;
}

int RecorderDriver::wifiConnecting(lua_State* L) {
  if (!_courierStateFn) {
    lua_pushboolean(L, false);
    return 1;
  }
  Courier::State s = _courierStateFn();
  bool connecting = s == Courier::State::WifiConnecting ||
                    s == Courier::State::WifiConfiguring ||
                    s == Courier::State::TransportsConnecting ||
                    s == Courier::State::Reconnecting;
  lua_pushboolean(L, connecting && !_wifiUp);
  return 1;
}

int RecorderDriver::connectWifi(lua_State* L) {
  if (_connectWifiFn) _connectWifiFn();
  lua_pushboolean(L, true);
  return 1;
}

int RecorderDriver::disconnectWifi(lua_State* L) {
  if (_disconnectWifiFn) _disconnectWifiFn();
  lua_pushboolean(L, true);
  return 1;
}

int RecorderDriver::list(lua_State* L) {
  struct ListItem {
    bool cloud;
    uint8_t index;
    uint32_t sortMs;
  };

  ListItem items[MAX_CLIPS + MAX_CLOUD_CLIPS];
  uint8_t n = 0;

  for (uint8_t i = 0; i < _clipCount; i++) {
    items[n].cloud = false;
    items[n].index = i;
    items[n].sortMs = _clips[i].sortMs ? _clips[i].sortMs : 1;
    n++;
  }

  if (_wifiUp) {
    for (uint8_t i = 0; i < _cloudClipCount; i++) {
      if (findClip(_cloudClips[i].id)) continue;
      items[n].cloud = true;
      items[n].index = i;
      items[n].sortMs = _cloudClips[i].sortMs;
      n++;
    }
  }

  for (uint8_t i = 0; i + 1 < n; i++) {
    for (uint8_t j = i + 1; j < n; j++) {
      if (items[j].sortMs > items[i].sortMs) {
        ListItem tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
    }
  }

  lua_createtable(L, n, 0);
  int luaIdx = 1;
  for (uint8_t k = 0; k < n; k++) {
    if (!items[k].cloud) {
      pushClipToLua(L, _clips[items[k].index], "local");
    } else {
      pushCloudClipToLua(L, _cloudClips[items[k].index]);
    }
    lua_rawseti(L, -2, luaIdx++);
  }
  return 1;
}
