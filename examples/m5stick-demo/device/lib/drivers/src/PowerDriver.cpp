#include "PowerDriver.h"
#include <M5Unified.h>

extern "C" {
#include "lua/lua.h"
#include "lua/lauxlib.h"
}

int PowerDriver::level(lua_State* L) {
  int pct = M5.Power.getBatteryLevel();
  if (pct < 0) pct = 85;
  if (pct > 100) pct = 100;
  lua_pushinteger(L, pct);
  return 1;
}

int PowerDriver::charging(lua_State* L) {
  lua_pushboolean(L, M5.Power.isCharging());
  return 1;
}

int PowerDriver::full(lua_State* L) {
  int pct = M5.Power.getBatteryLevel();
  bool chg = M5.Power.isCharging();
  lua_pushboolean(L, pct >= 95 && !chg);
  return 1;
}
