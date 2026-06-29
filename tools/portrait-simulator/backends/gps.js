function formatLabel(lat, lon) {
  const latStr = Math.abs(lat).toFixed(4);
  const lonStr = Math.abs(lon).toFixed(4);
  return `${latStr}${lat >= 0 ? "N" : "S"} ${lonStr}${lon >= 0 ? "E" : "W"}`;
}

const GEO_OPTIONS = {
  enableHighAccuracy: false,
  maximumAge: 60000,
  timeout: 30000,
};

const SIM_COORDS = { latitude: 51.5074, longitude: -0.1278 };
// ~25–40 m per step — enough spread to see map lines without leaving the block
const SIM_STEP_LAT = 0.00035;
const SIM_STEP_LON = 0.00055;

export function createGps() {
  let hasFix = false;
  let label = "no fix";
  let lat = 0;
  let lon = 0;
  let watchId = null;
  let isPending = false;
  let simulated = false;
  let simMode = false;
  let simLat = SIM_COORDS.latitude;
  let simLon = SIM_COORDS.longitude;

  function resetSimWalk() {
    simLat = SIM_COORDS.latitude;
    simLon = SIM_COORDS.longitude;
  }

  function advanceSimWalk() {
    simLat += (Math.random() - 0.5) * 2 * SIM_STEP_LAT;
    simLon += (Math.random() - 0.5) * 2 * SIM_STEP_LON;
    return { latitude: simLat, longitude: simLon };
  }

  function updateFromPosition(pos, fromSim = false) {
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
    hasFix = true;
    isPending = false;
    simulated = fromSim;
    label = formatLabel(lat, lon);
  }

  function applySimPosition() {
    resetSimWalk();
    updateFromPosition({ coords: { latitude: simLat, longitude: simLon } }, true);
  }

  function stopWatch() {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  function onLiveError(err) {
    console.warn("[gps] error:", err?.code, err?.message ?? err);
    if (!hasFix) {
      isPending = false;
      simulated = false;
      label = "no fix";
    }
  }

  function startLiveWatch() {
    if (!navigator.geolocation) {
      isPending = false;
      label = "unavailable";
      return;
    }
    stopWatch();
    isPending = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => updateFromPosition(pos, false),
      (err) => onLiveError(err),
      GEO_OPTIONS,
    );
  }

  return {
    setSimMode(on) {
      simMode = !!on;
      stopWatch();
      if (simMode) {
        applySimPosition();
        return;
      }
      hasFix = false;
      simulated = false;
      label = "no fix";
      isPending = true;
      startLiveWatch();
    },

    simMode() {
      return simMode;
    },

    async request() {
      if (simMode) {
        applySimPosition();
        return true;
      }
      if (!navigator.geolocation) {
        label = "unavailable";
        return false;
      }
      isPending = true;
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            updateFromPosition(pos, false);
            resolve(true);
          },
          (err) => {
            onLiveError(err);
            resolve(false);
          },
          GEO_OPTIONS,
        );
      });
    },

    start() {
      if (simMode) {
        applySimPosition();
        return;
      }
      startLiveWatch();
    },

    stop() {
      stopWatch();
    },

    fix() {
      return hasFix;
    },

    pending() {
      return isPending && !hasFix;
    },

    simulated() {
      return simulated;
    },

    string() {
      if (isPending && !hasFix) return "locating…";
      if (simMode) {
        const coords = advanceSimWalk();
        return formatLabel(coords.latitude, coords.longitude);
      }
      return label;
    },

    coords() {
      return { lat, lon };
    },
  };
}
