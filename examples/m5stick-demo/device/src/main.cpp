#include <M5Unified.h>
#include <Resident.h>
#include <ResidentExtension.h>
#include "DisplayDriver.h"
#include "IMUDriver.h"
#include "BuzzerDriver.h"
#include "PushButtonsDriver.h"
#include "GpsDriver.h"
#include "PowerDriver.h"
#include "RecorderDriver.h"
#include "field-recorder.embed.h"

// Default endpoint: the canonical Resident relay. Devs can self-host by
// changing RESIDENT_HOST below (or extending Courier with a config portal).
// The relay speaks the Resident canonical protocol:
//   wss://<host>/devices/<deviceId>            ← device WS (here)
//   POST https://<host>/devices/<deviceId>/send  ← skill/curl pushes JSON
static constexpr const char* RESIDENT_HOST = "resident.inanimate.tech";
static constexpr uint16_t RESIDENT_PORT = 443;

// Board-specific button pins. M5StickC Plus2 (ESP32 classic): GPIO 37 + 39.
// M5StickS3 (ESP32-S3 with OPI PSRAM): GPIO 11 + 12. On the S3, GPIO 37 is
// part of the OPI PSRAM interface — reading it via digitalRead() triggers a
// watchdog reset.
#if defined(BOARD_M5STICKS3)
static constexpr uint8_t BUTTON_PINS[] = {11, 12};
#else  // BOARD_M5STICK_C_PLUS2 (default)
static constexpr uint8_t BUTTON_PINS[] = {37, 39};
#endif
static constexpr PushButtonsConfig buttonConfig = {.numButtons = 2, .pins = BUTTON_PINS};

DisplayDriver displayDriver;
IMUDriver imuDriver;
BuzzerDriver buzzerDriver{255};
PushButtonsDriver buttonDriver{buttonConfig};
GpsDriver gpsDriver;
PowerDriver powerDriver;
RecorderDriver recorderDriver{&gpsDriver};

Resident::SandboxConfig makeConfig() {
    Resident::SandboxConfig cfg;
    cfg.deviceType    = "stick";
    cfg.extensions    = {&displayDriver, &imuDriver, &buzzerDriver, &buttonDriver,
                         &recorderDriver, &gpsDriver, &powerDriver};
    cfg.statusDisplay = &displayDriver;
    cfg.systemButton  = &buttonDriver;   // front button: tap = load, hold = forget

    // Courier::Config has a constructor with default args, so designated
    // initializers (.host = ...) don't compile under strict ESP-IDF builds.
    // Use direct field assignment.
    Courier::Config courier;
    courier.host = RESIDENT_HOST;
    courier.port = RESIDENT_PORT;
    cfg.network  = courier;
    cfg.deferNetworkSetup = true;

    return cfg;
}

Resident::Sandbox sandbox{makeConfig()};

static Courier::State queryCourierState() {
    return sandbox.courier().getState();
}

static void requestWifiConnect() {
    sandbox.connectNetwork();
}

static void requestWifiDisconnect() {
    sandbox.disconnectNetwork();
}

static const char* queryDeviceId() {
    return sandbox.getDeviceId().c_str();
}

void setup() {
    Serial.begin(115200);
    delay(2000);  // Wait for USB CDC on M5StickS3; harmless on M5Stick
    auto cfg = M5.config();
    M5.begin(cfg);
    // Portrait (135×240): field-recorder and tall layouts. Rotation 1 was landscape (240×135).
    M5.Display.setRotation(0);

#if defined(BOARD_M5STICKS3)
    M5.Power.setExtOutput(true);
    delay(100);
#endif
    Resident::Extension::beginExtension(gpsDriver);

    recorderDriver.setCourierStateFn(queryCourierState);
    recorderDriver.setConnectWifiFn(requestWifiConnect);
    recorderDriver.setDisconnectWifiFn(requestWifiDisconnect);
    recorderDriver.setDeviceIdFn(queryDeviceId);

    // Override the default /agents/<type>-agent/<deviceId> path with the
    // canonical /devices/<deviceId> path used by resident.inanimate.tech.
    sandbox.onTransportsWillConnect([]() {
        String wsPath = String("/devices/") + sandbox.getDeviceId();
        sandbox.ws().setEndpoint(RESIDENT_HOST, RESIDENT_PORT, wsPath.c_str());
    });

    sandbox.onConnectionChange([](Courier::State state) {
        recorderDriver.onCourierState(state);
    });

    sandbox.setup();

    // Bundled field-recorder loads at boot — no WiFi required. Each firmware
    // flash embeds the current device-apps/field-recorder.lua; this overwrites
    // any older app that was hot-pushed or restored from NVS.
    sandbox.loadApp(FIELD_RECORDER_APP);
}

void loop() {
    M5.update();
    // Bootstrap WiFi before the app has connect_wifi (hold B 2s while offline).
    static unsigned long wifiBtnMs = 0;
    if (sandbox.isNetworkHeldOff()) {
      if (M5.BtnB.isPressed()) {
        if (wifiBtnMs == 0) wifiBtnMs = millis();
        else if (millis() - wifiBtnMs >= 2000) {
          requestWifiConnect();
          wifiBtnMs = 0;
        }
      } else {
        wifiBtnMs = 0;
      }
    }
    gpsDriver.update();  // poll GPS even before / without an app loaded
    sandbox.loop();
}
