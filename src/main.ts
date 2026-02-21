import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import GUI from 'lil-gui';

const BASE = import.meta.env.BASE_URL;

// --- GAME PARAMETERS ---
const SPAWN_POINT = new THREE.Vector3(0, 0, -800);

const PARAMS = {
    windSpeed: 1.18,
    waterColor: '#004466',
    foamColor: '#ffffff',
    sunElevation: 85,
    sunAzimuth: 180,
    turbidity: 40,
    rayleigh: 0.12,
    mieCoefficient: 0.005,
    mieDirectionalG: 0.8,
    fogColor: '#d6edff',
    fogDensity: 0.002,
    ambientIntensity: 0.05,
    hemiIntensity: 20.0,
    dirIntensity: 0.5,  
    showWireframe: false,
    selectedFoil: 'High Aspect Race',
    chaseCamera: true,
};

// --- FOIL CONFIGURATION ---
interface FoilConfig {
    name: string;
    wingSpan: number;       // meters
    wingArea: number;       // m^2
    chord: number;          // meters (avg chord = area / span)
    aspectRatio: number;    // span^2 / area
    stallSpeed: number;     // m/s, below this lift collapses
    maxLiftCoeff: number;   // CL at full speed
    baseDragCoeff: number;  // CD_0
    turnRateMax: number;    // rad/s, inversely proportional to span
}

const FOIL_PRESETS: Record<string, FoilConfig> = {
    'High Aspect Race': {
        name: 'High Aspect Race',
        wingSpan: 1.0,
        wingArea: 0.08,       // 800 cm^2
        chord: 0.08,
        aspectRatio: 12.5,
        stallSpeed: 7.0,
        maxLiftCoeff: 0.5,
        baseDragCoeff: 0.01,
        turnRateMax: 2,
    },
    'Mid Aspect Cruise': {
        name: 'Mid Aspect Cruise',
        wingSpan: 1.2,
        wingArea: 0.234,      // ~2340 cm^2
        chord: 0.195,
        aspectRatio: 6.15,
        stallSpeed: 4.0,
        maxLiftCoeff: 0.5,
        baseDragCoeff: 0.012,
        turnRateMax: 0.6,
    },
};

let activeFoil: FoilConfig = { ...FOIL_PRESETS['High Aspect Race'] };

// --- RACE CONFIGURATION ---
const RACE_LENGTH_KM = 1; // total race distance — adjust to change level length
const RACE_START_Z = SPAWN_POINT.z; // player starts here; race km marks are at RACE_START_Z + k*1000

// Returns how far the player has travelled directly downwind (Z-axis progress).
// This aligns with the physical buoy/gate positions and is used for all race logic.
// distanceTravelled (total path length) is kept separately for display.
function downwindDist(): number {
    return Math.max(0, foilState.position.z - RACE_START_Z);
}

// --- PHYSICS CONSTANTS ---
// Gravitational acceleration — scales lift-to-weight ratio and wave slope energy
const GRAVITY = 9.81;
// Seawater density (kg/m³) — multiplier in all lift and drag force calculations
const RHO_WATER = 1025;
// Rider + gear mass (kg) — heavier means slower acceleration but harder to destabilize
const RIDER_MASS = 80;
// Foil mast length (m) — caps maximum ride height above the water surface
const MAST_LENGTH = 0.8;
// Mast frontal area for drag (m²) — higher = more speed bleed from the submerged mast
const MAST_DRAG_AREA = 0.0015;
// Velocity kick (m/s) added per pump — higher = bigger speed burst each pump
const PUMP_IMPULSE = 2.5;
// Energy spent per pump — higher = fewer pumps before you're drained
const PUMP_COST = 20;
// Minimum seconds between pumps — prevents spam-pumping for free speed
const PUMP_COOLDOWN = 0.35;
// Energy recovered per second — controls how quickly you can pump again
const ENERGY_REGEN = 5;
// Max bank angle (~30°) — limits how hard you can lean into turns
const MAX_ROLL = Math.PI / 6;
// Max pitch angle (~5°) — controls nose-up/down bias that shifts target ride height
const MAX_PITCH = Math.PI / 36;
// Roll spring stiffness — higher = snappier response to turn input
const ROLL_SPRING = 6.0;
// Roll damping — higher = less oscillation, smoother settling into turns
const ROLL_DAMPING = 3.0;
// Wave-induced roll strength — higher = more wobble from uneven wave surface across the wing
const WAVE_TORQUE_GAIN = 2.0;
// Ride height spring stiffness — higher = faster height correction toward lift-based target
const HEIGHT_SPRING = 8.0;
// Ride height damping — higher = less vertical bounce, more stable foiling altitude
const HEIGHT_DAMPING = 8.0;
// Wave slope energy multiplier — higher = more speed gained from riding down wave faces
const WAVE_ENERGY_MULT = 2.5;
// Sideways slip decay rate — higher = tighter tracking along heading, less drift in turns
const LATERAL_RESISTANCE = 1.0;

// --- PHYSICS STATE ---
const foilState = {
    position: SPAWN_POINT.clone(),
    velocity: new THREE.Vector3(0, 0, 0),
    heading: 0,
    pitch: 0,
    roll: 0,
    rollRate: 0,
    rideHeight: 0.35,
    rideHeightVel: 0,
    onFoil: true,
    energy: 100,
    speed: 0,
    lastPumpTime: -10,
    distanceTravelled: 0,
};

type GameState = 'starting' | 'riding' | 'crashed';
let gameState: GameState = 'starting';

// --- RACE STATE ---
interface RaceData {
    active: boolean;
    finished: boolean;
    startTime: number;
    kmSplitTimes: number[]; // elapsed seconds when each km was reached
    lastKmReached: number;
    totalElapsed: number;
    splitFlashText: string;
    splitFlashTimer: number;
}

const race: RaceData = {
    active: false,
    finished: false,
    startTime: 0,
    kmSplitTimes: [],
    lastKmReached: 0,
    totalElapsed: 0,
    splitFlashText: '',
    splitFlashTimer: 0,
};

function resetRace() {
    race.active = false;
    race.finished = false;
    race.startTime = 0;
    race.kmSplitTimes = [];
    race.lastKmReached = 0;
    race.totalElapsed = 0;
    race.splitFlashText = '';
    race.splitFlashTimer = 0;
}

function startRace(clockTime: number) {
    race.active = true;
    race.finished = false;
    race.startTime = clockTime;
    race.kmSplitTimes = [];
    race.lastKmReached = 0;
    race.totalElapsed = 0;
    race.splitFlashText = '';
    race.splitFlashTimer = 0;
}

function fmtTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// --- HIGH SCORES (localStorage) ---
const HIGH_SCORE_MAX = 3;

interface HighScoreEntry {
    time: number;
    date: string; // ISO date string
}

function highScoreKey(km: number): string {
    return `downwind-highscores-${km}km`;
}

function loadHighScores(km: number): HighScoreEntry[] {
    try {
        const raw = localStorage.getItem(highScoreKey(km));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((e: any) => typeof e.time === 'number' && typeof e.date === 'string')
            .sort((a: HighScoreEntry, b: HighScoreEntry) => a.time - b.time)
            .slice(0, HIGH_SCORE_MAX);
    } catch {
        return [];
    }
}

function saveHighScore(km: number, time: number): { rank: number; isNew: boolean } {
    const scores = loadHighScores(km);
    const entry: HighScoreEntry = { time, date: new Date().toISOString() };
    scores.push(entry);
    scores.sort((a, b) => a.time - b.time);
    const rank = scores.findIndex(e => e === entry) + 1;
    const trimmed = scores.slice(0, HIGH_SCORE_MAX);
    const isNew = rank <= HIGH_SCORE_MAX;
    try {
        localStorage.setItem(highScoreKey(km), JSON.stringify(trimmed));
    } catch { /* quota exceeded — silently ignore */ }
    return { rank, isNew };
}

// --- INPUT STATE ---
const input = {
    left: false,
    right: false,
    up: false,
    down: false,
    pump: false,
};

let useChaseCamera = PARAMS.chaseCamera;

// --- HELPER FUNCTIONS ---
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

function headingToDir(heading: number): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
}

function resetFoilState() {
    foilState.position.copy(SPAWN_POINT);
    foilState.velocity.set(0, 0, 0);
    foilState.heading = 0;
    foilState.pitch = 0;
    foilState.roll = 0;
    foilState.rollRate = 0;
    foilState.rideHeight = 0.35;
    foilState.rideHeightVel = 0;
    foilState.onFoil = true;
    foilState.energy = 100;
    foilState.speed = 0;
    foilState.lastPumpTime = -10;
    foilState.distanceTravelled = 0;
    gameState = 'starting';
    prevGameState = null;
    clearWakeTrail();
    clearBubbles();
    resetRace();
    hideFinishOverlay();
    // Reset the lateral tracking so the course re-centres on X=0
    raceTrackX = 0;
    finishGate.position.x = 0;
}

function launchFoil() {
    const initialSpeed = activeFoil.stallSpeed * 1.5;
    const dir = headingToDir(foilState.heading);
    foilState.velocity.copy(dir.multiplyScalar(initialSpeed));
    foilState.rideHeight = 0.35;
    foilState.onFoil = true;
    gameState = 'riding';
}


// Define 4 waves to simulate downwind bumps (mostly moving +Z)
const waveConfig = [
    { dir: new THREE.Vector2(0.2, 0.9), steepness: 0.15, wavelength: 40.0, speed: 1.2 },
    { dir: new THREE.Vector2(-0.1, 0.95), steepness: 0.1, wavelength: 25.0, speed: 1.1 },
    { dir: new THREE.Vector2(0.3, 0.8), steepness: 0.08, wavelength: 15.0, speed: 1.3 },
    { dir: new THREE.Vector2(-0.2, 0.9), steepness: 0.05, wavelength: 8.0, speed: 1.5 }
];

// --- THREE.JS SETUP ---
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
// renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
//scene.background = new THREE.Color('#87ceeb');
scene.fog = new THREE.FogExp2(PARAMS.fogColor, PARAMS.fogDensity);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
camera.position.set(SPAWN_POINT.x, 30, SPAWN_POINT.z - 50);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(SPAWN_POINT);
controls.maxPolarAngle = Math.PI / 2 - 0.05;

// --- LIGHTING & ENVIRONMENT ---
const ambientLight = new THREE.AmbientLight(0xffffff, PARAMS.ambientIntensity);
scene.add(ambientLight);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x000000, PARAMS.hemiIntensity);
hemiLight.position.set(30, 200, 20);
scene.add(hemiLight);

const dirLight = new THREE.DirectionalLight(0xffeedd, PARAMS.dirIntensity);
dirLight.castShadow = false;
scene.add(dirLight);
scene.add(dirLight.target);

const sky = new Sky();
sky.scale.setScalar(10000);
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms['turbidity'].value = PARAMS.turbidity;
skyUniforms['rayleigh'].value = PARAMS.rayleigh;
skyUniforms['mieCoefficient'].value = PARAMS.mieCoefficient;
skyUniforms['mieDirectionalG'].value = PARAMS.mieDirectionalG;

const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();

let renderTarget: THREE.WebGLRenderTarget | null = null;
const sunDirection = new THREE.Vector3();

function updateEnvironment() {
    const phi = THREE.MathUtils.degToRad(90 - PARAMS.sunElevation);
    const theta = THREE.MathUtils.degToRad(PARAMS.sunAzimuth);

    sunDirection.setFromSphericalCoords(1, phi, theta);

    skyUniforms['sunPosition'].value.copy(sunDirection);
    skyUniforms['turbidity'].value = PARAMS.turbidity;
    skyUniforms['rayleigh'].value = PARAMS.rayleigh;
    skyUniforms['mieCoefficient'].value = PARAMS.mieCoefficient;
    skyUniforms['mieDirectionalG'].value = PARAMS.mieDirectionalG;

    (scene.fog as THREE.FogExp2).color.set(PARAMS.fogColor);
    (scene.fog as THREE.FogExp2).density = PARAMS.fogDensity;

    if (renderTarget) renderTarget.dispose();
    renderTarget = pmremGenerator.fromScene(sky as any);
    scene.environment = renderTarget.texture;
}

updateEnvironment();

// --- WATER SHADER ---
const waterGeometry = new THREE.PlaneGeometry(1500, 2000, 512, 512);
waterGeometry.rotateX(-Math.PI / 2);

const waterMaterial = new THREE.MeshStandardMaterial({
    color: PARAMS.waterColor,
    roughness: 0.05,
    metalness: 0.9,
    wireframe: PARAMS.showWireframe,
    side: THREE.DoubleSide
});

const waterUniforms = {
    uTime: { value: 0 },
    uWindSpeed: { value: PARAMS.windSpeed },
    uWorldOffset: { value: new THREE.Vector2(0, 0) },
};

waterMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.uniforms.uWindSpeed = waterUniforms.uWindSpeed;
    shader.uniforms.uWorldOffset = waterUniforms.uWorldOffset;

    shader.vertexShader = `
        uniform float uTime;
        uniform float uWindSpeed;
        uniform vec2 uWorldOffset;

        varying vec3 vGridPos;
        varying vec3 vViewTangent;
        varying vec3 vViewBinormal;

        struct Wave {
            vec2 dir;
            float steepness;
            float wavelength;
            float speed;
        };

        Wave waves[4];

        vec3 gerstnerWave(Wave w, vec3 p, inout vec3 tangent, inout vec3 binormal) {
            float k = 2.0 * 3.14159 / w.wavelength;
            float c = sqrt(9.8 / k) * w.speed * uWindSpeed;
            float d = dot(w.dir, p.xz);
            float f = k * (d - c * uTime);
            float effectiveSteepness = w.steepness * uWindSpeed * uWindSpeed;
            float a = effectiveSteepness / k;

            tangent += vec3(
                -w.dir.x * w.dir.x * effectiveSteepness * sin(f),
                w.dir.x * effectiveSteepness * cos(f),
                -w.dir.x * w.dir.y * effectiveSteepness * sin(f)
            );

            binormal += vec3(
                -w.dir.x * w.dir.y * effectiveSteepness * sin(f),
                w.dir.y * effectiveSteepness * cos(f),
                -w.dir.y * w.dir.y * effectiveSteepness * sin(f)
            );

            return vec3(
                w.dir.x * a * cos(f),
                a * sin(f),
                w.dir.y * a * cos(f)
            );
        }
    ` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `
        ${waveConfig.map((w, i) => {
            const f = (v: number) => v % 1 === 0 ? v.toFixed(1) : String(v);
            return `waves[${i}] = Wave(vec2(${f(w.dir.x)}, ${f(w.dir.y)}), ${f(w.steepness)}, ${f(w.wavelength)}, ${f(w.speed)});`;
        }).join('\n        ')}

        // Use world-space position so waves stay fixed in the world
        // even when the water mesh is moved to follow the player
        vec3 gridPoint = position + vec3(uWorldOffset.x, 0.0, uWorldOffset.y);
        vec3 waveTangent = vec3(1.0, 0.0, 0.0);
        vec3 waveBinormal = vec3(0.0, 0.0, 1.0);
        vec3 p = gridPoint;

        p += gerstnerWave(waves[0], gridPoint, waveTangent, waveBinormal);
        p += gerstnerWave(waves[1], gridPoint, waveTangent, waveBinormal);
        p += gerstnerWave(waves[2], gridPoint, waveTangent, waveBinormal);
        p += gerstnerWave(waves[3], gridPoint, waveTangent, waveBinormal);

        vec3 objectNormal = normalize(cross(waveBinormal, waveTangent));
        // Convert displaced world position back to object space
        vec3 displacedPosition = p - vec3(uWorldOffset.x, 0.0, uWorldOffset.y);

        vGridPos = gridPoint; // world-space for ripple UVs
        vViewTangent = normalize(normalMatrix * waveTangent);
        vViewBinormal = normalize(normalMatrix * waveBinormal);
        `
    );

    shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `
        vec3 transformed = displacedPosition;
        `
    );

    shader.fragmentShader = `
        uniform float uTime;
        uniform float uWindSpeed;

        varying vec3 vGridPos;
        varying vec3 vViewTangent;
        varying vec3 vViewBinormal;

        vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }

        float snoise(vec2 v) {
            const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                                -0.577350269189626, 0.024390243902439);
            vec2 i  = floor(v + dot(v, C.yy));
            vec2 x0 = v -   i + dot(i, C.xx);
            vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
            vec4 x12 = x0.xyxy + C.xxzz;
            x12.xy -= i1;
            i = mod(i, 289.0);
            vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
            vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
            m = m*m;
            m = m*m;
            vec3 x = 2.0 * fract(p * C.www) - 1.0;
            vec3 h = abs(x) - 0.5;
            vec3 ox = floor(x + 0.5);
            vec3 a0 = x - ox;
            m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
            vec3 g;
            g.x  = a0.x  * x0.x  + h.x  * x0.y;
            g.yz = a0.yz * x12.xz + h.yz * x12.yw;
            return 130.0 * dot(m, g);
        }

        float fbm(vec2 p) {
            float f = 0.0;
            f += 0.5000 * snoise(p); p *= 2.02;
            f += 0.2500 * snoise(p); p *= 2.03;
            f += 0.1250 * snoise(p); p *= 2.01;
            f += 0.0625 * snoise(p);
            return f;
        }
    ` + shader.fragmentShader;

    const fwidth_shader = `
        #include <normal_fragment_begin>

        float rippleTime = uTime * 1.05;
        vec2 rippleUv = vGridPos.xz * 0.4 - vec2(0.1, 0.8) * rippleTime;

        float ripplePx = length(fwidth(rippleUv));
        float rippleFade = 1.0 / (1.0 + ripplePx * 2.0);

        float eps = 0.01;
        float n0 = fbm(rippleUv);
        float nx = fbm(rippleUv + vec2(eps, 0.0));
        float nz = fbm(rippleUv + vec2(0.0, eps));

        float rAmp = 0.12 * uWindSpeed * rippleFade;
        float ddx_r = (nx - n0) / eps * 0.4 * rAmp;
        float ddz_r = (nz - n0) / eps * 0.4 * rAmp;

        vec2 microUv = vGridPos.xz * 1.8 - vec2(0.15, 0.9) * rippleTime * 1.2;

        float microPx = length(fwidth(microUv));
        float microFade = 1.0 / (1.0 + microPx * 15.0);

        float m0 = fbm(microUv);
        float mx = fbm(microUv + vec2(eps, 0.0));
        float mz = fbm(microUv + vec2(0.0, eps));

        float mAmp = 0.03 * uWindSpeed * microFade;
        ddx_r += (mx - m0) / eps * 1.8 * mAmp;
        ddz_r += (mz - m0) / eps * 1.8 * mAmp;

        normal = normalize(normal - ddx_r * vViewTangent - ddz_r * vViewBinormal);
    `;

    // const msaa_shader = `
    //     #include <normal_fragment_begin>

    //     float rippleTime = uTime * 1.05;
    //     vec2 rippleUv = vGridPos.xz * 0.4 - vec2(0.1, 0.8) * rippleTime;
    //     vec2 microUv  = vGridPos.xz * 1.8 - vec2(0.15, 0.9) * rippleTime * 1.2;

    //     vec2 dRipple_dx = dFdx(rippleUv);
    //     vec2 dRipple_dy = dFdy(rippleUv);
    //     vec2 dMicro_dx  = dFdx(microUv);
    //     vec2 dMicro_dy  = dFdy(microUv);

    //     float rAmp = 0.12 * uWindSpeed;
    //     float mAmp = 0.03 * uWindSpeed;
    //     float eps  = 0.01;

    //     float ddx_r = 0.0;
    //     float ddz_r = 0.0;

    //     vec2 ssOff0 = vec2(-0.125, -0.375);
    //     vec2 ssOff1 = vec2( 0.375, -0.125);
    //     vec2 ssOff2 = vec2(-0.375,  0.125);
    //     vec2 ssOff3 = vec2( 0.125,  0.375);

    //     for (int s = 0; s < 4; s++) {
    //         vec2 jit = (s == 0) ? ssOff0 : (s == 1) ? ssOff1 : (s == 2) ? ssOff2 : ssOff3;

    //         vec2 rUv = rippleUv + jit.x * dRipple_dx + jit.y * dRipple_dy;
    //         float rn0 = fbm(rUv);
    //         float rnx = fbm(rUv + vec2(eps, 0.0));
    //         float rnz = fbm(rUv + vec2(0.0, eps));
    //         ddx_r += (rnx - rn0) / eps * 0.4 * rAmp;
    //         ddz_r += (rnz - rn0) / eps * 0.4 * rAmp;

    //         vec2 mUv = microUv + jit.x * dMicro_dx + jit.y * dMicro_dy;
    //         float mn0 = fbm(mUv);
    //         float mnx = fbm(mUv + vec2(eps, 0.0));
    //         float mnz = fbm(mUv + vec2(0.0, eps));
    //         ddx_r += (mnx - mn0) / eps * 1.8 * mAmp;
    //         ddz_r += (mnz - mn0) / eps * 1.8 * mAmp;
    //     }

    //     ddx_r *= 0.25;
    //     ddz_r *= 0.25;

    //     normal = normalize(normal - ddx_r * vViewTangent - ddz_r * vViewBinormal);
    // `;

    shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        fwidth_shader
    );
};

const waterMesh = new THREE.Mesh(waterGeometry, waterMaterial);
waterMesh.receiveShadow = false;
scene.add(waterMesh);


// --- CPU WAVE LOGIC (FOR FOIL PHYSICS) ---
function getWaterDisplacement(x: number, z: number, time: number, windSpeed: number) {
    const p = new THREE.Vector3(x, 0, z);
    const tangent = new THREE.Vector3(1, 0, 0);
    const binormal = new THREE.Vector3(0, 0, 1);

    for (const w of waveConfig) {
        const k = 2.0 * Math.PI / w.wavelength;
        const c = Math.sqrt(9.8 / k) * w.speed * windSpeed;
        const d = w.dir.x * x + w.dir.y * z;
        const f = k * (d - c * time);
        const effectiveSteepness = w.steepness * windSpeed * windSpeed;
        const a = effectiveSteepness / k;

        p.x += w.dir.x * a * Math.cos(f);
        p.y += a * Math.sin(f);
        p.z += w.dir.y * a * Math.cos(f);

        tangent.x -= w.dir.x * w.dir.x * effectiveSteepness * Math.sin(f);
        tangent.y += w.dir.x * effectiveSteepness * Math.cos(f);
        tangent.z -= w.dir.x * w.dir.y * effectiveSteepness * Math.sin(f);

        binormal.x -= w.dir.x * w.dir.y * effectiveSteepness * Math.sin(f);
        binormal.y += w.dir.y * effectiveSteepness * Math.cos(f);
        binormal.z -= w.dir.y * w.dir.y * effectiveSteepness * Math.sin(f);
    }

    const normal = new THREE.Vector3().crossVectors(binormal, tangent).normalize();
    return { position: p, normal };
}

function getSurfaceInfoAtWorldPos(worldX: number, worldZ: number, time: number, windSpeed: number) {
    let testX = worldX;
    let testZ = worldZ;
    let info = getWaterDisplacement(testX, testZ, time, windSpeed);

    for (let i = 0; i < 3; i++) {
        const errX = worldX - info.position.x;
        const errZ = worldZ - info.position.z;
        testX += errX;
        testZ += errZ;
        info = getWaterDisplacement(testX, testZ, time, windSpeed);
    }
    return info;
}


// --- WAVE SAMPLING (multi-point across wing span) ---
function sampleWaveAtFoilPoints(time: number, windSpeed: number) {
    const dir = headingToDir(foilState.heading);
    const right = new THREE.Vector3(dir.z, 0, -dir.x);
    const halfSpan = activeFoil.wingSpan / 2;

    const cx = foilState.position.x;
    const cz = foilState.position.z;

    const center = getSurfaceInfoAtWorldPos(cx, cz, time, windSpeed);
    const leftTip = getSurfaceInfoAtWorldPos(
        cx - right.x * halfSpan,
        cz - right.z * halfSpan,
        time, windSpeed
    );
    const rightTip = getSurfaceInfoAtWorldPos(
        cx + right.x * halfSpan,
        cz + right.z * halfSpan,
        time, windSpeed
    );

    const n = center.normal;
    const ny = Math.max(n.y, 0.01);
    const gradient = new THREE.Vector2(-n.x / ny, -n.z / ny);

    return { center, leftTip, rightTip, gradient };
}


// --- FOIL BOARD (OBJ model) ---
const boardGroup = new THREE.Group();
scene.add(boardGroup);

const mtlLoader = new MTLLoader();
mtlLoader.setPath(BASE);
    mtlLoader.load('board.mtl', (materials) => {
    materials.preload();
    const objLoader = new OBJLoader();
    objLoader.setMaterials(materials);
    objLoader.setPath(BASE);
    objLoader.load('board.obj', (obj) => {
        const boardMat = new THREE.MeshStandardMaterial({
            color: '#1a1a1a',
            roughness: 0.35,
            metalness: 0.0,
        });
        obj.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                const mesh = child as THREE.Mesh;
                mesh.material = boardMat;
                mesh.geometry.computeVertexNormals();
                mesh.castShadow = false;
                mesh.receiveShadow = false;
            }
        });
        boardGroup.add(obj);
    });
});


// --- RIDER (FBX from Mixamo) ---
let riderMixer: THREE.AnimationMixer | null = null;
const riderActions: Record<string, THREE.AnimationAction> = {};
let activeAction: THREE.AnimationAction | null = null;
let prevGameState: GameState | null = null;

const RIDER_SCALE = 0.023;
const RIDER_OFFSET = new THREE.Vector3(0, 0.15, 0);
const SITTING_Y_OFFSET = -1.1;

//let riderHips: THREE.Bone | null = null;
let riderModel: THREE.Group | null = null;
let currentAnimName = '';
let pumpPlaying = false;

const PUMP_ANIM_DURATION_MS = 250;

function crossfadeTo(name: string, duration = 0.4) {
    const next = riderActions[name];
    if (!next || next === activeAction) return;
    if (name === 'pump') return; // pump uses triggerPumpAnim
    next.reset().setEffectiveWeight(1).fadeIn(duration).play();
    activeAction?.fadeOut(duration);
    activeAction = next;
    currentAnimName = name;
}

function triggerPumpAnim() {
    const pump = riderActions['pump'];
    if (!pump || !riderMixer) return;

    pumpPlaying = true;

    pump.reset();
    pump.setLoop(THREE.LoopOnce, 1);
    pump.clampWhenFinished = false;
    pump.setEffectiveWeight(1);

    const clipDuration = pump.getClip().duration;
    const desiredSec = PUMP_ANIM_DURATION_MS / 1000;
    pump.setEffectiveTimeScale(clipDuration / desiredSec);

    pump.fadeIn(0.08).play();
    activeAction?.fadeOut(0.08);

    const prevAction = activeAction;
    const prevName = currentAnimName;
    activeAction = pump;
    currentAnimName = 'pump';

    const onFinished = (e: { action: THREE.AnimationAction }) => {
        if (e.action !== pump) return;
        riderMixer!.removeEventListener('finished', onFinished);
        pumpPlaying = false;

        const returnTo = prevAction ?? riderActions['surfing'];
        if (returnTo) {
            returnTo.reset().setEffectiveWeight(1).fadeIn(0.15).play();
            pump.fadeOut(0.15);
            activeAction = returnTo;
            currentAnimName = prevName || 'surfing';
        }
    };
    riderMixer.addEventListener('finished', onFinished);
}

{
    const fbxLoader = new FBXLoader();
    fbxLoader.load(`${BASE}surfing-skinned.fbx`, (fbx) => {
        fbx.scale.setScalar(RIDER_SCALE);
        fbx.position.copy(RIDER_OFFSET);

        fbx.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
                (child as THREE.Mesh).castShadow = false;
                (child as THREE.Mesh).receiveShadow = false;
            }
            if ((child as THREE.Bone).isBone) {
                //console.log('Bone:', child.name);
                if (child.name.toLowerCase().includes('hips')) {
                    //riderHips = child as THREE.Bone;
                }
            }
        });
        
        riderModel = fbx;
        boardGroup.add(fbx);    

        riderMixer = new THREE.AnimationMixer(fbx);

        if (fbx.animations.length > 0) {
            const clip = fbx.animations[0];
            clip.name = 'surfing';
            riderActions['surfing'] = riderMixer.clipAction(clip);
        }

        fbxLoader.load(`${BASE}sitting.fbx`, (sitFbx) => {
            if (sitFbx.animations.length > 0) {
                const clip = sitFbx.animations[0];
                clip.name = 'sitting';
                riderActions['sitting'] = riderMixer!.clipAction(clip);
            }

            fbxLoader.load(`${BASE}pump.fbx`, (pumpFbx) => {
                if (pumpFbx.animations.length > 0) {
                    const clip = pumpFbx.animations[0];
                    clip.name = 'pump';
                    riderActions['pump'] = riderMixer!.clipAction(clip);
                    riderActions['pump'].setLoop(THREE.LoopOnce, 1);
                    riderActions['pump'].clampWhenFinished = false;
                }

                if (riderActions['sitting']) {
                    riderActions['sitting'].play();
                    activeAction = riderActions['sitting'];
                    currentAnimName = 'sitting';
                } else if (riderActions['surfing']) {
                    riderActions['surfing'].play();
                    activeAction = riderActions['surfing'];
                    currentAnimName = 'surfing';
                }
            });
        });
    });
}

function updateRiderAnimation() {
    if (gameState === prevGameState) return;
    prevGameState = gameState;

    if (pumpPlaying && gameState === 'riding') return;

    switch (gameState) {
        case 'starting':
            pumpPlaying = false;
            crossfadeTo('sitting');
            break;
        case 'riding':
            crossfadeTo('surfing');
            break;
        case 'crashed':
            pumpPlaying = false;
            crossfadeTo('sitting', 0.8);
            break;
    }
}

// --- HUD (elements defined in index.html, styled in style.css) ---
const hudSpeed = document.querySelector('#hud-speed') as HTMLElement;
const hudSpeedFill = document.querySelector('#speed-bar-fill') as HTMLElement;

const SPEED_BAR_MAX_KTS = 30;

function speedColor(knots: number): string {
    const t = Math.min(knots / SPEED_BAR_MAX_KTS, 1);
    if (t < 0.33) {
        const p = t / 0.33;
        const r = Math.round(239 + (255 - 239) * p);
        const g = Math.round(83 + (167 - 83) * p);
        const b = Math.round(80 + (38 - 80) * p);
        return `rgb(${r},${g},${b})`;
    } else if (t < 0.66) {
        const p = (t - 0.33) / 0.33;
        const r = Math.round(255 - (255 - 139) * p);
        const g = Math.round(167 + (195 - 167) * p);
        const b = Math.round(38 + (74 - 38) * p);
        return `rgb(${r},${g},${b})`;
    } else {
        const p = (t - 0.66) / 0.34;
        const r = Math.round(139 - (139 - 76) * p);
        const g = Math.round(195 + (175 - 195) * p);
        const b = Math.round(74 + (80 - 74) * p);
        return `rgb(${r},${g},${b})`;
    }
}

const hudHeight = document.querySelector('#hud-height') as HTMLElement;
const hudHeightFill = document.querySelector('#height-bar-fill') as HTMLElement;
const hudEnergy = document.querySelector('#hud-energy') as HTMLElement;
const hudEnergyFill = document.querySelector('#energy-bar-fill') as HTMLElement;
const hudMessage = document.querySelector('#hud-message') as HTMLElement;

const distanceContainer = document.querySelector('#distance-container') as HTMLElement;
const distanceLabel = document.querySelector('#distance-label') as HTMLElement;
const distanceBarFill = document.querySelector('#distance-bar-fill') as HTMLElement;

function updateHUD() {
    const knots = foilState.speed * 1.944;
    hudSpeed.textContent = `${knots.toFixed(1)} kts`;
    const speedPct = Math.max(0, Math.min(100, (knots / SPEED_BAR_MAX_KTS) * 100));
    hudSpeedFill.style.width = `${speedPct}%`;
    hudSpeedFill.style.background = speedColor(knots);

    const heightPct = Math.max(0, Math.min(100, (foilState.rideHeight / MAST_LENGTH) * 100));
    hudHeight.textContent = `Height: ${(foilState.rideHeight * 100).toFixed(0)} cm`;
    hudHeightFill.style.width = `${heightPct}%`;
    hudHeightFill.style.background = heightPct < 20 ? '#ef5350' : '#4fc3f7';

    hudEnergy.textContent = `Energy: ${Math.round(foilState.energy)}`;
    hudEnergyFill.style.width = `${foilState.energy}%`;

    // Hide distance bar before the race; show during riding/crashed
    if (gameState === 'starting') {
        distanceContainer.style.display = 'none';
    } else {
        distanceContainer.style.display = '';
    }
    updateRaceHUD();

    if (gameState === 'starting') {
        hudMessage.textContent = 'Press SPACE to launch\n\n← → Turn  ·  ↑ ↓ Pitch  ·  SPACE Pump';
        hudMessage.style.whiteSpace = 'pre-line';
    } else if (gameState === 'crashed') {
        hudMessage.textContent = 'Off Foil!\nPress R to restart';
        hudMessage.style.whiteSpace = 'pre-line';
    } else {
        hudMessage.textContent = '';
    }
}


// --- RACE HUD ELEMENTS (defined in index.html, styled in style.css) ---
const raceTimerEl = document.querySelector('#race-timer') as HTMLElement;
const kmTickRow = document.querySelector('#km-tick-row') as HTMLElement;
const kmSplitsRow = document.querySelector('#km-splits-row') as HTMLElement;
const splitFlashEl = document.querySelector('#split-flash') as HTMLElement;
const finishOverlay = document.querySelector('#finish-overlay') as HTMLElement;

// Populate km tick marks
for (let k = 1; k <= RACE_LENGTH_KM; k++) {
    const tick = document.createElement('span');
    tick.textContent = `${k}km`;
    kmTickRow.appendChild(tick);
}

function showRaceResults() {
    const total = race.totalElapsed;
    const avgPerKm = total / RACE_LENGTH_KM;

    const { rank, isNew } = saveHighScore(RACE_LENGTH_KM, total);
    const scores = loadHighScores(RACE_LENGTH_KM);

    let html = `<div class="finish-title">RACE COMPLETE</div>`;
    if (isNew && rank === 1) {
        html += `<div class="finish-newbest">NEW BEST!</div>`;
    } else if (isNew) {
        html += `<div class="finish-newbest finish-newbest--top3">TOP ${rank}!</div>`;
    }
    html += `<div class="finish-total">Total&nbsp; <span class="finish-total-time">${fmtTime(total)}</span></div>`;
    html += `<div class="finish-splits">`;

    let prevElapsed = 0;
    for (let i = 0; i < race.kmSplitTimes.length; i++) {
        const elapsed = race.kmSplitTimes[i];
        const split = elapsed - prevElapsed;
        html += `<div class="finish-split-row">` +
            `<span class="finish-split-label">KM ${i + 1}</span>` +
            `<span class="finish-split-time">${fmtTime(split)}</span></div>`;
        prevElapsed = elapsed;
    }
    html += `</div>`;
    html += `<div class="finish-avg">Avg / km &nbsp;<span class="finish-avg-time">${fmtTime(avgPerKm)}</span></div>`;

    if (scores.length > 0) {
        html += `<div class="finish-highscores">`;
        html += `<div class="finish-highscores-title">BEST TIMES — ${RACE_LENGTH_KM} km</div>`;
        const medals = ['🥇', '🥈', '🥉'];
        for (let i = 0; i < scores.length; i++) {
            const isCurrent = scores[i].time === total && i === rank - 1;
            const rowClass = isCurrent ? 'finish-hs-row finish-hs-row--current' : 'finish-hs-row';
            html += `<div class="${rowClass}">` +
                `<span class="finish-hs-rank">${medals[i] || (i + 1)}</span>` +
                `<span class="finish-hs-time">${fmtTime(scores[i].time)}</span>` +
                `</div>`;
        }
        html += `</div>`;
    }

    html += `<div class="finish-hint">Press R to restart</div>`;

    finishOverlay.innerHTML = html;
    finishOverlay.style.display = 'block';
}

function hideFinishOverlay() {
    finishOverlay.style.display = 'none';
}

function updateRaceHUD() {
    const dwind = downwindDist();           // Z progress — drives the race bar
    const path  = foilState.distanceTravelled; // total path — shown as secondary info
    const totalRaceDist = RACE_LENGTH_KM * 1000;

    if (race.finished) {
        distanceLabel.textContent = `FINISHED — ${RACE_LENGTH_KM} km  (path ${(path / 1000).toFixed(2)} km)`;
        distanceBarFill.style.width = '100%';
        distanceBarFill.style.background = 'linear-gradient(90deg,#ffeb3b,#ff9800)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else if (race.active) {
        const racePct = Math.min(dwind / totalRaceDist, 1) * 100;
        distanceLabel.textContent =
            `${(dwind / 1000).toFixed(2)} / ${RACE_LENGTH_KM} km` +
            `  · path ${(path / 1000).toFixed(2)} km`;
        distanceBarFill.style.width = `${racePct}%`;
        distanceBarFill.style.background = 'linear-gradient(90deg,#ffeb3b,#ff9800)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else if (gameState === 'crashed' && path > 0) {
        const racePct = Math.min(dwind / totalRaceDist, 1) * 100;
        distanceLabel.textContent =
            `Crashed at ${(dwind / 1000).toFixed(2)} / ${RACE_LENGTH_KM} km` +
            `  · path ${(path / 1000).toFixed(2)} km`;
        distanceBarFill.style.width = `${racePct}%`;
        distanceBarFill.style.background = 'linear-gradient(90deg,#ef5350,#ff7043)';
        raceTimerEl.textContent = fmtTime(race.totalElapsed);
        raceTimerEl.style.display = 'block';
        kmTickRow.style.display = 'flex';
        kmSplitsRow.style.display = 'flex';
    } else {
        raceTimerEl.style.display = 'none';
        kmTickRow.style.display = 'none';
        kmSplitsRow.style.display = 'none';
    }

    // Km split badges
    kmSplitsRow.innerHTML = '';
    for (let i = 0; i < race.kmSplitTimes.length; i++) {
        const prev = i > 0 ? race.kmSplitTimes[i - 1] : 0;
        const split = race.kmSplitTimes[i] - prev;
        const badge = document.createElement('span');
        badge.className = 'km-split-badge';
        badge.textContent = `${i + 1}km ${fmtTime(split)}`;
        kmSplitsRow.appendChild(badge);
    }

    // Split flash fade
    if (race.splitFlashTimer > 0) {
        const alpha = Math.min(race.splitFlashTimer / 0.6, 1.0);
        splitFlashEl.style.opacity = String(alpha);
        splitFlashEl.textContent = race.splitFlashText;
    } else {
        splitFlashEl.style.opacity = '0';
    }
}


// --- GUI ---
const gui = new GUI();
gui.close();
gui.add(PARAMS, 'selectedFoil', Object.keys(FOIL_PRESETS)).name('Foil').onChange((v: string) => {
    activeFoil = { ...FOIL_PRESETS[v] };
});
gui.add(PARAMS, 'windSpeed', 0.1, 3.0, 0.1).name('Wind / Wave Energy');
gui.addColor(PARAMS, 'waterColor').name('Water Color').onChange((c: string) => {
    waterMaterial.color.set(c);
});
const skyFolder = gui.addFolder('Sun / Sky');
skyFolder.add(PARAMS, 'sunElevation', 0, 90, 0.1).name('Sun Elevation').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'sunAzimuth', -180, 180, 0.1).name('Sun Azimuth').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'turbidity', 0, 50, 0.1).name('Turbidity').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'rayleigh', 0, 4, 0.01).name('Rayleigh').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'mieCoefficient', 0, 0.1, 0.001).name('Mie Coefficient').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'mieDirectionalG', 0, 1, 0.01).name('Mie Directional G').onChange(updateEnvironment);
skyFolder.addColor(PARAMS, 'fogColor').name('Fog Color').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'fogDensity', 0, 0.02, 0.0005).name('Fog Density').onChange(updateEnvironment);
skyFolder.add(PARAMS, 'ambientIntensity', 0, 2, 0.01).name('Ambient Light').onChange((v: number) => {
    ambientLight.intensity = v;
});
skyFolder.add(PARAMS, 'hemiIntensity', 0, 40, 0.1).name('Hemisphere Light').onChange((v: number) => {
    hemiLight.intensity = v;
});
skyFolder.add(PARAMS, 'dirIntensity', 0, 60, 0.1).name('Directional Light').onChange((v: number) => {
    dirLight.intensity = v;
});
gui.add(PARAMS, 'showWireframe').name('Wireframe').onChange((v: boolean) => {
    waterMaterial.wireframe = v;
});
gui.add(PARAMS, 'chaseCamera').name('Chase Camera').onChange((v: boolean) => {
    useChaseCamera = v;
    controls.enabled = !v;
});

// --- PERFORMANCE STATS ---
const perfStats = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
};

const statsFolder = gui.addFolder('Performance');
statsFolder.add(perfStats, 'fps').name('FPS').listen().disable();
statsFolder.add(perfStats, 'frameMs').name('Frame (ms)').listen().disable();
statsFolder.add(perfStats, 'drawCalls').name('Draw Calls').listen().disable();
statsFolder.add(perfStats, 'triangles').name('Triangles').listen().disable();

let prevTime = performance.now();
let frameCount = 0;
let fpsAccum = 0;


// --- FOAM WAKE TRAIL ---
const WAKE_MAX_POINTS = 200;
const WAKE_WIDTH_START = 0.15;
const WAKE_WIDTH_END = 2.0;
const WAKE_MAX_AGE = 3.5;
const WAKE_EMIT_INTERVAL = 0.018;
const WAKE_Y_OFFSET = -0.01;

interface WakePoint {
    x: number; z: number;
    perpX: number; perpZ: number;
    age: number;
    speedFactor: number;
}

function getWaterHeightFast(x: number, z: number, time: number, windSpeed: number): number {
    let y = 0;
    for (const w of waveConfig) {
        const k = 2.0 * Math.PI / w.wavelength;
        const c = Math.sqrt(9.8 / k) * w.speed * windSpeed;
        const d = w.dir.x * x + w.dir.y * z;
        const f = k * (d - c * time);
        const eSteep = w.steepness * windSpeed * windSpeed;
        y += (eSteep / k) * Math.sin(f);
    }
    return y;
}

const wakePoints: WakePoint[] = [];
let lastWakeEmitTime = 0;

const wakeGeom = new THREE.BufferGeometry();
const wakePosBuf = new Float32Array(WAKE_MAX_POINTS * 2 * 3);
const wakeUvBuf = new Float32Array(WAKE_MAX_POINTS * 2 * 2);
wakeGeom.setAttribute('position', new THREE.BufferAttribute(wakePosBuf, 3));
wakeGeom.setAttribute('uv', new THREE.BufferAttribute(wakeUvBuf, 2));

const wakeIdxArr: number[] = [];
for (let i = 0; i < WAKE_MAX_POINTS - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    wakeIdxArr.push(a, c, b, b, c, d);
}
wakeGeom.setIndex(wakeIdxArr);

const wakeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,
    fragmentShader: `
        uniform float uTime;
        varying vec2 vUv;

        vec3 pm(vec3 x){ return mod(((x*34.0)+1.0)*x, 289.0); }

        float sn(vec2 v){
            const vec4 C=vec4(0.211324865405187,0.366025403784439,
                              -0.577350269189626,0.024390243902439);
            vec2 i=floor(v+dot(v,C.yy));
            vec2 x0=v-i+dot(i,C.xx);
            vec2 i1=(x0.x>x0.y)?vec2(1,0):vec2(0,1);
            vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod(i,289.0);
            vec3 p=pm(pm(i.y+vec3(0,i1.y,1))+i.x+vec3(0,i1.x,1));
            vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
            m=m*m; m=m*m;
            vec3 x3=2.*fract(p*C.www)-1.;
            vec3 h=abs(x3)-.5;
            vec3 ox=floor(x3+.5);
            vec3 a0=x3-ox;
            m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
            vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
            return 130.*dot(m,g);
        }

        void main(){
            float t = vUv.y;

            vec2 nc = vUv * vec2(1.5, 10.0) + vec2(uTime * 0.2, -uTime * 0.1);
            float n1 = sn(nc) * 0.5 + 0.5;
            float n2 = sn(nc * 2.3 + 7.0) * 0.5 + 0.5;
            float foam = smoothstep(0.1, 0.6, n1) * 0.7 + smoothstep(0.3, 0.7, n2) * 0.3;

            float cx = vUv.x * 2.0 - 1.0;
            float edgeFade = 1.0 - cx * cx;

            float ageFade = 1.0 - t;
            ageFade = ageFade * ageFade;

            float alpha = ageFade * foam * edgeFade * 0.4;
            vec3 color = mix(vec3(1.0), vec3(0.75, 0.88, 0.95), t);
            gl_FragColor = vec4(color, alpha);
        }
    `,
});

const wakeMesh = new THREE.Mesh(wakeGeom, wakeMat);
wakeMesh.frustumCulled = false;
//wakeMesh.renderOrder = 1;
scene.add(wakeMesh);

function clearWakeTrail() {
    wakePoints.length = 0;
}

const WAKE_MAST_OFFSET = -0.6;
const WAKE_MIN_SPACING_SQ = 0.15 * 0.15;

function updateWakeTrail(dt: number, time: number) {
    if (gameState === 'riding' && foilState.onFoil && foilState.speed > 1.0) {
        if (time - lastWakeEmitTime >= WAKE_EMIT_INTERVAL) {
            const dir = headingToDir(foilState.heading);
            const ex = foilState.position.x + dir.x * WAKE_MAST_OFFSET;
            const ez = foilState.position.z + dir.z * WAKE_MAST_OFFSET;

            const last = wakePoints.length > 0 ? wakePoints[wakePoints.length - 1] : null;
            const dx = ex - (last?.x ?? -Infinity);
            const dz = ez - (last?.z ?? -Infinity);
            if (dx * dx + dz * dz >= WAKE_MIN_SPACING_SQ) {
                lastWakeEmitTime = time;
                const speedNorm = Math.min(foilState.speed / 12.0, 1.0);
                wakePoints.push({
                    x: ex,
                    z: ez,
                    perpX: -dir.z,
                    perpZ: dir.x,
                    age: 0,
                    speedFactor: speedNorm,
                });
                if (wakePoints.length > WAKE_MAX_POINTS) wakePoints.shift();
            }
        }
    }

    const notFoiling = gameState !== 'riding' || !foilState.onFoil;
    const ageStep = notFoiling ? dt * 7.0 : dt;
    for (const wp of wakePoints) wp.age += ageStep;
    while (wakePoints.length > 0 && wakePoints[0].age >= WAKE_MAX_AGE) wakePoints.shift();

    const posAttr = wakeGeom.getAttribute('position') as THREE.BufferAttribute;
    const uvAttr = wakeGeom.getAttribute('uv') as THREE.BufferAttribute;
    const n = wakePoints.length;
    const ws = PARAMS.windSpeed;

    for (let i = 0; i < n; i++) {
        const vi = i * 2;
        const wp = wakePoints[i];
        const t = wp.age / WAKE_MAX_AGE;
        const width = (WAKE_WIDTH_START + (WAKE_WIDTH_END - WAKE_WIDTH_START) * t)
            * (0.5 + 0.5 * wp.speedFactor);
        const hw = width * 0.5;

        const lx = wp.x - wp.perpX * hw;
        const lz = wp.z - wp.perpZ * hw;
        const rx = wp.x + wp.perpX * hw;
        const rz = wp.z + wp.perpZ * hw;

        const ly = getWaterHeightFast(lx, lz, time, ws) + WAKE_Y_OFFSET;
        const ry = getWaterHeightFast(rx, rz, time, ws) + WAKE_Y_OFFSET;

        posAttr.setXYZ(vi,     lx, ly, lz);
        posAttr.setXYZ(vi + 1, rx, ry, rz);
        uvAttr.setXY(vi, 0, t);
        uvAttr.setXY(vi + 1, 1, t);
    }

    const drawCount = Math.max(0, n - 1) * 6;
    wakeGeom.setDrawRange(0, drawCount);

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    wakeMat.uniforms.uTime.value = time;
}


// --- FOAM BUBBLES (instanced spheres) ---
const BUBBLE_MAX = 300;
const BUBBLE_MAX_AGE = 4.0;
const BUBBLE_EMIT_RATE = 40;
const BUBBLE_MIN_SIZE = 0.03;
const BUBBLE_MAX_SIZE = 0.12;

interface Bubble {
    x: number; z: number;
    size: number;
    age: number;
    alive: boolean;
}

const bubbles: Bubble[] = [];
for (let i = 0; i < BUBBLE_MAX; i++) {
    bubbles.push({ x: 0, z: 0, size: 0, age: 0, alive: false });
}
let bubbleHead = 0;
let bubbleEmitAccum = 0;

const bubbleGeom = new THREE.SphereGeometry(1, 6, 4);
const bubbleMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0.0,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
});

const bubbleInstMesh = new THREE.InstancedMesh(bubbleGeom, bubbleMat, BUBBLE_MAX);
bubbleInstMesh.frustumCulled = false;
scene.add(bubbleInstMesh);

const _bubbleMat4 = new THREE.Matrix4();
const _bubbleZeroScale = new THREE.Matrix4().makeScale(0, 0, 0);

for (let i = 0; i < BUBBLE_MAX; i++) {
    bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
}
bubbleInstMesh.instanceMatrix.needsUpdate = true;

function clearBubbles() {
    for (const b of bubbles) b.alive = false;
    for (let i = 0; i < BUBBLE_MAX; i++) {
        bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
    }
    bubbleInstMesh.instanceMatrix.needsUpdate = true;
}

function updateBubbles(dt: number, time: number) {
    const foiling = gameState === 'riding' && foilState.onFoil && foilState.speed > 1.0;

    if (foiling) {
        bubbleEmitAccum += BUBBLE_EMIT_RATE * dt;
        const dir = headingToDir(foilState.heading);
        const mastX = foilState.position.x + dir.x * WAKE_MAST_OFFSET;
        const mastZ = foilState.position.z + dir.z * WAKE_MAST_OFFSET;

        while (bubbleEmitAccum >= 1.0) {
            bubbleEmitAccum -= 1.0;
            const spread = 0.2;//    + foilState.speed * 0.05;
            const b = bubbles[bubbleHead];
            b.x = mastX + (Math.random() - 0.5) * spread;
            b.z = mastZ + (Math.random() - 0.5) * spread;
            b.size = BUBBLE_MIN_SIZE + Math.random() * (BUBBLE_MAX_SIZE - BUBBLE_MIN_SIZE);
            b.age = 0;
            b.alive = true;
            bubbleHead = (bubbleHead + 1) % BUBBLE_MAX;
        }
    } else {
        bubbleEmitAccum = 0;
    }

    const ws = PARAMS.windSpeed;
    let anyUpdate = false;

    for (let i = 0; i < BUBBLE_MAX; i++) {
        const b = bubbles[i];
        if (!b.alive) continue;

        b.age += dt;
        if (b.age >= BUBBLE_MAX_AGE) {
            b.alive = false;
            bubbleInstMesh.setMatrixAt(i, _bubbleZeroScale);
            anyUpdate = true;
            continue;
        }

        const fade = 1.0 - (b.age / BUBBLE_MAX_AGE);
        const s = b.size * fade;
        const y = getWaterHeightFast(b.x, b.z, time, ws) - s * 0.5;

        _bubbleMat4.makeScale(s, s, s);
        _bubbleMat4.setPosition(b.x, y, b.z);
        bubbleInstMesh.setMatrixAt(i, _bubbleMat4);
        anyUpdate = true;
    }

    if (anyUpdate) {
        bubbleInstMesh.instanceMatrix.needsUpdate = true;
    }
}


// --- RACE MARKERS ---
// All buoys and the finish gate are centred on `raceTrackX`, which smoothly
// tracks the player's lateral (X) position.  Each buoy stores its relative
// X offset from that centre so the whole course shifts with the rider.

// raceTrackX starts at 0 and lerps toward the player's X every frame.
let raceTrackX = 0;

interface RaceBuoy {
    group: THREE.Group;
    relativeX: number; // offset from raceTrackX centre
    baseZ: number;
}
const raceBuoys: RaceBuoy[] = [];

function createBuoyMesh(red: boolean): THREE.Group {
    const g = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.22, 0.9, 8);
    const bodyMat = new THREE.MeshStandardMaterial({
        color: red ? 0xcc2200 : 0xf0f0f0,
        roughness: 0.6,
        metalness: 0.0,
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.45;
    g.add(body);

    const ballGeo = new THREE.SphereGeometry(0.3, 8, 6);
    const ballMat = new THREE.MeshStandardMaterial({
        color: red ? 0xff3300 : 0xffffff,
        roughness: 0.35,
    });
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.position.y = 1.05;
    g.add(ball);

    return g;
}

// Relative X offsets within each km cluster (centred on 0)
const BUOY_REL_X = [-55, -33, -13, 0, 13, 33, 55];

for (let km = 1; km <= RACE_LENGTH_KM; km++) {
    const z = RACE_START_Z + km * 1000;
    for (let i = 0; i < BUOY_REL_X.length; i++) {
        const isRed = i % 2 === 0;
        const buoyGroup = createBuoyMesh(isRed);
        buoyGroup.position.set(BUOY_REL_X[i], 0, z); // initial X; updated every frame
        scene.add(buoyGroup);
        raceBuoys.push({ group: buoyGroup, relativeX: BUOY_REL_X[i], baseZ: z });
    }
}

// Finish gate — two tall orange poles with a checkered crossbar
const FINISH_Z = RACE_START_Z + RACE_LENGTH_KM * 1000;
const finishGate = new THREE.Group();
finishGate.position.set(0, 0, FINISH_Z);
scene.add(finishGate);

const poleMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.5 });
const poleGeo = new THREE.CylinderGeometry(0.28, 0.28, 12, 8);

const gateLeftPole = new THREE.Mesh(poleGeo, poleMat);
gateLeftPole.position.set(-30, 6, 0);
finishGate.add(gateLeftPole);

const gateRightPole = new THREE.Mesh(poleGeo, poleMat);
gateRightPole.position.set(30, 6, 0);
finishGate.add(gateRightPole);

// Big orange buoys at the base of each pole
const gateBuoyGeo = new THREE.SphereGeometry(0.9, 10, 7);
const gateBuoyMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.4 });
[[-30], [30]].forEach(([bx]) => {
    const gb = new THREE.Mesh(gateBuoyGeo, gateBuoyMat);
    gb.position.set(bx, 0.9, 0);
    finishGate.add(gb);
});

// Checkered crossbar made of alternating black/white segments
const crossBarY = 12;
const segCount = 33;
const totalBarWidth = 66;
const segW = totalBarWidth / segCount;
const segGeo = new THREE.BoxGeometry(segW - 0.05, 0.7, 0.5);
for (let i = 0; i < segCount; i++) {
    const segMat = new THREE.MeshStandardMaterial({
        color: i % 2 === 0 ? 0x111111 : 0xffffff,
        roughness: 0.5,
    });
    const seg = new THREE.Mesh(segGeo, segMat);
    seg.position.set(-totalBarWidth / 2 + segW * (i + 0.5), crossBarY, 0);
    finishGate.add(seg);
}

// Thin support rod behind the segments
const rodGeo = new THREE.CylinderGeometry(0.1, 0.1, totalBarWidth + 0.5, 6);
rodGeo.rotateZ(Math.PI / 2);
const rodMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.5 });
const rod = new THREE.Mesh(rodGeo, rodMat);
rod.position.set(0, crossBarY, -0.3);
finishGate.add(rod);

// finishGate X is driven by raceTrackX (set to 0 initially)


// --- INPUT SYSTEM ---
window.addEventListener('keydown', (e) => {
    switch (e.code) {
        case 'ArrowLeft': input.left = true; break;
        case 'ArrowRight': input.right = true; break;
        case 'ArrowUp': input.up = true; break;
        case 'ArrowDown': input.down = true; break;
        case 'Space':
            e.preventDefault();
            if (gameState === 'starting') {
                launchFoil();
            } else if (gameState === 'riding') {
                input.pump = true;
            }
            break;
        case 'KeyR':
            if (gameState === 'crashed') {
                resetFoilState();
            }
            break;
        case 'KeyC':
            useChaseCamera = !useChaseCamera;
            controls.enabled = !useChaseCamera;
            PARAMS.chaseCamera = useChaseCamera;
            gui.controllersRecursive().forEach(c => c.updateDisplay());
            break;
    }
});

window.addEventListener('keyup', (e) => {
    switch (e.code) {
        case 'ArrowLeft': input.left = false; break;
        case 'ArrowRight': input.right = false; break;
        case 'ArrowUp': input.up = false; break;
        case 'ArrowDown': input.down = false; break;
    }
});


// --- PHYSICS UPDATE ---
function updatePhysics(dt: number, time: number) {
    if (gameState !== 'riding') return;

    dt = Math.min(dt, 1 / 30);

    const foil = activeFoil;
    const speed = foilState.velocity.length();
    foilState.speed = speed;

    let targetRoll = 0;
    if (input.left) targetRoll = MAX_ROLL;
    if (input.right) targetRoll = -MAX_ROLL;

    let targetPitch = 0;
    if (input.up) targetPitch = MAX_PITCH;
    if (input.down) targetPitch = -MAX_PITCH;

    // Sample wave surface at center and both wingtips
    const wave = sampleWaveAtFoilPoints(time, PARAMS.windSpeed);

    // Wave-induced roll torque from height difference across wingspan
    const heightDiff = wave.rightTip.position.y - wave.leftTip.position.y;
    const waveTorque = (heightDiff / foil.wingSpan) * WAVE_TORQUE_GAIN;

    // Spring-damper roll dynamics with wave torque
    const rollError = targetRoll - foilState.roll;
    const rollAccel = rollError * ROLL_SPRING - foilState.rollRate * ROLL_DAMPING + waveTorque;
    foilState.rollRate += rollAccel * dt;
    foilState.roll += foilState.rollRate * dt;
    foilState.roll = THREE.MathUtils.clamp(foilState.roll, -MAX_ROLL * 1.2, MAX_ROLL * 1.2);

    // Pitch spring
    foilState.pitch += (targetPitch - foilState.pitch) * 5.0 * dt;

    // --- Lift force ---
    const clFactor = smoothstep(foil.stallSpeed * 0.7, foil.stallSpeed * 1.3, speed);
    const CL = foil.maxLiftCoeff * clFactor;
    const liftMag = 0.5 * RHO_WATER * speed * speed * CL * foil.wingArea;

    // --- Drag force ---
    const inducedCD = (CL * CL) / (Math.PI * foil.aspectRatio * 0.85);
    const totalCD = foil.baseDragCoeff + inducedCD;
    let dragMag = 0.5 * RHO_WATER * speed * speed * totalCD * foil.wingArea;
    // Mast drag
    dragMag += 0.5 * RHO_WATER * speed * speed * 0.8 * MAST_DRAG_AREA;
    // Board touching water drag penalty
    if (foilState.rideHeight < 0.1) {
        const wetFactor = 1.0 - foilState.rideHeight / 0.1;
        dragMag += wetFactor * 0.5 * RHO_WATER * speed * speed * 0.3 * 0.05;
    }

    // --- Accumulate horizontal forces ---
    const force = new THREE.Vector3(0, 0, 0);

    // Wave energy: gravitational acceleration along wave slope
    force.x += RIDER_MASS * GRAVITY * (-wave.gradient.x) * WAVE_ENERGY_MULT;
    force.z += RIDER_MASS * GRAVITY * (-wave.gradient.y) * WAVE_ENERGY_MULT;

    // Drag opposing velocity
    if (speed > 0.01) {
        const dragDir = foilState.velocity.clone().normalize();
        force.addScaledVector(dragDir, -dragMag);
    }

    // --- Turning from roll ---
    if (Math.abs(foilState.roll) > 0.01 && speed > 1.0) {
        const centripetal = liftMag * Math.sin(foilState.roll);
        let headingRate = centripetal / (RIDER_MASS * Math.max(speed, 2.0));
        headingRate = THREE.MathUtils.clamp(headingRate, -foil.turnRateMax, foil.turnRateMax);
        foilState.heading += headingRate * dt;
    }

    // --- Pump ---
    if (input.pump && foilState.energy >= PUMP_COST && (time - foilState.lastPumpTime) > PUMP_COOLDOWN) {
        const pumpDir = headingToDir(foilState.heading);
        foilState.velocity.addScaledVector(pumpDir, PUMP_IMPULSE);
        foilState.energy -= PUMP_COST;
        foilState.lastPumpTime = time;
        foilState.rideHeight = Math.min(foilState.rideHeight + 0.05, MAST_LENGTH);
        triggerPumpAnim();
        input.pump = false;
    }
    input.pump = false;

    // Energy regen
    foilState.energy = Math.min(100, foilState.energy + ENERGY_REGEN * dt);

    // --- Integrate velocity ---
    const accel = force.clone().divideScalar(RIDER_MASS);
    foilState.velocity.addScaledVector(accel, dt);
    foilState.velocity.y = 0;

    // Lateral slip decay: foil has high sideways resistance
    const dir = headingToDir(foilState.heading);
    const fwdSpeed = foilState.velocity.dot(dir);
    const lateral = foilState.velocity.clone().addScaledVector(dir, -fwdSpeed);
    lateral.multiplyScalar(Math.exp(-LATERAL_RESISTANCE * dt));
    foilState.velocity.copy(dir.clone().multiplyScalar(fwdSpeed)).add(lateral);

    // --- Integrate position ---
    foilState.position.addScaledVector(foilState.velocity, dt);
    foilState.distanceTravelled += speed * dt;

    // --- Ride height: spring-damper seeking target based on lift-to-weight ratio ---
    const liftRatio = liftMag / (RIDER_MASS * GRAVITY);
    const targetHeight = THREE.MathUtils.clamp(
        (liftRatio - 0.8) / 1.2 * MAST_LENGTH * 0.8,
        0,
        MAST_LENGTH
    );

    const pitchBias = foilState.pitch * 0.3;
    const effectiveTarget = THREE.MathUtils.clamp(targetHeight + pitchBias, 0, MAST_LENGTH);

    const heightError = effectiveTarget - foilState.rideHeight;
    const heightAccel = heightError * HEIGHT_SPRING - foilState.rideHeightVel * HEIGHT_DAMPING;
    foilState.rideHeightVel += heightAccel * dt;
    foilState.rideHeight += foilState.rideHeightVel * dt;

    // Minimum ride height floor: if lift is strong enough to foil, don't let height collapse
    const minRideHeight = liftRatio > 1.0 ? 0.12 : 0;
    foilState.rideHeight = Math.max(minRideHeight, Math.min(MAST_LENGTH, foilState.rideHeight));

    foilState.speed = foilState.velocity.length();

    // --- Check crash ---
    // Hard floor: physically on the water
    if (foilState.rideHeight <= 0.001) {
        foilState.rideHeight = 0;
        foilState.onFoil = false;
        gameState = 'crashed';
    }
    // Too low and too slow to recover — mast nearly submerged + below stall speed
    else if (foilState.rideHeight < 0.05 && foilState.speed < foil.stallSpeed) {
        foilState.rideHeight = 0;
        foilState.onFoil = false;
        gameState = 'crashed';
    }
}


// --- CHASE CAMERA ---
const _chaseCamPos = new THREE.Vector3();
const _chaseLookAt = new THREE.Vector3();

const CHASE_CAM_LATERAL_MAG = 10;
const CHASE_CAM_DEAD_ZONE = 0.1;
const CHASE_CAM_SWING_SPEED = 1.0;

let chaseCamLateralTarget = -CHASE_CAM_LATERAL_MAG;
let chaseCamLateralSmoothed = -CHASE_CAM_LATERAL_MAG;

function updateChaseCamera(dt: number) {
    if (!useChaseCamera) {
        controls.enabled = true;
        controls.target.lerp(boardGroup.position, 0.1);
        controls.update();
        return;
    }

    controls.enabled = false;

    const headDir = headingToDir(foilState.heading);
    const rightDir = new THREE.Vector3(headDir.z, 0, -headDir.x);

    // Swing camera side based on rider heading vs wave direction (+Z).
    // sin(heading) > 0 → heading left of downwind → camera on left (-lateral)
    // sin(heading) < 0 → heading right of downwind → camera on right (+lateral)
    const headingSin = Math.sin(foilState.heading);
    if (headingSin > CHASE_CAM_DEAD_ZONE) {
        chaseCamLateralTarget = -CHASE_CAM_LATERAL_MAG;
    } else if (headingSin < -CHASE_CAM_DEAD_ZONE) {
        chaseCamLateralTarget = CHASE_CAM_LATERAL_MAG;
    }

    chaseCamLateralSmoothed += (chaseCamLateralTarget - chaseCamLateralSmoothed)
        * (1.0 - Math.exp(-CHASE_CAM_SWING_SPEED * dt));

    _chaseCamPos.copy(boardGroup.position)
        .addScaledVector(headDir, -16)
        .addScaledVector(rightDir, chaseCamLateralSmoothed)
        .setY(boardGroup.position.y + 9);

    const followFactor = 1.0 - Math.exp(-3.0 * dt);
    camera.position.lerp(_chaseCamPos, followFactor);

    _chaseLookAt.copy(boardGroup.position)
        .addScaledVector(headDir, 8);

    camera.lookAt(_chaseLookAt);
}


// --- BOARD VISUAL UPDATE ---
function updateBoardVisuals(time: number) {
    const wave = getSurfaceInfoAtWorldPos(
        foilState.position.x,
        foilState.position.z,
        time,
        PARAMS.windSpeed
    );

    if (gameState === 'starting') {
        // Float on the surface
        boardGroup.position.copy(wave.position);
        const up = new THREE.Vector3(0, 1, 0);
        boardGroup.quaternion.setFromUnitVectors(up, wave.normal);
        return;
    }

    // Position: wave surface + ride height along surface normal
    boardGroup.position.set(
        wave.position.x,
        wave.position.y + foilState.rideHeight,
        wave.position.z
    );

    // Orientation: combine heading, pitch, roll, and wave surface tilt
    const yawQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), foilState.heading
    );
    const pitchQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), foilState.pitch
    );
    const rollQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1), -foilState.roll
    );
    const surfaceQ = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), wave.normal
    );

    boardGroup.quaternion.copy(surfaceQ).multiply(yawQ).multiply(pitchQ).multiply(rollQ);
}


// --- RACE LOGIC ---
function updateRace(dt: number, time: number) {
    // Auto-start when the player launches
    if (gameState === 'riding' && !race.active && !race.finished) {
        startRace(time);
    }

    if (!race.active) return;

    race.totalElapsed = time - race.startTime;

    // Use downwind (Z) distance so km marks align with the physical buoy positions.
    // Total path distance (distanceTravelled) is tracked separately for display.
    const dwind = downwindDist();
    const kmReached = Math.floor(dwind / 1000);

    // Record split time for each newly crossed km mark
    for (let k = race.lastKmReached + 1; k <= Math.min(kmReached, RACE_LENGTH_KM); k++) {
        race.kmSplitTimes.push(race.totalElapsed);
        const prev = race.kmSplitTimes.length > 1 ? race.kmSplitTimes[race.kmSplitTimes.length - 2] : 0;
        const split = race.totalElapsed - prev;
        race.splitFlashText = `KM ${k}\n${fmtTime(split)}`;
        race.splitFlashTimer = 3.0;
        race.lastKmReached = k;
    }

    // Decay flash
    if (race.splitFlashTimer > 0) race.splitFlashTimer -= dt;

    // Check finish
    if (dwind >= RACE_LENGTH_KM * 1000) {
        race.finished = true;
        race.active = false;
        race.totalElapsed = time - race.startTime;
        race.splitFlashTimer = 0;
        // Ensure all km splits are recorded
        while (race.kmSplitTimes.length < RACE_LENGTH_KM) {
            race.kmSplitTimes.push(race.totalElapsed);
        }
        showRaceResults();
    }

    // Crash during race — reset race so they must start over clean
    if (gameState === 'crashed') {
        race.active = false;
    }
}


// --- ANIMATION LOOP ---
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.elapsedTime;

    // Update GPU water
    waterUniforms.uTime.value = time;
    waterUniforms.uWindSpeed.value = PARAMS.windSpeed;

    // Move water mesh to follow player — shader uses uWorldOffset to keep
    // waves world-space correct so the ocean looks infinite.
    waterMesh.position.x = foilState.position.x;
    waterMesh.position.z = foilState.position.z;
    waterUniforms.uWorldOffset.value.set(foilState.position.x, foilState.position.z);

    // Physics step
    updatePhysics(dt, time);

    // Race logic
    updateRace(dt, time);

    // Lateral race-track tracking: the whole course (buoys + finish gate) drifts
    // to stay centred on the player's X so markers are always visible regardless
    // of how far the rider has drifted downwind.
    raceTrackX += (foilState.position.x - raceTrackX) * (1 - Math.exp(-4.0 * dt));

    // Bob buoys on the water surface and apply lateral tracking
    {
        const ws = PARAMS.windSpeed;
        for (const buoy of raceBuoys) {
            const bx = raceTrackX + buoy.relativeX;
            buoy.group.position.x = bx;
            buoy.group.position.y = getWaterHeightFast(bx, buoy.baseZ, time, ws);
        }
        // Finish gate — same lateral centre, just bob on waves
        finishGate.position.x = raceTrackX;
        finishGate.position.y = getWaterHeightFast(raceTrackX, FINISH_Z, time, ws);
    }

    // Wake trail
    updateWakeTrail(dt, time);
    updateBubbles(dt, time);

    // Board visuals
    updateBoardVisuals(time);

    // Rider animation
    updateRiderAnimation();
    riderMixer?.update(dt);
    if (riderModel) {
        const yOffset = currentAnimName === 'sitting' ? SITTING_Y_OFFSET : 0;
        riderModel.position.set(RIDER_OFFSET.x, RIDER_OFFSET.y + yOffset, RIDER_OFFSET.z);
    }

    // Camera
    updateChaseCamera(dt);

    // Keep directional light tracking the board so it always illuminates nearby geometry
    dirLight.position.copy(boardGroup.position).addScaledVector(sunDirection, 100);
    dirLight.target.position.copy(boardGroup.position);

    // Render
    renderer.render(scene, camera);

    // HUD
    updateHUD();

    // Perf stats
    const now = performance.now();
    const frameDelta = now - prevTime;
    prevTime = now;
    frameCount++;
    fpsAccum += frameDelta;

    if (fpsAccum >= 500) {
        perfStats.fps = Math.round((frameCount / fpsAccum) * 1000);
        perfStats.frameMs = +(frameDelta).toFixed(1);
        frameCount = 0;
        fpsAccum = 0;
    }

    perfStats.drawCalls = renderer.info.render.calls;
    perfStats.triangles = renderer.info.render.triangles;
}


// Handle resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Start loop
animate();
