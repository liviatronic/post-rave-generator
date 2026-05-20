
// ─────────────────────────────────────────────────────────────
//  ELEMENT REFS
// ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const info = document.getElementById('info');
const sensInput = document.getElementById('sens');
const sensSpan = document.getElementById('sensVal');
const smoothInput = document.getElementById('smooth');
const smoothSpan = document.getElementById('smoothVal');
const audioState = document.getElementById('audioState');
const recState = document.getElementById('recState');
const audioName = document.getElementById('audioName');


// ─────────────────────────────────────────────────────────────
//  LAYER REGISTRY
//  source  – HTMLImageElement or HTMLVideoElement (null = empty)
//  isVideo – true when source is a <video> element
// ─────────────────────────────────────────────────────────────
const layers = {
    bg: { source: null, isVideo: false },
    reactA: { source: null, isVideo: false },
    reactB: { source: null, isVideo: false },
    overlay: { source: null, isVideo: false },
};


// ─────────────────────────────────────────────────────────────
//  REACTIVE STATE  (per layer)
//  amp      – smoothed amplitude (0–1) driving the gradient
//  rawAmp   – instantaneous FFT reading before smoothing
//  innerR   – fraction of outerStop radius kept fully opaque
//  fadeLen  – alpha fall-off zone radius beyond innerR
//  minOp    – floor opacity: layer never fully disappears
// ─────────────────────────────────────────────────────────────
const reactive = {
    A: { amp: 0.5, rawAmp: 0.5, innerR: 0.55, fadeLen: 0.70, minOp: 0.15 },
    B: { amp: 0.5, rawAmp: 0.5, innerR: 0.55, fadeLen: 0.70, minOp: 0.15 },
};


// ─────────────────────────────────────────────────────────────
//  FREQUENCY BAND DEFINITIONS  (index → Hz range)
// ─────────────────────────────────────────────────────────────
const BANDS = [
    { lo: 20, hi: 250 },  // 0  bass
    { lo: 250, hi: 500 },  // 1  low-mid
    { lo: 500, hi: 2000 },  // 2  mid
    { lo: 2000, hi: 4000 },  // 3  high-mid
    { lo: 4000, hi: 20000 },  // 4  high
];


// ─────────────────────────────────────────────────────────────
//  AUDIO STATE
// ─────────────────────────────────────────────────────────────
let audioCtx = null;
let analyser = null;
let sourceNode = null;   // AudioBufferSourceNode – recording path only
let audioEl = null;   // HTMLAudioElement – live preview
let audioBuffer = null;   // decoded AudioBuffer (for recording pass)
let audioPlaying = false;
let audioDestination = null;   // MediaStreamDestination (active during recording)


// ─────────────────────────────────────────────────────────────
//  RECORDING STATE
// ─────────────────────────────────────────────────────────────
let mediaRecorder = null;
let recChunks = [];
let recRunning = false;


// ─────────────────────────────────────────────────────────────
//  OFFSCREEN CANVAS  (shared across frames – avoids GC churn)
// ─────────────────────────────────────────────────────────────
let offscreen = null;
let offscreenCtx = null;

function resetOffscreen() {
    offscreen = new OffscreenCanvas(PW, PH);
    offscreenCtx = offscreen.getContext('2d');
}


// ─────────────────────────────────────────────────────────────
//  CANVAS DIMENSIONS
// ─────────────────────────────────────────────────────────────
let PW = 1080, PH = 1350;

function applyDimensions() {
    PW = Math.max(1, parseInt(document.getElementById('canvasW').value) || 1080);
    PH = Math.max(1, parseInt(document.getElementById('canvasH').value) || 1350);
    canvas.width = PW;
    canvas.height = PH;
    resetOffscreen();
    scaleToFit();
    draw();
}

function scaleToFit() {
    const maxW = window.innerWidth - 32;
    const maxH = window.innerHeight - 300;
    const scale = Math.min(1, maxW / PW, maxH / PH);
    canvas.style.width = Math.round(PW * scale) + 'px';
    canvas.style.height = Math.round(PH * scale) + 'px';
}

window.addEventListener('resize', scaleToFit);
document.getElementById('applySize').addEventListener('click', applyDimensions);


// ─────────────────────────────────────────────────────────────
//  RENDER LOOP
// ─────────────────────────────────────────────────────────────
let renderRafId = null;

function startRenderLoop() {
    if (renderRafId) return;
    const loop = () => { draw(); renderRafId = requestAnimationFrame(loop); };
    renderRafId = requestAnimationFrame(loop);
}


// ─────────────────────────────────────────────────────────────
//  CONTROL WIRING
// ─────────────────────────────────────────────────────────────
const wire = (id, fn) => document.getElementById(id).addEventListener('input', fn);

// Layer A shape knobs
wire('innerRA', e => { reactive.A.innerR = +e.target.value; document.getElementById('innerRAVal').textContent = (+e.target.value).toFixed(2); });
wire('fadeLenA', e => { reactive.A.fadeLen = +e.target.value; document.getElementById('fadeLenAVal').textContent = (+e.target.value).toFixed(2); });
wire('minOpA', e => { reactive.A.minOp = +e.target.value; document.getElementById('minOpAVal').textContent = (+e.target.value).toFixed(2); });

// Layer B shape knobs
wire('innerRB', e => { reactive.B.innerR = +e.target.value; document.getElementById('innerRBVal').textContent = (+e.target.value).toFixed(2); });
wire('fadeLenB', e => { reactive.B.fadeLen = +e.target.value; document.getElementById('fadeLenBVal').textContent = (+e.target.value).toFixed(2); });
wire('minOpB', e => { reactive.B.minOp = +e.target.value; document.getElementById('minOpBVal').textContent = (+e.target.value).toFixed(2); });

// Global readouts (values are read directly during analysis)
sensInput.addEventListener('input', () => { sensSpan.textContent = (+sensInput.value).toFixed(2); });
smoothInput.addEventListener('input', () => { smoothSpan.textContent = (+smoothInput.value).toFixed(3); });


// ─────────────────────────────────────────────────────────────
//  AUDIO FILE LOADING
// ─────────────────────────────────────────────────────────────

document.getElementById('audioFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;

    teardownAudio();
    audioName.textContent = file.name;
    audioName.style.color = '#aaa';

    // Decode once into AudioBuffer for the deterministic recording pass.
    // HTMLAudioElement handles preview so seek/rewind don't require
    // rebuilding the Web Audio graph.
    const arrayBuffer = await file.arrayBuffer();
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    audioEl = new Audio(URL.createObjectURL(blob));
    audioEl.preload = 'auto';

    audioState.textContent = 'audio ready';
    audioState.style.color = '#8f8';
    document.getElementById('playBtn').disabled = false;
    document.getElementById('pauseBtn').disabled = false;
    document.getElementById('rewindBtn').disabled = false;
    document.getElementById('recStart').disabled = false;

    startRenderLoop();
});

function teardownAudio() {
    if (audioEl) { audioEl.pause(); audioEl = null; }
    if (sourceNode) { try { sourceNode.stop(); } catch (_) { } sourceNode = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    analyser = null; audioBuffer = null; audioPlaying = false;
}


// ─────────────────────────────────────────────────────────────
//  PREVIEW PLAYBACK  (HTMLAudioElement → analyser)
// ─────────────────────────────────────────────────────────────

function ensurePreviewConnected() {
    if (audioEl._connected) return;
    const src = audioCtx.createMediaElementSource(audioEl);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    audioEl._connected = true;
    audioEl._src = src;
}

document.getElementById('playBtn').addEventListener('click', async () => {
    if (!audioEl || !audioCtx) return;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    ensurePreviewConnected();
    audioEl.play();
    audioPlaying = true;
    audioState.textContent = 'playing';
    audioState.style.color = '#8f8';
    startAnalyserLoop();
});

document.getElementById('pauseBtn').addEventListener('click', () => {
    if (!audioEl) return;
    audioEl.pause();
    audioPlaying = false;
    audioState.textContent = 'paused';
    audioState.style.color = '#fa8';
});

document.getElementById('rewindBtn').addEventListener('click', () => {
    if (audioEl) audioEl.currentTime = 0;
});


// ─────────────────────────────────────────────────────────────
//  ANALYSER LOOP
// ─────────────────────────────────────────────────────────────
let analyserRafId = null;

function startAnalyserLoop() {
    if (analyserRafId) return;
    const loop = () => {
        if (!analyser) { analyserRafId = null; return; }
        readAnalyser();
        analyserRafId = requestAnimationFrame(loop);
    };
    analyserRafId = requestAnimationFrame(loop);
}

function stopAnalyserLoop() {
    if (analyserRafId) cancelAnimationFrame(analyserRafId);
    analyserRafId = null;
}

/** Average FFT bins in [lo, hi] Hz → raw 0–255 value. */
function getBandValue(data, sampleRate, lo, hi) {
    const binHz = sampleRate / analyser.fftSize;
    const loIdx = Math.floor(lo / binHz);
    const hiIdx = Math.min(Math.ceil(hi / binHz), data.length - 1);
    let sum = 0;
    for (let i = loIdx; i <= hiIdx; i++) sum += data[i];
    return sum / (hiIdx - loIdx + 1);
}

/**
 * Map a band selection to a normalised 0–1 value.
 *
 * Sensitivity (0.10 – 2.00) is used as a direct multiplier:
 *   1.0 → full-scale (0–255 maps to 0–1)
 *   0.5 → half-scale (less reactive)
 *   2.0 → double-scale (hits ceiling sooner)
 */
function readBand(data, sampleRate, selectId) {
    const val = document.getElementById(selectId).value;
    const sens = parseFloat(sensInput.value); // direct multiplier, no hidden division

    if (val === 'all') {
        let sumSq = 0;
        for (let i = 0; i < data.length; i++) sumSq += data[i] * data[i];
        return Math.min(1, (Math.sqrt(sumSq / data.length) / 255) * sens);
    }

    return Math.min(1, (getBandValue(data, sampleRate, BANDS[+val].lo, BANDS[+val].hi) / 255) * sens);
}

/**
 * Read FFT and apply asymmetric exponential smoothing.
 *
 *   amp += alpha * (target - amp)
 *
 * Attack  alpha = 1 - smooth × 0.7  → snappy on transients
 * Release alpha = 1 - smooth        → slower tail (breath-like)
 *
 * smooth range: 0 (instant) → 0.995 (~200-frame decay at 60fps ≈ 3 s)
 * Previous max was 0.97 (~33-frame decay); 0.995 is roughly 6× longer.
 */
function readAnalyser() {
    if (!analyser) return;

    const data = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = audioCtx.sampleRate;
    analyser.getByteFrequencyData(data);

    const smooth = parseFloat(smoothInput.value);
    const targetA = readBand(data, sampleRate, 'bandA');
    const targetB = readBand(data, sampleRate, 'bandB');

    reactive.A.rawAmp = targetA;
    reactive.B.rawAmp = targetB;

    const alphaA = targetA > reactive.A.amp ? (1 - smooth * 0.7) : (1 - smooth);
    const alphaB = targetB > reactive.B.amp ? (1 - smooth * 0.7) : (1 - smooth);

    reactive.A.amp += alphaA * (targetA - reactive.A.amp);
    reactive.B.amp += alphaB * (targetB - reactive.B.amp);
}


// ─────────────────────────────────────────────────────────────
//  MEDIA FILE LOADING
// ─────────────────────────────────────────────────────────────

function loadMedia(file, layerKey) {
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');

    if (isVideo) {
        const vid = document.createElement('video');
        vid.src = url;
        vid.loop = true;
        vid.muted = true;
        vid.playsInline = true;
        vid.autoplay = true;
        vid.oncanplay = () => {
            vid.play();
            layers[layerKey] = { source: vid, isVideo: true };
            startRenderLoop();
        };
        vid.load();
    } else {
        const img = new Image();
        img.onload = () => {
            layers[layerKey] = { source: img, isVideo: false };
            startRenderLoop();
        };
        img.src = url;
    }
}

document.getElementById('bgFile').addEventListener('change', e => { if (e.target.files[0]) loadMedia(e.target.files[0], 'bg'); });
document.getElementById('layerAFile').addEventListener('change', e => { if (e.target.files[0]) loadMedia(e.target.files[0], 'reactA'); });
document.getElementById('layerBFile').addEventListener('change', e => { if (e.target.files[0]) loadMedia(e.target.files[0], 'reactB'); });
document.getElementById('overlayFile').addEventListener('change', e => { if (e.target.files[0]) loadMedia(e.target.files[0], 'overlay'); });


// ─────────────────────────────────────────────────────────────
//  DRAW HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Cover-fit `source` into `targetCtx` filling PW × PH
 * (like CSS background-size: cover).
 */
function drawCover(targetCtx, source) {
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;

    const imgRatio = sw / sh;
    const canvasRatio = PW / PH;
    let sx, sy, sw2, sh2;

    if (imgRatio > canvasRatio) {
        sh2 = sh; sw2 = sh2 * canvasRatio;
        sx = (sw - sw2) / 2; sy = 0;
    } else {
        sw2 = sw; sh2 = sw2 / canvasRatio;
        sx = 0; sy = (sh - sh2) / 2;
    }

    targetCtx.drawImage(source, sx, sy, sw2, sh2, 0, 0, PW, PH);
}

/**
 * Draw a reactive layer with a radial alpha mask.
 *
 * 1. Paint the layer image onto the shared offscreen canvas.
 * 2. Apply a radial gradient via 'destination-in' to cut an
 *    alpha mask: fully opaque within innerStop, fading to
 *    minOp at outerStop (never hard-cuts to 0 → no strobe).
 * 3. Composite the masked offscreen onto the main canvas.
 *
 * effectiveAmp blends the raw amplitude against minOp so
 * the layer always has a soft ambient presence at silence.
 */
function drawReactive(source, state, blendSelectId) {
    if (!source) return;

    const maxR = Math.sqrt(PW * PW + PH * PH) / 2;
    const cx = PW / 2;
    const cy = PH / 2;

    const effectiveAmp = state.minOp + (1 - state.minOp) * state.amp;
    const innerStop = state.innerR * effectiveAmp * maxR;
    const outerStop = innerStop + state.fadeLen * effectiveAmp * maxR;

    if (outerStop < 1) return;

    // 1. Paint layer image
    offscreenCtx.clearRect(0, 0, PW, PH);
    offscreenCtx.globalCompositeOperation = 'source-over';
    offscreenCtx.globalAlpha = 1;
    drawCover(offscreenCtx, source);

    // 2. Radial alpha mask – outer alpha = minOp (never fully transparent)
    const edgeFraction = Math.min(0.999, innerStop / outerStop);
    const grad = offscreenCtx.createRadialGradient(cx, cy, 0, cx, cy, outerStop);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(edgeFraction, 'rgba(255,255,255,1)');
    grad.addColorStop(1, `rgba(255,255,255,${state.minOp})`);

    offscreenCtx.globalCompositeOperation = 'destination-in';
    offscreenCtx.fillStyle = grad;
    offscreenCtx.fillRect(0, 0, PW, PH);

    // 3. Composite onto main canvas
    ctx.globalCompositeOperation = document.getElementById(blendSelectId).value;
    ctx.globalAlpha = 1;
    ctx.drawImage(offscreen, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
}


// ─────────────────────────────────────────────────────────────
//  MAIN DRAW
// ─────────────────────────────────────────────────────────────

function draw() {
    ctx.clearRect(0, 0, PW, PH);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // Background – static, full opacity
    if (layers.bg.source) {
        drawCover(ctx, layers.bg.source);
    } else {
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, PW, PH);
        ctx.fillStyle = '#444';
        ctx.font = '13px monospace';
        ctx.fillText('upload background', 16, 28);
    }

    drawReactive(layers.reactA.source, reactive.A, 'blendA');
    drawReactive(layers.reactB.source, reactive.B, 'blendB');

    // Overlay – static, full opacity
    if (layers.overlay.source) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        drawCover(ctx, layers.overlay.source);
    }

    updateInfo();
}

function updateInfo() {
    const d = k => layers[k].source ? (layers[k].isVideo ? 'video' : 'image') : 'empty';
    const t = audioEl ? audioEl.currentTime.toFixed(1) + 's' : '--';
    info.textContent = [
        `canvas: ${PW}×${PH}`,
        `A: ${reactive.A.amp.toFixed(2)} raw:${reactive.A.rawAmp.toFixed(2)}`,
        `B: ${reactive.B.amp.toFixed(2)} raw:${reactive.B.rawAmp.toFixed(2)}`,
        `t: ${t}`,
        `bg:${d('bg')} A:${d('reactA')} B:${d('reactB')} ov:${d('overlay')}`,
    ].join('  ·  ');
}


// ─────────────────────────────────────────────────────────────
//  SAVE FRAME
// ─────────────────────────────────────────────────────────────

document.getElementById('saveFrame').addEventListener('click', () => {
    const a = document.createElement('a');
    a.download = `frame-${Date.now()}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
});


// ─────────────────────────────────────────────────────────────
//  RECORDING  (canvas stream + audio stream → MediaRecorder)
//
//  1. canvas.captureStream(30)                 → video track
//  2. audioCtx.createMediaStreamDestination() → audio track
//  3. analyser feeds both speakers and the destination
//  4. MediaRecorder combines both → single .webm output
// ─────────────────────────────────────────────────────────────

document.getElementById('recStart').addEventListener('click', async () => {
    if (recRunning || !audioCtx || !audioBuffer) return;

    if (audioEl) { audioEl.pause(); audioEl.currentTime = 0; }
    stopAnalyserLoop();

    if (audioCtx.state === 'suspended') await audioCtx.resume();

    audioDestination = audioCtx.createMediaStreamDestination();

    if (audioEl && audioEl._src) {
        try { audioEl._src.disconnect(); } catch (_) { }
        audioEl._connected = false;
    }

    // Fresh source node for frame-perfect, deterministic recording
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination); // speakers
    analyser.connect(audioDestination);     // recording track

    const canvasStream = canvas.captureStream(30);
    const audioTrack = audioDestination.stream.getAudioTracks()[0];
    const combined = new MediaStream([...canvasStream.getVideoTracks(), audioTrack]);

    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
            ? 'video/webm;codecs=vp8,opus'
            : 'video/webm';

    recChunks = [];
    mediaRecorder = new MediaRecorder(combined, { mimeType });

    mediaRecorder.ondataavailable = e => { if (e.data?.size > 0) recChunks.push(e.data); };

    mediaRecorder.onstop = () => {
        const blob = new Blob(recChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `recording-${Date.now()}.webm`;
        a.href = url; a.click();
        URL.revokeObjectURL(url);
        recState.textContent = 'saved ✓';
        recState.style.color = '#8f8';
        setTimeout(() => { recState.textContent = ''; }, 3000);
    };

    sourceNode.onended = () => {
        if (recRunning) document.getElementById('recStop').click();
    };

    mediaRecorder.start();
    sourceNode.start(0);
    recRunning = true;
    audioPlaying = true;
    startAnalyserLoop();

    document.getElementById('recStart').disabled = true;
    document.getElementById('recStop').disabled = false;
    document.getElementById('playBtn').disabled = true;
    recState.textContent = '● recording…';
    recState.style.color = '#f88';
});

document.getElementById('recStop').addEventListener('click', () => {
    if (!recRunning || !mediaRecorder) return;

    try { sourceNode.stop(); } catch (_) { }
    mediaRecorder.stop();
    stopAnalyserLoop();

    recRunning = false;
    audioPlaying = false;

    document.getElementById('recStart').disabled = false;
    document.getElementById('recStop').disabled = true;
    document.getElementById('playBtn').disabled = false;
    recState.textContent = 'saving…';
    recState.style.color = '#fa8';

    audioState.textContent = 'audio ready';
    audioState.style.color = '#8f8';
});


// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
applyDimensions();
startRenderLoop();