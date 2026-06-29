export function createPower() {
  let level = 0.92;
  let charging = true;
  let battery = null;

  function update() {
    if (!battery) return;
    level = battery.level;
    charging = battery.charging;
  }

  async function init() {
    if (!navigator.getBattery) return;
    try {
      battery = await navigator.getBattery();
      update();
      battery.addEventListener("levelchange", update);
      battery.addEventListener("chargingchange", update);
    } catch {
      /* keep defaults */
    }
  }

  void init();

  return {
    level() {
      return Math.round(level * 100);
    },
    charging() {
      return charging;
    },
    full() {
      return level >= 0.95 && !charging;
    },
  };
}
