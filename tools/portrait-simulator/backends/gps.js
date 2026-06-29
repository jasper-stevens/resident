function formatLabel(lat, lon) {
  const latStr = Math.abs(lat).toFixed(4);
  const lonStr = Math.abs(lon).toFixed(4);
  return `${latStr}${lat >= 0 ? "N" : "S"} ${lonStr}${lon >= 0 ? "E" : "W"}`;
}

export function createGps() {
  let hasFix = false;
  let label = "no fix";
  let lat = 0;
  let lon = 0;
  let watchId = null;
  let isPending = false;

  function updateFromPosition(pos) {
    lat = pos.coords.latitude;
    lon = pos.coords.longitude;
    hasFix = true;
    isPending = false;
    label = formatLabel(lat, lon);
  }

  function onError() {
    hasFix = false;
    isPending = false;
    label = "no fix";
  }

  return {
    async request() {
      if (!navigator.geolocation) {
        label = "unavailable";
        return false;
      }
      isPending = true;
      return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            updateFromPosition(pos);
            resolve(true);
          },
          () => {
            onError();
            resolve(false);
          },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
        );
      });
    },

    start() {
      if (!navigator.geolocation) {
        label = "unavailable";
        return;
      }
      if (watchId != null) return;
      isPending = true;
      watchId = navigator.geolocation.watchPosition(
        updateFromPosition,
        onError,
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
      );
    },

    stop() {
      if (watchId != null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },

    fix() {
      return hasFix;
    },

    pending() {
      return isPending && !hasFix;
    },

    string() {
      if (isPending && !hasFix) return "locating…";
      return label;
    },

    coords() {
      return { lat, lon };
    },
  };
}
