// Centralized tunables. Units: pixels and seconds unless noted. World Y points DOWN.
const PX_PER_METER = 20;

// C-minor pentatonic (C Eb F G Bb) across 3 octaves, C4..Bb6, as frequencies in Hz (15 notes).
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const SCALE_FREQS = [];
for (let oct = 0; oct < 3; oct++) for (const step of [0, 3, 5, 7, 10]) SCALE_FREQS.push(mtof(60 + 12 * oct + step));

export const CONFIG = Object.freeze({
  // --- Physics ---
  GRAVITY: 1500,
  BASE_SPEED: 430,
  MAX_SPEED: 1150,
  BOOST_SPEED_BONUS: 240,
  BOOST_DECAY: 0.3,
  SLOPE_ACCEL_FACTOR: 900,
  SLOPE_NEUTRAL_SIN: 0.3,
  SPEED_RELAX: 0.5,
  AIR_DRAG: 0.04,
  TAKEOFF_EPS: 0.35,

  // --- Jump & flip ---
  JUMP_VELOCITY: 640,
  JUMP_BUFFER_MS: 100,
  FLIP_ANGULAR_ACCEL: 36,
  MAX_FLIP_SPEED: 8.5,
  AUTO_TUCK_TORQUE: 7,
  COYOTE_TIME_MS: 120,
  FLIP_COUNT_THRESHOLD: 0.85,
  MAX_BOOST_STACK: 3,
  AURA_DURATION: 3.0,
  LANDING_ANGLE_TOLERANCE: Math.PI / 3.5,

  // --- Player hitbox (feet at player.y) ---
  PLAYER_HALF_WIDTH: 13,
  PLAYER_HEIGHT: 36,

  // --- Grinding (rails + rooftops) ---
  GRIND_SLOPE_ACCEL: 260,     // gravity pull along the rail
  GRIND_BOOST_RATE: 110,      // boost speed gained per second on a rail
  GRIND_JUMP_FACTOR: 0.9,     // jump-off strength relative to JUMP_VELOCITY
  GRIND_SPARK_RATE: 90,       // sparks per second
  GRIND_POINTS_PER_SEC: 90,
  GRIND_LAND_POINTS: 150,
  GRIND_SNAP_TOLERANCE: 6,    // px of "was above the rail" forgiveness when crossing it
  GRIND_REARM_SEC: 0.3,       // can't re-grab the rail you just left for this long

  // --- Combo / scoring ---
  FLIP_POINTS: 200,
  ROCK_BOUNCE_POINTS: 250,
  ROCK_SMASH_POINTS: 120,
  ROCK_BOUNCE_VELOCITY: 520,
  ROCK_HITBOX_SCALE: 0.75,

  // --- Camera ---
  CAMERA_LEAD_X: 0.3,
  CAMERA_ANCHOR_Y: 0.55,
  BASE_ZOOM: 1.0,
  MIN_ZOOM: 0.55,

  // --- Terrain ---
  SEGMENT_WIDTH: 25,
  NOISE_AMPLITUDE: 150,
  NOISE_FREQUENCY: 0.0022,
  NOISE_OCTAVES: 4,
  NOISE_PERSISTENCE: 0.45,
  BASE_SLOPE_DROP: 0.32,

  // --- Obstacle spawning ---
  SAFE_ZONE_M: 250,
  SAFE_ZONE_PX: 250 * PX_PER_METER,   // no hazards before this x
  CHUNK_WIDTH: 1000,
  DIFFICULTY_RAMP_PX: 60000,          // distance at which difficulty is fully ramped
  ROCK_WIDTH: [46, 98],
  ROCK_ASPECT: [0.55, 0.9],           // height / width
  RAIL_LENGTH: [340, 560],
  RAIL_POLE_HEIGHT: [85, 110],
  RAIL_SAG: [24, 40],
  RAIL_CATENARY_K: 2.2,
  ROOF_WIDTH: [240, 320],
  ROOF_WALL_HEIGHT: [70, 100],
  ROOF_RISE: [50, 70],
  ROOF_OVERHANG: 14,
  CHASM_GAP: [220, 330],
  CHASM_KICK_LEN: 200,
  CHASM_KICK_HEIGHT: 70,
  CHASM_DEPTH: 520,

  // --- Day / night cycle ---
  CYCLE_SECONDS: 160,                 // DAWN -> DAY -> DUSK -> NIGHT, 40s each
  START_TIME_OF_DAY: 0.04,            // 0..1 position in the cycle at run start
  PALETTES: [
    { name: 'DAWN', night: 0.4, zenith: '#3b3a6e', horizon: '#f2a38a', fog: '#f6c6a8', sun: '#ffd29a',
      layers: ['#a583ad', '#86699a', '#624f84', '#40396e'], groundTop: '#2a2a52', groundBottom: '#0e0f26', crust: '#fff4e6' },
    { name: 'DAY', night: 0.0, zenith: '#6fb1e0', horizon: '#f9e4c8', fog: '#fbe9d2', sun: '#fff4d6',
      layers: ['#cfd9ea', '#a9bcd8', '#7f98c0', '#566fa0'], groundTop: '#2f3d6e', groundBottom: '#141a3a', crust: '#ffffff' },
    { name: 'DUSK', night: 0.6, zenith: '#2a2560', horizon: '#f07a5a', fog: '#f0a080', sun: '#ff9a66',
      layers: ['#a85d7c', '#7e4973', '#583761', '#35264f'], groundTop: '#241f4a', groundBottom: '#0b0a1e', crust: '#ffe2cc' },
    { name: 'NIGHT', night: 1.0, zenith: '#070b1f', horizon: '#1e2a5a', fog: '#26336a', sun: '#ffd29a',
      layers: ['#2b3a6e', '#202c58', '#161f44', '#0e1530'], groundTop: '#101634', groundBottom: '#04050f', crust: '#cfe3ff' },
  ],

  // --- Parallax (index 0 = farthest) ---
  PARALLAX_SCROLL: [0.08, 0.18, 0.32, 0.55],
  PARALLAX_BASE_Y: [0.46, 0.54, 0.63, 0.72],   // ridge baseline as a fraction of screen height
  PARALLAX_AMP: [110, 95, 85, 70],
  PARALLAX_WAVELENGTH: [1100, 800, 520, 360],
  PARALLAX_FOG: [0.6, 0.45, 0.28, 0.12],
  PARALLAX_RIDGED: [true, true, false, false],
  TREE_SPACING: 22,
  TREE_HEIGHT: [14, 40],
  STAR_COUNT: 140,
  SNOW_COUNT: 130,

  // --- Night visibility rim-glow ---
  GLOW_CYAN: [95, 243, 255],
  GLOW_GOLD: [255, 210, 122],

  // --- Particles ---
  PARTICLE_MAX: 420,
  SPRAY_MIN_SIN: 0.42,        // slopes steeper than this throw snow spray
  SPRAY_RATE: 140,

  // --- Economy (Milestone 4) ---
  SAVE_KEY: 'harmonicDescent_save_v1',
  COIN_VALUE: 1,
  COIN_START_PX: 2000,            // coins may appear from here (hazards still wait for SAFE_ZONE_PX)
  COIN_ROW_CHANCE: 0.35,          // chance an empty chunk gets a short row of coins on the slope
  COIN_ARC_CHANCE: 0.4,           // chance a hazard chunk gets a coin arc over / along its feature
  COIN_ROW_COUNT: [4, 6],
  COIN_SPACING: 60,
  COIN_PICK_RADIUS: 30,
  CHIME_START_PX: 3000,
  CHIME_RADIUS: 34,
  HARP_RADIUS: 42,
  HARP_CHANCE: 0.7,               // chance a chasm gets an Overdrive Harp floating over its jump arc
  HARP_EXTEND: 1.2,               // seconds added by a clean flip or a grind while Overdrive is active
  HARP_EXTEND_CAP: 1.6,           // remaining time can't exceed base duration x this
  MAGNET_SPEED: 700,
  // Echo upgrades. Index = tier (0 = default). costs[i] buys tier i+1.
  UPGRADES: {
    chime: {
      name: 'Gilded Chime', blurb: 'A floating bell. Multiplies every coin you collect while it rings.',
      costs: [120, 320, 700, 1400, 2800],
      durations: [6, 8, 10, 13, 16, 16],
      mults: [2, 2, 2, 2, 3, 3],
      spawn: [0.10, 0.14, 0.18, 0.22, 0.26, 0.30], // chance per chunk
    },
    harp: {
      name: 'Overdrive Harp', blurb: 'Hangs high over chasms. Multiplies banked trick score; flips and grinds keep it alive.',
      costs: [150, 380, 800, 1600, 3200],
      durations: [5, 6.2, 7.4, 8.6, 9.8, 11],
      mults: [2, 2, 2, 3, 3, 3],
    },
  },
  // Permanent gear, bought with Gold Coins.
  GEAR: {
    magnet: { name: 'Harmonic Magnet', blurb: 'Gently pulls nearby coins toward the rider.', cost: 80, radius: 170 },
    board: { name: 'Resonance Board', blurb: '+10% base speed and flip torque.', cost: 200, speedMult: 1.1, flipMult: 1.1 },
  },

  // --- Audio (Milestone 3) ---
  AUDIO_BPM: 116,
  AUDIO_LOOKAHEAD: 0.2,           // seconds of music scheduled ahead of the audio clock
  AUDIO_SCHEDULER_MS: 25,         // scheduler timer interval
  CHORD_BARS: 1,                  // bars per chord; 4 chords = a 4-bar loop
  SCALE_FREQS,
  CHORDS: [                       // MIDI notes sorted ascending so pad voices glide smoothly
    { name: 'Cm9',    root: 36, notes: [48, 51, 55, 58, 62] },
    { name: 'Abmaj7', root: 32, notes: [48, 51, 55, 56, 60] },
    { name: 'Fm9',    root: 29, notes: [51, 53, 55, 56, 60] },
    { name: 'G7sus4', root: 31, notes: [53, 55, 60, 62, 65] },
  ],
  FILTER_GROUND_HZ: 380,          // master low-pass on the ground
  FILTER_AIR_HZ: 7500,            // ...fully open at FILTER_ALT_MAX_PX above the terrain
  FILTER_CRASH_HZ: 120,
  FILTER_ALT_MAX_PX: 260,
  FILTER_SPEED_LIFT_OCT: 0.5,     // extra octaves of cutoff at full speed energy on the ground (0 = strict 380 Hz)
  FILTER_KICK_MULT: 5,            // stingers briefly open the filter by up to this multiple
  AUDIO_ENERGY_SPEED_MIN: 450,    // player.speed where percussion starts to fade in
  AUDIO_ENERGY_SPEED_MAX: 900,    // ...and where it is fully in
  AUDIO_LAYER_GAINS: { master: 0.85, pad: 0.55, sub: 0.5, shimmer: 0.3, kick: 0.8, hat: 0.22, arp: 0.3, lead: 0.32, fx: 0.7, buff: 0.1 },
  PAD_CUTOFF_DAY: 2600,           // pad warmth: bright by day, dark by night
  PAD_CUTOFF_NIGHT: 900,
  REVERB_SECONDS: 2.8,
  REVERB_DECAY_POW: 3,
  REVERB_WET_DAY: 0.14,
  REVERB_WET_NIGHT: 0.4,
  DELAY_BEATS: 0.75,              // dotted eighth ping-pong
  DELAY_FEEDBACK: 0.62,
  DELAY_WET_DAY: 0.14,
  DELAY_WET_NIGHT: 0.24,
  TAPE_CRASH_CENTS: -1100,        // pitch drop of sustained voices on crash
  TAPE_SLOWMO_CENTS_PER_OCT: 420, // pitch sag per octave of time-scale slowdown

  // --- Loop / HUD / visuals ---
  MAX_FRAME_DT: 0.05,
  PHYSICS_STEP: 1 / 120,
  RESTART_DELAY_MS: 350,
  PX_PER_METER,
  SCARF_NODES: 12,
  SCARF_SEGMENT: 6,
});