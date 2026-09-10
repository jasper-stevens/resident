#ifndef RECORDER_DRIVER_H
#define RECORDER_DRIVER_H

#include <ResidentDriver.h>
#include <ResidentLuaModule.h>
#include <Courier.h>

class GpsDriver;

// Field-recorder `rec` module: local mic capture + SPIFFS storage + speaker playback.
// Cloud upload to Supabase when WiFi is up (configure RecorderSupabaseConfig.h).
class RecorderDriver : public Resident::Driver {
public:
  static constexpr uint8_t MAX_CLIPS = 6;  // ~1.9 MB SPIFFS budget @ 10 s / clip
  static constexpr uint8_t N_BARS = 20;
  static constexpr uint32_t SAMPLE_RATE = 16000;
  static constexpr uint32_t REC_DUR_MS = 10000;
  static constexpr size_t FRAME_SAMPLES = 512;

  explicit RecorderDriver(GpsDriver* gps = nullptr) : _gps(gps) {}

  const char* name() const override { return "rec"; }

  void registerModule(Resident::LuaModule& m) override;
  void begin() override;
  void update() override;
  void onAppReset() override;
  void onAppRunning(bool running) override;

  void onCourierState(Courier::State state);

  // Called from main to read live Courier state when the app starts.
  using CourierStateFn = Courier::State (*)();
  void setCourierStateFn(CourierStateFn fn) { _courierStateFn = fn; }

  using ConnectWifiFn = void (*)();
  void setConnectWifiFn(ConnectWifiFn fn) { _connectWifiFn = fn; }

  using DisconnectWifiFn = void (*)();
  void setDisconnectWifiFn(DisconnectWifiFn fn) { _disconnectWifiFn = fn; }

  using DeviceIdFn = const char* (*)();
  void setDeviceIdFn(DeviceIdFn fn) { _deviceIdFn = fn; }

  struct ClipMeta {
    char id[37];
    char label[16];
    char ts[24];
    char gps[32];
    char wavPath[32];
    uint16_t groupId = 1;
    uint16_t captureIndex = 1;
    uint32_t durationMs = REC_DUR_MS;
    uint32_t sortMs = 0;
    float wave[N_BARS];
    bool uploaded = false;
    bool inUse = false;
  };

  struct CloudClip {
    char id[37];
    char label[16];
    char ts[24];
    char gps[32];
    char storagePath[64];
    uint16_t groupId = 1;
    uint16_t captureIndex = 1;
    uint32_t durationMs = REC_DUR_MS;
    uint32_t sortMs = 0;
    float wave[N_BARS];
  };

  static constexpr uint8_t MAX_CLOUD_CLIPS = 32;

private:
  static bool courierWifiUp(Courier::State state);
  void applyWifiState(bool wifi, bool emitEvent, bool forceEmit = false);
  void maybeSyncPending();
  void syncPending();
  bool uploadClip(ClipMeta& clip);
  bool ensureClipUuid(ClipMeta& clip);
  void advanceGroupAfterSync();
  void refreshCloudList();
  void clearCloudList();
  bool fetchCloudWav(const char* storagePath, uint8_t** outBuf, size_t* outSize);
  bool playWavBuffer(uint8_t* buf, size_t sz, const char* id);
  void pushClipToLua(lua_State* L, const ClipMeta& c, const char* source);
  void pushCloudClipToLua(lua_State* L, const CloudClip& c);
  static bool isUuidString(const char* s);
  static void generateUuid(char* out, size_t len);
  static bool supabaseConfigured();

  CourierStateFn _courierStateFn = nullptr;
  ConnectWifiFn _connectWifiFn = nullptr;
  DisconnectWifiFn _disconnectWifiFn = nullptr;
  DeviceIdFn _deviceIdFn = nullptr;
  bool _appRunning = false;

  GpsDriver* _gps;

  ClipMeta _clips[MAX_CLIPS];
  uint8_t _clipCount = 0;
  CloudClip _cloudClips[MAX_CLOUD_CLIPS];
  uint8_t _cloudClipCount = 0;
  uint16_t _currentGroupId = 1;
  uint16_t _nextCaptureIndex = 1;

  bool _micReady = false;
  bool _speakerReady = false;
  bool _recording = false;
  bool _playing = false;
  bool _wifiUp = false;
  bool _syncing = false;
  char _playingId[37] = {};
  bool _playbackActive = false;

  unsigned long _recStartMs = 0;
  size_t _pcmCount = 0;
  size_t _pcmCapacity = 0;
  int16_t* _pcm = nullptr;
  int16_t _frame[FRAME_SAMPLES];
  float _amplitude = 0.0f;

  uint8_t* _playBuf = nullptr;
  size_t _playBufSize = 0;

  void ensureMic();
  void ensureSpeaker();
  void releaseMic();
  void releaseSpeaker();
  void finishPlayback(bool restoreMic);
  void stopInternal();
  bool saveRecording(bool manualStop);
  bool loadIndex();
  bool saveIndex();
  void removeClipFile(const char* path);
  void formatTs(char* out, size_t outLen);
  void formatLabel(char* out, size_t outLen, uint16_t groupId, uint16_t captureIndex);
  void nextCaptureSlot(uint16_t& groupId, uint16_t& captureIndex);
  float frameAmplitude(const int16_t* samples, size_t count) const;
  void pushWaveToMeta(ClipMeta& meta);
  bool writeWavFile(const char* path, const int16_t* samples, size_t count, uint32_t sampleRate);
  ClipMeta* findClip(const char* id);
  CloudClip* findCloudClip(const char* id);

  int clipsRemaining(lua_State* L);
  int clipsOnDevice(lua_State* L);
  int clipsUploaded(lua_State* L);
  int isRecording(lua_State* L);
  int isSyncing(lua_State* L);
  int isPlaying(lua_State* L);
  int amplitude(lua_State* L);
  int start(lua_State* L);
  int stop(lua_State* L);
  int play(lua_State* L);
  int stopPlayback(lua_State* L);
  int deleteUploaded(lua_State* L);
  int list(lua_State* L);
  int wifiUp(lua_State* L);
  int wifiConnecting(lua_State* L);
  int connectWifi(lua_State* L);
  int disconnectWifi(lua_State* L);
};

#endif  // RECORDER_DRIVER_H
