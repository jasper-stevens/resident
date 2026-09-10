#ifndef GPS_DRIVER_H
#define GPS_DRIVER_H

#include <ResidentDriver.h>
#include <ResidentLuaModule.h>
#include <HardwareSerial.h>

// UART GPS on the HY2.0 Grove port (M5Stack GPS/BDS Unit v1.1 @ 115200, older units @ 9600).
class GpsDriver : public Resident::Driver {
public:
  const char* name() const override { return "gps"; }

  void registerModule(Resident::LuaModule& m) override;
  void begin() override;
  void update() override;

  const char* label() const { return _label; }

private:
#if defined(BOARD_M5STICKS3)
  // StickS3 Grove: GPS module TX → G9 (ESP RX), GPS RX → G10 (ESP TX).
  static constexpr int GPS_RX_PIN = 9;
  static constexpr int GPS_TX_PIN = 10;
  static constexpr int GPS_UART_NUM = 2;
#elif defined(BOARD_M5STICK_C_PLUS2)
  static constexpr int GPS_RX_PIN = 33;
  static constexpr int GPS_TX_PIN = 32;
  static constexpr int GPS_UART_NUM = 2;
#else
  static constexpr int GPS_RX_PIN = 16;
  static constexpr int GPS_TX_PIN = 17;
  static constexpr int GPS_UART_NUM = 2;
#endif
#if defined(BOARD_M5STICKS3)
  static constexpr uint32_t GPS_BAUD_PRIMARY = 115200;
  static constexpr uint32_t GPS_BAUD_ALT = 9600;
#else
  static constexpr uint32_t GPS_BAUD_PRIMARY = 9600;
  static constexpr uint32_t GPS_BAUD_ALT = 115200;
#endif

  HardwareSerial _serial{GPS_UART_NUM};
  uint32_t _baud = GPS_BAUD_PRIMARY;
  char _line[128] = {};
  uint8_t _lineLen = 0;
  char _label[32] = "no fix";
  bool _hasFix = false;
  bool _everSeenBytes = false;  // latched on first UART byte
  bool _seenNmea = false;       // latched on first valid $ sentence
  bool _triedPinSwap = false;
  bool _triedAltBaud = false;
  int _rxPin = GPS_RX_PIN;
  int _txPin = GPS_TX_PIN;
  unsigned long _beginMs = 0;
  unsigned long _lastByteMs = 0;
  uint32_t _byteCount = 0;
  static constexpr unsigned long PIN_SWAP_MS = 12000UL;
  static constexpr unsigned long POST_SWAP_PROBE_MS = 18000UL;  // after pin swap, no bytes → no module
  static constexpr unsigned long ACTIVE_MS = 3000UL;  // recent UART → searching

  bool isActive() const;
  bool probeComplete() const;
  int uiState() const;
  void refreshLabel();
  bool isSearching() const;
  void startUart(int rx, int tx, uint32_t baud);
  void maybeProbe();
  void feedChar(char c);
  void parseLine(const char* line);
  static bool parseGGA(const char* line, double& lat, double& lon);
  static bool parseRMC(const char* line, double& lat, double& lon);
  static void formatLabel(char* out, size_t outLen, double lat, double lon);

  int fix(lua_State* L);
  int pending(lua_State* L);
  int state(lua_State* L);
  int simulated(lua_State* L);
  int stringLabel(lua_State* L);
};

#endif  // GPS_DRIVER_H
