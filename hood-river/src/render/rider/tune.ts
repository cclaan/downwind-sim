/**
 * Every number that shapes how the rider looks and moves, in one mutable object so a tuning
 * panel can bind to it (the rider module also exposes it as `app.modules.rider.tune`).
 * Angles are degrees, lengths metres. Knee angles are flexion (0 = straight leg); torso
 * angles are the forward hinge at the hips; chest and pelvis angles are "open" (0 = facing
 * the toe-side rail squarely, 90 = facing the nose).
 *
 * The posture numbers come from the frame-by-frame analysis of the two Hood River clips
 * and the rig table of the technique write-up: a straight body tilted with the board on
 * the toe side, a sit with the torso upright on the heel side, and a pump that folds at
 * the top of the board's travel and is tallest just after the bottom.
 */

export const RIDER_TUNE = {
  // ---- board and stance ----
  /** where the mast sits, as a fraction of board length from the nose */
  mastFrac: 0.655,
  /** board thickness under the feet */
  boardThick: 0.11,
  /** foot centres, as fractions of board length from the nose (regular foot: left forward) */
  frontFoot: 0.47,
  rearFoot: 0.655,
  /** sideways offset of the foot centres: front foot toward the heel rail, rear toward the toes */
  stagger: 0.15,
  /** toe direction, degrees from square across the board toward the nose */
  frontFootYaw: 42,
  rearFootYaw: 12,

  // ---- knees (flexion) ----
  kneeGlide: 16,
  /** full toe-side carve: 15-25 */
  kneeToe: 22,
  /** full heel-side carve, the "sit": 80-100 */
  kneeHeel: 90,
  /** extra flexion per g of load above 1 */
  kneeLoad: 20,
  /** extra at 10 m/s (the bottom-turn crouch), and on a steep drop (the deeper of the two counts, plus a share of the other) */
  kneeSpeed: 45,
  kneeDrop: 38,
  /** the deepest crouch: riding and carving toe side, and sat down heel side */
  kneeCrouchMax: 92,
  kneeSitMax: 106,
  /** extra for the moment after lift-off (weight on the front foot) */
  kneeLunge: 26,
  /** extra per degree the hips are carried off centre (leaning in ahead of the board, the board tipping under him) */
  kneeGive: 0.75,
  /** how far the hips come down, per metre one leg is longer than the other, so the long leg is not locked straight */
  legEven: 0.4,
  /** floating and paddling */
  kneePaddle: 24,
  /** extra at the catch of a sprint stroke (the legs press through the pull) */
  kneeDig: 26,
  /** a pump works between these two, at the bottom and the top of the board's travel */
  pumpKneeTall: 16,
  pumpKneeFold: 75,

  // ---- torso (forward hinge) ----
  torsoGlide: 8,
  torsoToe: 3,
  torsoHeel: 12,
  /** crouching: the largest of the load, speed and drop hinges counts (they do not add) */
  torsoLoad: 20,
  torsoSpeed: 40,
  torsoDrop: 37,
  /** a crouch never folds the chest further from plumb than this */
  torsoCrouchMax: 55,
  /** tallest and most folded in a pump */
  pumpTorsoTall: 16,
  pumpTorsoFold: 47,
  /** seconds the fold trails the board's heave (tallest just after the bottom) */
  pumpLag: 0.045,
  /** hinge at the catch of a sprint stroke, and as the blade leaves the water */
  catchHinge: 40,
  exitHinge: 12,
  /** weight forward for a moment after lift-off */
  lungeTorso: 38,
  lungeTime: 1.2,

  // ---- fore and aft ----
  /**
   * On foil the wing carries him along the mast fore and aft just as it does sideways, so he
   * stands square to the deck whatever the board's attitude, less this share of its slow
   * pitch given back toward plumb (the drag angle), up to leanBackMax degrees. Against the
   * quick rocking of a pump he stays plumb: the board moves under him.
   */
  plumbShare: 0.35,
  leanBackMax: 6,
  /** the board's attitude in an easy glide (degrees, nose-down negative): square to the deck there */
  pitchNeutral: -4,
  /** hips toward the front foot (m): on a steep drop, after lift-off, sprinting a nose-down floating board */
  hipsFwdDrop: 0.14,
  hipsFwdLunge: 0.15,
  hipsFwdSprint: 0.1,

  // ---- carving ----
  /** how far the body commits ahead of the board, as a share of (commanded - actual) bank */
  lead: 0.38,
  /** largest lead of the body over the board */
  leadMaxDeg: 16,
  /** bank at which the toe-side and heel-side postures are fully developed */
  carveFullDeg: 34,
  /** share of the heel-side bank the torso gives back to stay upright (1 = vertical) */
  heelUpright: 0.82,
  /** the same on the toe side: the body stays nearly square to the deck */
  toeUpright: 0.14,
  /** share of a toe-side bank the legs give back too (33 degrees of lean on 38 of bank in the footage) */
  toeLegsUpright: 0.12,
  /** toe side the chest is never further from plumb than this (lean plus forward hinge) */
  toeLeanMax: 42,
  /** chest: degrees open */
  chestGlide: 45,
  chestToe: 26,
  chestHeel: 80,
  /** pelvis: degrees open */
  pelvisGlide: 28,
  pelvisHeel: 42,
  /** gaze: seconds ahead along the turning track, plus degrees into a full lean command */
  lookAhead: 0.35,
  lookIntoTurn: 20,

  // ---- paddle ----
  /** below this multiple of stall speed a pump is a paddle stroke timed with the legs */
  paddlePumpBelow: 1.4,
  /** shaft angle from vertical at the catch (blade ahead of the top hand) */
  catchShaft: 34,
  /** blade tip depth at mid-pull: cruise and sprint */
  bladeDepthCruise: 0.36,
  bladeDepthSprint: 0.56,
  /** blade height over the water in a toe-side brace, and the bank at which it dabs */
  braceHeight: 0.28,
  dabBankDeg: 31,
  /** a carried blade is lifted clear of any water closer than this */
  bladeClear: 0.14,
  /** below this bank the dab is re-armed: one dab a carve */
  dabRearmDeg: 20,
  /** changing sides the blade swings over the nose: how long it takes (s), and the shaft's angle from vertical as it crosses */
  swapTime: 0.55,
  swapShaft: 58,
  /** toe-side brace: where the paddle hand grips (from the handle); short, so the shaft behind the hand stays in front of the body */
  braceGrip: 0.36,
  /** heel-side carry: where the paddle hand grips (from the handle), and how far the blade trails aft of the arm */
  heelGrip: 0.46,
  heelTrail: 0.42,
  /** the overhead paddle of a slow toe-side top turn: speed window (multiples of stall speed) and how high on the bump */
  topTurnMin: 1.3,
  topTurnMax: 2.05,
  topTurnCrest: 0.25,
  /** the paddle is kept this far from the centre of the head and from the spine (m), and off the deck */
  headClear: 0.18,
  trunkClear: 0.16,
  deckClear: 0.15,

  // ---- balance ----
  /** arm elevation (degrees from hanging) in a relaxed glide */
  armGlide: 30,
  /** extra elevation when unstable (stalled, touching, slow, rolling fast) */
  armUnstable: 34,
  /** toe-side carve: how far below the horizon the lead arm reaches for the water */
  toeReachBelow: 36,

  // ---- look ----
  /** capsule radius multiplier: fatter limbs read better from a drone */
  limbScale: 1.08,
  /** thin parts (paddle, mast, wing edges) are never drawn thinner than this many pixels */
  minPixels: 1.25,
}

export type RiderTune = typeof RIDER_TUNE

/** body proportions of a 1.78 m rider (joint to joint) */
export const BODY = {
  thigh: 0.435,
  shin: 0.435,
  ankle: 0.075,
  hipHalf: 0.095,
  spineLow: 0.2,
  spineUp: 0.31,
  shoulderHalf: 0.185,
  shoulderDrop: 0.035,
  neck: 0.075,
  head: 0.125,
  headRadius: 0.098,
  upperArm: 0.3,
  /** elbow to the middle of the palm (the grip) */
  foreArm: 0.325,
  /** elbow to wrist */
  wrist: 0.265,
  footLen: 0.26,
  footBack: 0.07,
}

export const PADDLE = {
  length: 2.05,
  blade: 0.44,
  bladeWidth: 0.19,
  shaftRadius: 0.0145,
  /** distance of the lower hand from the handle end */
  gripLow: 0.72,
  gripTop: 0.03,
}

export const COLORS = {
  suit: 0x161b20,
  vest: 0xffc81a,
  skin: 0xc9966e,
  cap: 0xf5f4ee,
  board: 0xf2552b,
  boardBottom: 0xf1efe8,
  pad: 0x2a2f34,
  foil: 0x1d2328,
  shaft: 0x14181b,
  blade: 0xf3f1e9,
}
