// Centralized tunables. Units: pixels and seconds unless noted. World Y points DOWN.
export const CONFIG = Object.freeze({
  // --- Physics ---
  GRAVITY: 1500,
  BASE_SPEED: 430,
  MAX_SPEED: 1150,
  BOOST_SPEED_BONUS: 240,     // added to target speed per backflip landed
  BOOST_DECAY: 0.3,           // exponential decay rate of boost per second
  SLOPE_ACCEL_FACTOR: 900,    // acceleration on slopes steeper than SLOPE_NEUTRAL_SIN
  SLOPE_NEUTRAL_SIN: 0.3,     // sin(angle) at which slope adds no acceleration (~17.5 deg)
  SPEED_RELAX: 0.5,           // how quickly speed relaxes toward BASE_SPEED + boost
  AIR_DRAG: 0.04,
  TAKEOFF_EPS: 0.35,          // px of terrain fall-away (at 60fps) before leaving the ground

  // --- Jump & flip ---
  JUMP_VELOCITY: 640,
  JUMP_BUFFER_MS: 100,        // a tap just before landing still jumps
  FLIP_ANGULAR_ACCEL: 36,     // rad/s^2, backward
  MAX_FLIP_SPEED: 8.5,        // rad/s
  AUTO_TUCK_TORQUE: 7,        // nose-align strength when input released in air
  COYOTE_TIME_MS: 120,
  FLIP_COUNT_THRESHOLD: 0.85, // fraction of a full rotation that counts as a flip
  MAX_BOOST_STACK: 3,
  AURA_DURATION: 3.0,         // seconds of golden aura / invulnerability

  // --- Landing forgiveness ---
  LANDING_ANGLE_TOLERANCE: Math.PI / 3.5, // ~51 deg vs terrain tangent

  // --- Camera ---
  CAMERA_LEAD_X: 0.3,         // fraction of screen width where the focus point sits
  CAMERA_ANCHOR_Y: 0.55,      // fraction of screen height for the focus point
  BASE_ZOOM: 1.0,
  MIN_ZOOM: 0.55,

  // --- Terrain ---
  SEGMENT_WIDTH: 25,
  NOISE_AMPLITUDE: 150,
  NOISE_FREQUENCY: 0.0022,    // lattice spacing = 1 / frequency px for octave 0
  NOISE_OCTAVES: 4,
  NOISE_PERSISTENCE: 0.45,
  BASE_SLOPE_DROP: 0.32,      // dy/dx of the continuous downhill (~17.7 deg)

  // --- Loop / HUD / visuals ---
  MAX_FRAME_DT: 0.05,
  PHYSICS_STEP: 1 / 120,
  RESTART_DELAY_MS: 350,
  PX_PER_METER: 20,
  SCARF_NODES: 12,
  SCARF_SEGMENT: 6,
});