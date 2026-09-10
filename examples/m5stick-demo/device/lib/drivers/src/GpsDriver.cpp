#include "GpsDriver.h"

#include <Arduino.h>
#include <M5Unified.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

extern "C" {
#include "lua/lua.h"
#include "lua/lauxlib.h"
}

void GpsDriver::registerModule(Resident::LuaModule& m) {
  m.method<GpsDriver, &GpsDriver::fix>("fix")
   .method<GpsDriver, &GpsDriver::pending>("pending")
   .method<GpsDriver, &GpsDriver::state>("state")
   .method<GpsDriver, &GpsDriver::simulated>("simulated")
   .method<GpsDriver, &GpsDriver::stringLabel>("string");
}

void GpsDriver::startUart(int rx, int tx, uint32_t baud) {
  _rxPin = rx;
  _txPin = tx;
  _baud = baud;
  _serial.end();
  delay(50);
  _serial.begin(baud, SERIAL_8N1, _rxPin, _txPin);
  Serial.printf("[gps] UART%d rx=GPIO%d tx=GPIO%d baud=%u\n", GPS_UART_NUM, _rxPin,
                _txPin, static_cast<unsigned>(baud));
}

bool GpsDriver::isActive() const {
  return _lastByteMs > 0 && (millis() - _lastByteMs) < ACTIVE_MS;
}

bool GpsDriver::probeComplete() const {
  return _triedPinSwap && (millis() - _beginMs) >= POST_SWAP_PROBE_MS;
}

int GpsDriver::uiState() const {
  if (_hasFix) return 3;
  if (isActive()) return 2;
  if (_everSeenBytes || !probeComplete()) return 1;
  return 0;
}

bool GpsDriver::isSearching() const {
  return uiState() == 2;
}

void GpsDriver::refreshLabel() {
  if (_hasFix) return;
  const char* next = "GPS";
  switch (uiState()) {
    case 0:
      next = "---";
      break;
    case 1:
      next = _everSeenBytes ? "no signal" : "GPS";
      break;
    case 2:
      next = "locating…";
      break;
    default:
      break;
  }
  if (strcmp(_label, next) != 0) {
    strncpy(_label, next, sizeof(_label) - 1);
    _label[sizeof(_label) - 1] = '\0';
  }
}

void GpsDriver::begin() {
#if defined(BOARD_M5STICKS3)
  M5.Power.setExtOutput(true);
  delay(100);
#endif
  _hasFix = false;
  _everSeenBytes = false;
  _seenNmea = false;
  _triedPinSwap = false;
  _triedAltBaud = false;
  _byteCount = 0;
  _beginMs = millis();
  _lastByteMs = 0;
  _lineLen = 0;
  strncpy(_label, "GPS", sizeof(_label) - 1);
  _label[sizeof(_label) - 1] = '\0';
  startUart(GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD_PRIMARY);
}

void GpsDriver::maybeProbe() {
  if (_seenNmea) return;
  if (millis() - _beginMs < PIN_SWAP_MS) return;

  if (!_triedPinSwap) {
    _triedPinSwap = true;
    Serial.println("[gps] no NMEA yet — trying swapped RX/TX");
    startUart(_txPin, _rxPin, _baud);
    _beginMs = millis();
    return;
  }

  if (!_triedAltBaud && _baud != GPS_BAUD_ALT) {
    _triedAltBaud = true;
    Serial.printf("[gps] no NMEA yet — trying %u baud\n",
                  static_cast<unsigned>(GPS_BAUD_ALT));
    startUart(GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD_ALT);
    _beginMs = millis();
  }
}

void GpsDriver::update() {
#if defined(BOARD_M5STICKS3)
  static unsigned long lastPowerMs = 0;
  unsigned long now = millis();
  if (now - lastPowerMs >= 1000) {
    M5.Power.setExtOutput(true);
    lastPowerMs = now;
  }
#endif

  maybeProbe();

  while (_serial.available()) {
    _lastByteMs = millis();
    _byteCount++;
    if (!_everSeenBytes) {
      _everSeenBytes = true;
      Serial.println("[gps] first byte received");
    }
    feedChar(static_cast<char>(_serial.read()));
  }

  refreshLabel();

  static unsigned long lastLogMs = 0;
  if (millis() - lastLogMs > 30000) {
    lastLogMs = millis();
    Serial.printf("[gps] bytes=%lu state=%d fix=%d\n", _byteCount, uiState(),
                  _hasFix ? 1 : 0);
  }
}

void GpsDriver::feedChar(char c) {
  if (c == '\r') return;
  if (c == '\n') {
    if (_lineLen > 0) {
      _line[_lineLen] = '\0';
      parseLine(_line);
      _lineLen = 0;
    }
    return;
  }
  if (_lineLen + 1 >= sizeof(_line)) {
    _lineLen = 0;
    return;
  }
  _line[_lineLen++] = c;
}

static double parseNmeaCoord(const char* field, char hemi) {
  if (!field || !*field) return NAN;
  double raw = strtod(field, nullptr);
  int deg = static_cast<int>(raw / 100.0);
  double minutes = raw - static_cast<double>(deg) * 100.0;
  double dec = static_cast<double>(deg) + minutes / 60.0;
  if (hemi == 'S' || hemi == 'W') dec = -dec;
  return dec;
}

bool GpsDriver::parseGGA(const char* line, double& lat, double& lon) {
  if (strncmp(line, "$GPGGA", 6) != 0 && strncmp(line, "$GNGGA", 6) != 0) {
    return false;
  }

  const char* p = line;
  int field = 0;
  char latField[16] = {};
  char latHemi = '\0';
  char lonField[16] = {};
  char lonHemi = '\0';
  char fixField[4] = {};

  while (*p && field <= 6) {
    if (*p == ',' || *p == '*') {
      field++;
      p++;
      continue;
    }
    const char* start = p;
    while (*p && *p != ',' && *p != '*') p++;
    size_t len = static_cast<size_t>(p - start);
    if (field == 2 && len < sizeof(latField)) {
      memcpy(latField, start, len);
      latField[len] = '\0';
    } else if (field == 3 && len == 1) {
      latHemi = start[0];
    } else if (field == 4 && len < sizeof(lonField)) {
      memcpy(lonField, start, len);
      lonField[len] = '\0';
    } else if (field == 5 && len == 1) {
      lonHemi = start[0];
    } else if (field == 6 && len < sizeof(fixField)) {
      memcpy(fixField, start, len);
      fixField[len] = '\0';
    }
  }

  if (fixField[0] == '\0' || fixField[0] == '0') return false;
  lat = parseNmeaCoord(latField, latHemi);
  lon = parseNmeaCoord(lonField, lonHemi);
  return !isnan(lat) && !isnan(lon);
}

bool GpsDriver::parseRMC(const char* line, double& lat, double& lon) {
  if (strncmp(line, "$GPRMC", 6) != 0 && strncmp(line, "$GNRMC", 6) != 0) {
    return false;
  }

  const char* p = line;
  int field = 0;
  char status = 'V';
  char latField[16] = {};
  char latHemi = '\0';
  char lonField[16] = {};
  char lonHemi = '\0';

  while (*p && field <= 6) {
    if (*p == ',' || *p == '*') {
      field++;
      p++;
      continue;
    }
    const char* start = p;
    while (*p && *p != ',' && *p != '*') p++;
    size_t len = static_cast<size_t>(p - start);
    if (field == 2 && len == 1) {
      status = start[0];
    } else if (field == 3 && len < sizeof(latField)) {
      memcpy(latField, start, len);
      latField[len] = '\0';
    } else if (field == 4 && len == 1) {
      latHemi = start[0];
    } else if (field == 5 && len < sizeof(lonField)) {
      memcpy(lonField, start, len);
      lonField[len] = '\0';
    } else if (field == 6 && len == 1) {
      lonHemi = start[0];
    }
  }

  if (status != 'A') return false;
  lat = parseNmeaCoord(latField, latHemi);
  lon = parseNmeaCoord(lonField, lonHemi);
  return !isnan(lat) && !isnan(lon);
}

void GpsDriver::formatLabel(char* out, size_t outLen, double lat, double lon) {
  char latStr[12];
  char lonStr[12];
  snprintf(latStr, sizeof(latStr), "%.4f", fabs(lat));
  snprintf(lonStr, sizeof(lonStr), "%.4f", fabs(lon));
  snprintf(out, outLen, "%s%c %s%c", latStr, lat >= 0.0 ? 'N' : 'S', lonStr,
           lon >= 0.0 ? 'E' : 'W');
}

void GpsDriver::parseLine(const char* line) {
  if (line[0] != '$') return;
  _seenNmea = true;

  double lat = NAN;
  double lon = NAN;
  bool gotFix = parseGGA(line, lat, lon);
  if (!gotFix) gotFix = parseRMC(line, lat, lon);
  if (!gotFix) {
    if (strncmp(line, "$GPGGA", 6) == 0 || strncmp(line, "$GNGGA", 6) == 0 ||
        strncmp(line, "$GPRMC", 6) == 0 || strncmp(line, "$GNRMC", 6) == 0) {
      _hasFix = false;
    }
    return;
  }

  _hasFix = true;
  formatLabel(_label, sizeof(_label), lat, lon);
  Serial.printf("[gps] fix %s\n", _label);
}

int GpsDriver::fix(lua_State* L) {
  lua_pushboolean(L, _hasFix);
  return 1;
}

int GpsDriver::pending(lua_State* L) {
  lua_pushboolean(L, isSearching());
  return 1;
}

int GpsDriver::state(lua_State* L) {
  lua_pushinteger(L, uiState());
  return 1;
}

int GpsDriver::simulated(lua_State* L) {
  lua_pushboolean(L, false);
  return 1;
}

int GpsDriver::stringLabel(lua_State* L) {
  lua_pushstring(L, _label);
  return 1;
}
