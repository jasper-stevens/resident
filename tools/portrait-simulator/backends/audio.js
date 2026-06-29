export const SAMPLE_RATE = 16000;
export const N_BARS = 20;

function pickMimeType() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function encodeWavFromFloat32(samples, sampleRate = SAMPLE_RATE) {
  const pcm16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return encodeWav(pcm16, sampleRate);
}

function encodeWav(pcm16, sampleRate = SAMPLE_RATE) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm16.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < pcm16.length; i++) {
    view.setInt16(offset, pcm16[i], true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function peakOfFloat32(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  return peak;
}

function gateAmplitude(peak, noiseFloor) {
  const gated = Math.max(0, peak - noiseFloor);
  if (gated < 0.008) return 0;
  return Math.min(1, gated * 3);
}

function downsampleToBars(samples, barCount = N_BARS, noiseFloor = 0) {
  if (!samples || samples.length === 0) return Array.from({ length: barCount }, () => 0);
  const chunk = Math.max(1, Math.floor(samples.length / barCount));
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const start = i * chunk;
    const end = Math.min(samples.length, start + chunk);
    let peak = 0;
    for (let j = start; j < end; j++) {
      peak = Math.max(peak, Math.abs(samples[j]));
    }
    bars.push(gateAmplitude(peak, noiseFloor));
  }
  return bars;
}

export function downsampleToBarsForStorage(samples, barCount = N_BARS) {
  if (!samples || samples.length === 0) return Array.from({ length: barCount }, () => 0);
  const chunk = Math.max(1, Math.floor(samples.length / barCount));
  const bars = [];
  for (let i = 0; i < barCount; i++) {
    const start = i * chunk;
    const end = Math.min(samples.length, start + chunk);
    let peak = 0;
    for (let j = start; j < end; j++) {
      peak = Math.max(peak, Math.abs(samples[j]));
    }
    bars.push(Math.min(1, Math.max(0.05, peak * 2.5)));
  }
  return bars;
}

export function createAudioEngine() {
  let audioCtx = null;
  let micStream = null;
  let sourceNode = null;
  let analyser = null;
  let mediaRecorder = null;
  let mediaChunks = [];
  let recording = false;
  let liveAmplitude = 0;
  let noiseFloor = 0.012;
  let noiseCalib = [];
  let playbackSource = null;
  let playing = false;
  let recordMime = "";

  async function ensureContext() {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
    return audioCtx;
  }

  async function ensureMic() {
    await ensureContext();
    if (micStream) return micStream;
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    sourceNode = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    sourceNode.connect(analyser);
    return micStream;
  }

  function sampleMeter() {
    if (!analyser) return;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    const peak = peakOfFloat32(data);
    if (noiseCalib.length < 12) {
      noiseCalib.push(peak);
      noiseFloor = Math.max(0.006, Math.max(...noiseCalib) * 1.8);
      liveAmplitude = 0;
      return;
    }
    liveAmplitude = gateAmplitude(peak, noiseFloor);
  }

  async function startRecording() {
    if (recording) return false;
    await ensureMic();
    await ensureContext();

    recordMime = pickMimeType();
    if (!recordMime) {
      console.error("[audio] no supported MediaRecorder mime type");
      return false;
    }

    mediaChunks = [];
    noiseCalib = [];
    noiseFloor = 0.012;
    liveAmplitude = 0;
    recording = true;

    mediaRecorder = new MediaRecorder(micStream, { mimeType: recordMime });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    };
    mediaRecorder.start(250);
    return true;
  }

  async function stopRecording() {
    if (!recording || !mediaRecorder) return null;
    recording = false;

    const recorder = mediaRecorder;
    mediaRecorder = null;

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(mediaChunks, { type: recordMime }));
      };
      if (recorder.state !== "inactive") recorder.stop();
      else resolve(new Blob(mediaChunks, { type: recordMime }));
    });

    mediaChunks = [];
    liveAmplitude = 0;

    if (blob.size === 0) {
      console.warn("[audio] recording empty");
      return null;
    }

    await ensureContext();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(await blob.arrayBuffer());
    } catch (err) {
      console.error("[audio] decode failed:", err);
      return { wavBlob: blob, wave: [], durationMs: 0, mimeType: recordMime };
    }

    const ch = audioBuffer.getChannelData(0);
    const wave = downsampleToBarsForStorage(ch, N_BARS);
    const durationMs = Math.round(audioBuffer.duration * 1000);
    const wavBlob = encodeWavFromFloat32(ch, audioBuffer.sampleRate);

    return { wavBlob, wave, durationMs, mimeType: recordMime, audioBuffer: blob };
  }

  async function playBlob(blob, onEnd) {
    await stopPlayback();
    await ensureContext();
    try {
      const arrayBuf = await blob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuf.slice(0));
      playbackSource = audioCtx.createBufferSource();
      playbackSource.buffer = audioBuffer;
      playbackSource.connect(audioCtx.destination);
      playing = true;
      playbackSource.onended = () => {
        playing = false;
        playbackSource = null;
        onEnd?.();
      };
      playbackSource.start();
      return true;
    } catch (err) {
      console.error("[audio] playback failed:", err);
      playing = false;
      return false;
    }
  }

  async function stopPlayback() {
    if (playbackSource) {
      try {
        playbackSource.stop();
      } catch {
        /* already stopped */
      }
      playbackSource.disconnect();
      playbackSource = null;
    }
    playing = false;
  }

  function isRecording() {
    return recording;
  }

  function isPlaying() {
    return playing;
  }

  function getAmplitude() {
    if (recording) sampleMeter();
    return recording ? liveAmplitude : 0;
  }

  function tick() {
    if (recording) sampleMeter();
  }

  return {
    ensureMic,
    startRecording,
    stopRecording,
    playBlob,
    stopPlayback,
    isRecording,
    isPlaying,
    getAmplitude,
    tick,
    downsampleToBars,
  };
}
