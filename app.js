const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
let audioContext;
let analyser;
let micStream;
let isTuning = false;

// --- Tuner DSP config ---
const FFT_SIZE = 8192;          // ~186ms window @ 44.1kHz -> stabilno i na niskom E (82 Hz)
const CLARITY_MIN = 0.9;        // pitchy pouzdanost
const RMS_GATE = 0.006;         // ispod ovoga: žica ne zvoni -> "nema tona"
const DETECT_INTERVAL = 35;     // ms izmedu mjerenja (ne na svaki frame)
const MEDIAN_LEN = 5;           // medijan filter -> ubija oktavne skokove
const EMA_ALPHA = 0.2;          // eksponencijalno zagladivanje frekvencije
const SNAP_RATIO = 0.06;        // > ~1 poluton razlike -> nova žica, snap bez glajda
const IN_TUNE_IN = 4;           // centi: ulaz u "štima" stanje
const IN_TUNE_OUT = 7;          // centi: izlaz iz "štima" stanja (histereza)
const LOST_FRAMES_RECENTER = 14; // ~0.5s tišine -> igla klizi natrag na sredinu

// --- Tuner runtime state ---
let inputBuffer = null;
let detector = null;
let lastDetectAt = 0;
let freqHistory = [];
let smoothedFreq = 0;
let displayedNote = "--";
let lostFrames = 0;
let currentAngle = 0;
let inTune = false;

const targetNoteEl = document.getElementById('target-note');
const centsOffsetEl = document.getElementById('cents-offset');
const needleEl = document.getElementById('needle');
const btnStart = document.getElementById('btn-start-tuner');
const noteDisplay = document.querySelector('.note-display');
const audioStatusEl = document.getElementById('audio-status');

function resetTunerState() {
    freqHistory = [];
    smoothedFreq = 0;
    displayedNote = "--";
    lostFrames = 0;
    currentAngle = 0;
    inTune = false;
    lastDetectAt = 0;
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

function setNeedleAngle(angle) {
    currentAngle = Math.max(-45, Math.min(45, angle));
    needleEl.style.transform = `translateX(-50%) rotate(${currentAngle}deg)`;
}

function setInTuneVisual(on) {
    inTune = on;
    if (on) {
        noteDisplay.style.borderColor = "#2ecc71";
        noteDisplay.style.textShadow = "0 0 30px rgba(46, 204, 113, 0.6)";
    } else {
        noteDisplay.style.borderColor = "var(--glass-border)";
        noteDisplay.style.textShadow = "0 0 30px var(--accent-glow)";
    }
}

// Tab Navigation (Restored to 3 tabs)
const tabs = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        views.forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        const viewId = `view-${tab.dataset.view}`;
        document.getElementById(viewId).classList.add('active');
    });
});

async function toggleTuner() {
    if (isTuning) {
        // Stop Tuner
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
        }
        isTuning = false;
        btnStart.textContent = "POKRENI ŠTIMER";
        btnStart.style.opacity = "1";
        btnStart.disabled = false;
        targetNoteEl.textContent = "--";
        centsOffsetEl.textContent = "0.0";
        needleEl.style.transform = "translateX(-50%) rotate(0deg)";
        if (audioStatusEl) audioStatusEl.classList.remove('active');
        setInTuneVisual(false);
        resetTunerState();
        return;
    }

    // Start Tuner
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        const source = audioContext.createMediaStreamSource(micStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        source.connect(analyser);

        if (!window.pitchy) {
            throw new Error("Pitchy library not loaded.");
        }

        // Alociraj buffer i detektor JEDNOM (ne u petlji)
        inputBuffer = new Float32Array(analyser.fftSize);
        detector = pitchy.PitchDetector.forFloat32Array(analyser.fftSize);
        resetTunerState();

        isTuning = true;
        btnStart.textContent = "ZAUSTAVI ŠTIMER";
        btnStart.style.opacity = "1";
        if (audioStatusEl) audioStatusEl.classList.add('active');

        updateTuner();
    } catch (err) {
        console.error("Mic access failed:", err);
        alert("Mikrofon nije dostupan. Provjeri dozvole.");
    }
}

btnStart.addEventListener('click', toggleTuner);

function updateTuner(now) {
    if (!isTuning) return;
    requestAnimationFrame(updateTuner);

    // Mjeri samo svakih DETECT_INTERVAL ms, ne na svaki frame
    if (now && lastDetectAt && now - lastDetectAt < DETECT_INTERVAL) return;
    lastDetectAt = now || performance.now();

    analyser.getFloatTimeDomainData(inputBuffer);

    // RMS gate: da li žica uopce zvoni?
    let sumSq = 0;
    for (let i = 0; i < inputBuffer.length; i++) sumSq += inputBuffer[i] * inputBuffer[i];
    const rms = Math.sqrt(sumSq / inputBuffer.length);

    const [pitch, clarity] = detector.findPitch(inputBuffer, audioContext.sampleRate);

    const valid = rms >= RMS_GATE && clarity >= CLARITY_MIN && pitch > 60 && pitch < 1200;

    if (!valid) {
        lostFrames++;
        if (lostFrames === 3) setInTuneVisual(false);
        if (lostFrames > LOST_FRAMES_RECENTER) {
            // Nježno vrati iglu na sredinu umjesto naglog skoka / zamrzavanja
            setNeedleAngle(currentAngle * 0.85);
            if (Math.abs(currentAngle) < 0.3) {
                centsOffsetEl.textContent = "0.0";
            }
        }
        return;
    }
    lostFrames = 0;

    // Medijan filter -> odbaci oktavne skokove / promašaje
    freqHistory.push(pitch);
    if (freqHistory.length > MEDIAN_LEN) freqHistory.shift();
    const medFreq = median(freqHistory);

    // Eksponencijalno zagladivanje; snap kad se prebaci na drugu žicu
    if (smoothedFreq === 0 || Math.abs(medFreq - smoothedFreq) / smoothedFreq > SNAP_RATIO) {
        smoothedFreq = medFreq;
        freqHistory = [medFreq];
    } else {
        smoothedFreq += (medFreq - smoothedFreq) * EMA_ALPHA;
    }

    const { name, cents } = getNoteFromFreq(smoothedFreq);

    if (name !== displayedNote) {
        displayedNote = name;
        targetNoteEl.textContent = name;
    }
    centsOffsetEl.textContent = cents.toFixed(1);
    setNeedleAngle((cents / 50) * 45);

    // Histereza na "štima" stanje da zeleno ne treperi
    const absCents = Math.abs(cents);
    if (!inTune && absCents < IN_TUNE_IN) setInTuneVisual(true);
    else if (inTune && absCents > IN_TUNE_OUT) setInTuneVisual(false);
}

// --- LIBRARIES DATA (UNCHANGED) ---
const GUITAR_CHORDS = {
    "C": {
        "major": { name: "C Dur", notes: "C E G", positions: [{ s: 5, f: 3, r: true }, { s: 4, f: 2 }, { s: 2, f: 1 }] },
        "minor": { name: "C Mol", notes: "C Eb G", positions: [{ s: 5, f: 3, r: true }, { s: 4, f: 5 }, { s: 3, f: 5 }, { s: 2, f: 4 }, { s: 1, f: 3 }] },
        "7": { name: "C7", notes: "C E G Bb", positions: [{ s: 5, f: 3, r: true }, { s: 4, f: 2 }, { s: 3, f: 3 }, { s: 2, f: 1 }] },
        "maj7": { name: "Cmaj7", notes: "C E G B", positions: [{ s: 5, f: 3, r: true }, { s: 4, f: 2 }, { s: 3, f: 0 }, { s: 2, f: 0 }] },
        "m7": { name: "Cm7", notes: "C Eb G Bb", positions: [{ s: 5, f: 3, r: true }, { s: 4, f: 5 }, { s: 3, f: 3 }, { s: 2, f: 4 }] }
    },
    /* ... (rest of the chords database is kept intact) ... */
    "C#": {
        "major": { name: "C# Dur", notes: "C# F G#", positions: [{ s: 5, f: 4, r: true }, { s: 4, f: 6 }, { s: 3, f: 6 }, { s: 2, f: 6 }] },
        "minor": { name: "C# Mol", notes: "C# E G#", positions: [{ s: 5, f: 4, r: true }, { s: 4, f: 6 }, { s: 3, f: 6 }, { s: 2, f: 5 }] },
        "7": { name: "C#7", notes: "C# F G# B", positions: [{ s: 5, f: 4, r: true }, { s: 4, f: 6 }, { s: 3, f: 4 }, { s: 2, f: 6 }] },
        "maj7": { name: "C#maj7", notes: "C# F G# C", positions: [{ s: 5, f: 4, r: true }, { s: 4, f: 6 }, { s: 3, f: 5 }, { s: 2, f: 6 }] },
        "m7": { name: "C#m7", notes: "C# E G# B", positions: [{ s: 5, f: 4, r: true }, { s: 4, f: 6 }, { s: 3, f: 4 }, { s: 2, f: 5 }] }
    },
    "D": {
        "major": { name: "D Dur", notes: "D F# A", positions: [{ s: 4, f: 0, r: true }, { s: 3, f: 2 }, { s: 2, f: 3 }, { s: 1, f: 2 }] },
        "minor": { name: "D Mol", notes: "D F A", positions: [{ s: 4, f: 0, r: true }, { s: 3, f: 2 }, { s: 2, f: 3 }, { s: 1, f: 1 }] },
        "7": { name: "D7", notes: "D F# A C", positions: [{ s: 4, f: 0, r: true }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 1, f: 2 }] },
        "maj7": { name: "Dmaj7", notes: "D F# A C#", positions: [{ s: 4, f: 0, r: true }, { s: 3, f: 2 }, { s: 2, f: 2 }, { s: 1, f: 2 }] },
        "m7": { name: "Dm7", notes: "D F A C", positions: [{ s: 4, f: 0, r: true }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 1, f: 1 }] }
    },
    "D#": {
        "major": { name: "D# Dur", notes: "D# G A#", positions: [{ s: 5, f: 6, r: true }, { s: 4, f: 8 }, { s: 3, f: 8 }, { s: 2, f: 8 }] },
        "minor": { name: "D# Mol", notes: "D# F# A#", positions: [{ s: 5, f: 6, r: true }, { s: 4, f: 8 }, { s: 3, f: 8 }, { s: 2, f: 7 }] },
        "7": { name: "D#7", notes: "D# G A# C#", positions: [{ s: 5, f: 6, r: true }, { s: 4, f: 8 }, { s: 3, f: 6 }, { s: 2, f: 8 }] },
        "maj7": { name: "D#maj7", notes: "D# G A# D", positions: [{ s: 5, f: 6, r: true }, { s: 4, f: 8 }, { s: 3, f: 7 }, { s: 2, f: 8 }] },
        "m7": { name: "D#m7", notes: "D# F# A# C#", positions: [{ s: 5, f: 6, r: true }, { s: 4, f: 8 }, { s: 3, f: 6 }, { s: 2, f: 7 }] }
    },
    "E": {
        "major": { name: "E Dur", notes: "E G# B", positions: [{ s: 6, f: 0, r: true }, { s: 5, f: 2 }, { s: 4, f: 2 }, { s: 3, f: 1 }] },
        "minor": { name: "E Mol", notes: "E G B", positions: [{ s: 6, f: 0, r: true }, { s: 5, f: 2 }, { s: 4, f: 2 }] },
        "7": { name: "E7", notes: "E G# B D", positions: [{ s: 6, f: 0, r: true }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 3, f: 1 }, { s: 2, f: 0 }] },
        "maj7": { name: "Emaj7", notes: "E G# B D#", positions: [{ s: 6, f: 0, r: true }, { s: 5, f: 2 }, { s: 4, f: 1 }, { s: 3, f: 1 }] },
        "m7": { name: "Em7", notes: "E G B D", positions: [{ s: 6, f: 0, r: true }, { s: 5, f: 2 }] }
    },
    "F": {
        "major": { name: "F Dur", notes: "F A C", positions: [{ s: 6, f: 1, r: true }, { s: 5, f: 3 }, { s: 4, f: 3 }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 1, f: 1 }] },
        "minor": { name: "F Mol", notes: "F Ab C", positions: [{ s: 6, f: 1, r: true }, { s: 5, f: 3 }, { s: 4, f: 3 }, { s: 3, f: 1 }, { s: 2, f: 1 }, { s: 1, f: 1 }] },
        "7": { name: "F7", notes: "F A C Eb", positions: [{ s: 6, f: 1, r: true }, { s: 5, f: 3 }, { s: 4, f: 1 }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 1, f: 1 }] },
        "maj7": { name: "Fmaj7", notes: "F A C E", positions: [{ s: 4, f: 3, r: true }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 1, f: 0 }] },
        "m7": { name: "Fm7", notes: "F Ab C Eb", positions: [{ s: 6, f: 1, r: true }, { s: 5, f: 3 }, { s: 4, f: 1 }, { s: 3, f: 1 }, { s: 2, f: 1 }, { s: 1, f: 1 }] }
    },
    "F#": {
        "major": { name: "F# Dur", notes: "F# A# C#", positions: [{ s: 6, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 4 }, { s: 3, f: 3 }, { s: 2, f: 2 }, { s: 1, f: 2 }] },
        "minor": { name: "F# Mol", notes: "F# A C#", positions: [{ s: 6, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 4 }, { s: 3, f: 2 }, { s: 2, f: 2 }, { s: 1, f: 2 }] },
        "7": { name: "F#7", notes: "F# A# C# E", positions: [{ s: 6, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 2 }, { s: 3, f: 3 }, { s: 2, f: 2 }, { s: 1, f: 2 }] },
        "maj7": { name: "F#maj7", notes: "F# A# C# F", positions: [{ s: 6, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 3 }, { s: 3, f: 3 }, { s: 2, f: 2 }, { s: 1, f: 2 }] },
        "m7": { name: "F#m7", notes: "F# A C# E", positions: [{ s: 6, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 2 }, { s: 3, f: 2 }, { s: 2, f: 2 }, { s: 1, f: 2 }] }
    },
    "G": {
        "major": { name: "G Dur", notes: "G B D", positions: [{ s: 6, f: 3, r: true }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 3, f: 0 }, { s: 2, f: 0 }, { s: 1, f: 3 }] },
        "minor": { name: "G Mol", notes: "G Bb D", positions: [{ s: 6, f: 3, r: true }, { s: 5, f: 5 }, { s: 4, f: 5 }, { s: 3, f: 3 }, { s: 2, f: 3 }, { s: 1, f: 3 }] },
        "7": { name: "G7", notes: "G B D F", positions: [{ s: 6, f: 3, r: true }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 3, f: 0 }, { s: 2, f: 0 }, { s: 1, f: 1 }] },
        "maj7": { name: "Gmaj7", notes: "G B D F#", positions: [{ s: 6, f: 3, r: true }, { s: 1, f: 2 }] },
        "m7": { name: "Gm7", notes: "G Bb D F", positions: [{ s: 6, f: 3, r: true }, { s: 3, f: 3 }, { s: 2, f: 3 }, { s: 1, f: 3 }] }
    },
    "G#": {
        "major": { name: "G# Dur", notes: "G# C D#", positions: [{ s: 6, f: 4, r: true }, { s: 5, f: 6 }, { s: 4, f: 6 }, { s: 3, f: 5 }, { s: 2, f: 4 }, { s: 1, f: 4 }] },
        "minor": { name: "G# Mol", notes: "G# B D#", positions: [{ s: 6, f: 4, r: true }, { s: 5, f: 6 }, { s: 4, f: 6 }, { s: 3, f: 4 }, { s: 2, f: 4 }, { s: 1, f: 4 }] },
        "7": { name: "G#7", notes: "G# C D# F#", positions: [{ s: 6, f: 4, r: true }, { s: 5, f: 6 }, { s: 4, f: 4 }, { s: 3, f: 5 }, { s: 2, f: 4 }, { s: 1, f: 4 }] },
        "maj7": { name: "G#maj7", notes: "G# C D# G", positions: [{ s: 6, f: 4, r: true }, { s: 5, f: 6 }, { s: 4, f: 5 }, { s: 3, f: 5 }, { s: 2, f: 4 }, { s: 1, f: 4 }] },
        "m7": { name: "G#m7", notes: "G# B D# F#", positions: [{ s: 6, f: 4, r: true }, { s: 5, f: 6 }, { s: 4, f: 4 }, { s: 3, f: 4 }, { s: 2, f: 4 }, { s: 1, f: 4 }] }
    },
    "A": {
        "major": { name: "A Dur", notes: "A C# E", positions: [{ s: 5, f: 0, r: true }, { s: 4, f: 2 }, { s: 3, f: 2 }, { s: 2, f: 2 }] },
        "minor": { name: "A Mol", notes: "A C E", positions: [{ s: 5, f: 0, r: true }, { s: 4, f: 2 }, { s: 3, f: 2 }, { s: 2, f: 1 }] },
        "7": { name: "A7", notes: "A C# E G", positions: [{ s: 5, f: 0, r: true }, { s: 4, f: 2 }, { s: 2, f: 2 }] },
        "maj7": { name: "Amaj7", notes: "A C# E G#", positions: [{ s: 5, f: 0, r: true }, { s: 4, f: 2 }, { s: 3, f: 1 }, { s: 2, f: 2 }] },
        "m7": { name: "Am7", notes: "A C E G", positions: [{ s: 5, f: 0, r: true }, { s: 4, f: 2 }, { s: 2, f: 1 }] }
    },
    "A#": {
        "major": { name: "A# Dur", notes: "A# D F", positions: [{ s: 5, f: 1, r: true }, { s: 4, f: 3 }, { s: 3, f: 3 }, { s: 2, f: 3 }] },
        "minor": { name: "A# Mol", notes: "A# C# F", positions: [{ s: 5, f: 1, r: true }, { s: 4, f: 3 }, { s: 3, f: 3 }, { s: 2, f: 2 }] },
        "7": { name: "A#7", notes: "A# D F G#", positions: [{ s: 5, f: 1, r: true }, { s: 4, f: 3 }, { s: 3, f: 1 }, { s: 2, f: 3 }] },
        "maj7": { name: "A#maj7", notes: "A# D F A", positions: [{ s: 5, f: 1, r: true }, { s: 4, f: 3 }, { s: 3, f: 2 }, { s: 2, f: 3 }] },
        "m7": { name: "A#m7", notes: "A# C# F G#", positions: [{ s: 5, f: 1, r: true }, { s: 4, f: 3 }, { s: 3, f: 1 }, { s: 2, f: 2 }] }
    },
    "B": {
        "major": { name: "B Dur", notes: "B D# F#", positions: [{ s: 5, f: 2, r: true }, { s: 4, f: 4 }, { s: 3, f: 4 }, { s: 2, f: 4 }] },
        "minor": { name: "B Mol", notes: "B D F#", positions: [{ s: 5, f: 2, r: true }, { s: 4, f: 4 }, { s: 3, f: 4 }, { s: 2, f: 3 }] },
        "7": { name: "B7", notes: "B D# F# A", positions: [{ s: 5, f: 2, r: true }, { s: 4, f: 1 }, { s: 3, f: 2 }, { s: 2, f: 0 }, { s: 1, f: 2 }] },
        "maj7": { name: "Bmaj7", notes: "B D# F# A#", positions: [{ s: 5, f: 2, r: true }, { s: 4, f: 4 }, { s: 3, f: 3 }, { s: 2, f: 4 }] },
        "m7": { name: "Bm7", notes: "B D F# A", positions: [{ s: 5, f: 2, r: true }, { s: 4, f: 4 }, { s: 3, f: 2 }, { s: 2, f: 3 }] }
    }
};

const GUITAR_SCALES = {
    "C": {
        "major_penta": [{ s: 5, f: 3, r: true }, { s: 5, f: 5 }, { s: 4, f: 2 }, { s: 4, f: 5 }, { s: 3, f: 2 }, { s: 3, f: 5 }, { s: 2, f: 3 }, { s: 2, f: 5 }, { s: 1, f: 3 }, { s: 1, f: 5 }],
        "minor_penta": [{ s: 6, f: 8, r: true }, { s: 6, f: 11 }, { s: 5, f: 8 }, { s: 5, f: 10 }, { s: 4, f: 8 }, { s: 4, f: 10 }, { s: 3, f: 8 }, { s: 3, f: 10 }, { s: 2, f: 8 }, { s: 2, f: 11 }, { s: 1, f: 8 }, { s: 1, f: 11 }],
        "blues": [{ s: 5, f: 3, r: true }, { s: 5, f: 6 }, { s: 4, f: 3 }, { s: 4, f: 4 }, { s: 4, f: 5 }, { s: 3, f: 3 }, { s: 3, f: 5 }, { s: 2, f: 4 }, { s: 2, f: 6 }, { s: 1, f: 3 }]
    },
    "G": {
        "major_penta": [{ s: 6, f: 3, r: true }, { s: 6, f: 5 }, { s: 5, f: 2 }, { s: 5, f: 5 }, { s: 4, f: 2 }, { s: 4, f: 5 }, { s: 3, f: 2 }, { s: 3, f: 4 }, { s: 2, f: 3 }, { s: 2, f: 5 }, { s: 1, f: 3 }, { s: 1, f: 5 }],
        "minor_penta": [{ s: 6, f: 3, r: true }, { s: 6, f: 6 }, { s: 5, f: 3 }, { s: 5, f: 5 }, { s: 4, f: 3 }, { s: 4, f: 5 }, { s: 3, f: 3 }, { s: 3, f: 5 }, { s: 2, f: 3 }, { s: 2, f: 6 }, { s: 1, f: 3 }, { s: 1, f: 6 }],
        "blues": [{ s: 6, f: 3, r: true }, { s: 6, f: 6 }, { s: 5, f: 3 }, { s: 5, f: 4 }, { s: 5, f: 5 }, { s: 4, f: 3 }, { s: 4, f: 5 }, { s: 3, f: 3 }, { s: 3, f: 5 }, { s: 3, f: 6 }, { s: 2, f: 3 }, { s: 1, f: 3 }]
    },
    "B": {
        "major_penta": [{ s: 5, f: 2, r: true }, { s: 5, f: 4 }, { s: 4, f: 1 }, { s: 4, f: 4 }, { s: 3, f: 1 }, { s: 3, f: 4 }, { s: 2, f: 2 }, { s: 2, f: 4 }, { s: 1, f: 2 }, { s: 1, f: 4 }],
        "minor_penta": [{ s: 6, f: 7, r: true }, { s: 6, f: 10 }, { s: 5, f: 7 }, { s: 5, f: 9 }, { s: 4, f: 7 }, { s: 4, f: 9 }, { s: 3, f: 7 }, { s: 3, f: 9 }, { s: 2, f: 7 }, { s: 2, f: 10 }, { s: 1, f: 7 }, { s: 1, f: 10 }],
        "blues": [{ s: 6, f: 7, r: true }, { s: 6, f: 10 }, { s: 5, f: 7 }, { s: 5, f: 8 }, { s: 5, f: 9 }, { s: 4, f: 7 }, { s: 4, f: 9 }, { s: 3, f: 7 }, { s: 3, f: 9 }, { s: 3, f: 10 }, { s: 2, f: 7 }, { s: 1, f: 7 }]
    },
    "D": {
        "major_penta": [{ s: 4, f: 0, r: true }, { s: 4, f: 2 }, { s: 3, f: 0 }, { s: 3, f: 2 }, { s: 2, f: 0 }, { s: 2, f: 3 }, { s: 1, f: 0 }, { s: 1, f: 2 }],
        "minor_penta": [{ s: 6, f: 1 }, { s: 6, f: 3 }, { s: 5, f: 0 }, { s: 5, f: 3 }, { s: 4, f: 0, r: true }, { s: 4, f: 3 }, { s: 3, f: 0 }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 2, f: 3 }, { s: 1, f: 1 }, { s: 1, f: 3 }],
        "blues": [{ s: 6, f: 1 }, { s: 6, f: 3 }, { s: 6, f: 4 }, { s: 5, f: 0 }, { s: 5, f: 3 }, { s: 4, f: 0, r: true }, { s: 4, f: 3 }, { s: 3, f: 0 }, { s: 3, f: 1 }, { s: 3, f: 2 }, { s: 2, f: 1 }, { s: 2, f: 3 }, { s: 1, f: 1 }, { s: 1, f: 3 }]
    },
    "A": {
        "major_penta": [{ s: 5, f: 0, r: true }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 4, f: 2 }, { s: 3, f: 1 }, { s: 3, f: 2 }, { s: 2, f: 0 }, { s: 2, f: 2 }],
        "minor_penta": [{ s: 6, f: 5, r: true }, { s: 6, f: 8 }, { s: 5, f: 5 }, { s: 5, f: 7 }, { s: 4, f: 5 }, { s: 4, f: 7 }, { s: 3, f: 5 }, { s: 3, f: 7 }, { s: 2, f: 5 }, { s: 2, f: 8 }, { s: 1, f: 5 }, { s: 1, f: 8 }],
        "blues": [{ s: 6, f: 5, r: true }, { s: 6, f: 8 }, { s: 5, f: 5 }, { s: 5, f: 6 }, { s: 5, f: 7 }, { s: 4, f: 5 }, { s: 4, f: 7 }, { s: 3, f: 5 }, { s: 3, f: 7 }, { s: 3, f: 8 }, { s: 2, f: 5 }, { s: 1, f: 5 }]
    },
    "E": {
        "major_penta": [{ s: 6, f: 0, r: true }, { s: 6, f: 2 }, { s: 5, f: 0 }, { s: 5, f: 2 }, { s: 4, f: 1 }, { s: 4, f: 2 }, { s: 3, f: 1 }],
        "minor_penta": [{ s: 6, f: 0, r: true }, { s: 6, f: 3 }, { s: 5, f: 0 }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 4, f: 2 }, { s: 3, f: 0 }, { s: 3, f: 2 }, { s: 2, f: 0 }, { s: 2, f: 3 }, { s: 1, f: 0 }, { s: 1, f: 3 }],
        "blues": [{ s: 6, f: 0, r: true }, { s: 6, f: 3 }, { s: 5, f: 0 }, { s: 5, f: 1 }, { s: 5, f: 2 }, { s: 4, f: 0 }, { s: 4, f: 2 }, { s: 3, f: 0 }, { s: 3, f: 2 }, { s: 3, f: 3 }, { s: 2, f: 0 }, { s: 1, f: 0 }]
    }
};

const chordRoot = document.getElementById('chord-root');
const chordType = document.getElementById('chord-type');
const chordFretthick = document.getElementById('chord-fretboard-thick');
const chordFretthin = document.getElementById('chord-fretboard-thin');

const scaleRoot = document.getElementById('scale-root');
const scaleType = document.getElementById('scale-type');
const scaleFretthick = document.getElementById('scale-fretboard-thick');
const scaleFretthin = document.getElementById('scale-fretboard-thin');

function initLibraries() {
    if (!chordRoot || !scaleRoot) return;
    [chordRoot, chordType].forEach(el => el.onchange = renderSelectedChord);
    [scaleRoot, scaleType].forEach(el => el.onchange = renderSelectedScale);
    renderSelectedChord();
    renderSelectedScale();
}

function renderSelectedChord() {
    const root = chordRoot.value;
    const type = chordType.value;
    const data = (GUITAR_CHORDS[root] && GUITAR_CHORDS[root][type]) || { name: `${root} ${type}`, notes: "-", positions: [] };
    document.getElementById('chord-name').textContent = data.name;
    document.getElementById('chord-notes').textContent = data.notes;

    // Draw Both (v2.4)
    drawFretboard(chordFretthick, data.positions, true);  // Inverted (6th on top)
    drawFretboard(chordFretthin, data.positions, false); // Standard (1st on top)
}

function renderSelectedScale() {
    const root = scaleRoot.value;
    const type = scaleType.value;
    const positions = (GUITAR_SCALES[root] && GUITAR_SCALES[root][type]) || [];

    // Draw Both (v2.4)
    drawFretboard(scaleFretthick, positions, true);  // Inverted (6th on top)
    drawFretboard(scaleFretthin, positions, false); // Standard (1st on top)
}

function drawFretboard(container, positions, invertedStrings) {
    container.innerHTML = "";
    // Visual Scale (Nut is 0.4 units, Frets are 1.0 unit each)
    const nutWidth = 0.4;
    const totalUnits = nutWidth + 12;
    const unitWidth = 100 / totalUnits;

    // Create 12 frets
    for (let i = 0; i < 13; i++) {
        const fret = document.createElement('div');
        fret.className = 'fret';
        if (i === 0) fret.style.flex = nutWidth;
        if ([3, 5, 7, 9, 12].includes(i)) {
            const dot = document.createElement('div');
            dot.className = `fret-dot ${i === 12 ? 'double' : ''}`;
            fret.appendChild(dot);
        }
        container.appendChild(fret);
    }

    const stringHeight = 100 / 6;
    for (let s = 1; s <= 6; s++) {
        const string = document.createElement('div');
        string.className = `guitar-string string-gauge-${s}`;

        let top;
        if (invertedStrings) {
            top = ((7 - s) * stringHeight) - (stringHeight / 2);
        } else {
            top = (s * stringHeight) - (stringHeight / 2);
        }

        string.style.top = `${top}%`;
        container.appendChild(string);
    }

    positions.forEach(pos => {
        const marker = document.createElement('div');
        marker.className = `note-marker ${pos.r ? 'root' : ''}`;

        // Exact Positioning: center in the "field" (between metal frets)
        let left;
        if (pos.f === 0) {
            // Center on nut
            left = (nutWidth * unitWidth) / 2;
        } else {
            // Nut + (Full frets before) + half of current fret
            left = (nutWidth * unitWidth) + ((pos.f - 1) * unitWidth) + (unitWidth / 2);
        }

        let top;
        if (invertedStrings) {
            top = ((7 - pos.s) * stringHeight) - (stringHeight / 2);
        } else {
            top = (pos.s * stringHeight) - (stringHeight / 2);
        }

        marker.style.left = `${left}%`;
        marker.style.top = `${top}%`;

        // Add Note Name (Standard EADGBE)
        const stringBaseNotes = { 1: 4, 2: 11, 3: 7, 4: 2, 5: 9, 6: 4 }; // E, B, G, D, A, E
        const noteIndex = (stringBaseNotes[pos.s] + pos.f) % 12;
        marker.textContent = NOTE_NAMES[noteIndex];

        container.appendChild(marker);
    });
}

initLibraries();

function getNoteFromFreq(freq) {
    const semitones = 12 * (Math.log2(freq / 440));
    const noteNum = Math.round(semitones) + 69;
    if (noteNum < 0) return { name: "--", cents: 0 };
    const name = NOTE_NAMES[noteNum % 12];
    const cents = (semitones - Math.round(semitones)) * 100;
    return { name, cents };
}
