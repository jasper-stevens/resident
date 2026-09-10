#ifndef POWER_DRIVER_H
#define POWER_DRIVER_H

#include <ResidentDriver.h>
#include <ResidentLuaModule.h>

// Battery readout via M5Unified (real on StickS3; safe defaults elsewhere).
class PowerDriver : public Resident::Driver {
public:
  const char* name() const override { return "power"; }

  void registerModule(Resident::LuaModule& m) override {
    m.method<PowerDriver, &PowerDriver::level>("level")
     .method<PowerDriver, &PowerDriver::charging>("charging")
     .method<PowerDriver, &PowerDriver::full>("full");
  }

private:
  int level(lua_State* L);
  int charging(lua_State* L);
  int full(lua_State* L);
};

#endif  // POWER_DRIVER_H
