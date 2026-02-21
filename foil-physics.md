
# Foil Physics Model

Everything goes in [main.ts](src/main.ts). The existing wave infrastructure (`getWaterDisplacement`, `getSurfaceInfoAtWorldPos`, `waveConfig`) stays as-is and gets used by the new physics.

## 1. Foil Configuration System

Define foil presets that map real-world parameters to physics coefficients:

```typescript
interface FoilConfig {
  name: string;
  wingSpan: number;     // meters
  wingArea: number;     // m^2
  chord: number;        // meters (avg chord = area / span)
  aspectRatio: number;  // span^2 / area

  // Physics-derived
  stallSpeed: number;   // m/s, below this lift collapses
  maxLiftCoeff: number; // CL_max
  baseDragCoeff: number;// CD_0
  turnRateMax: number;  // rad/s, inversely proportional to span
}
```

Two starter presets:

- **High Aspect Race**: 1.0m span, 800cm2, AR 12, stall ~8 m/s, fast but unforgiving
- **Mid Aspect Cruise**: 1.2m span, ~2340cm2, AR 8, stall ~4 m/s, easy but slow

Add a GUI dropdown to pick a foil preset.

## 2. Physics State

```typescript
interface FoilState {
  position: THREE.Vector3;   // world position of board center
  velocity: THREE.Vector3;   // world-frame velocity
  heading: number;           // yaw in radians (0 = +Z downwind)
  pitch: number;             // nose up/down
  roll: number;              // bank angle
  rideHeight: number;        // meters above water surface (mast ~0.7m max)
  onFoil: boolean;
  energy: number;            // pump stamina (0-100)
}
```

Initialize with forward speed of ~6-10 m/s (depending on foil stall speed), heading downwind, rideHeight ~0.3m, energy 100.

## 3. Force Model (per frame)

All forces computed in world coordinates, then integrated with semi-implicit Euler.

### 3a. Wave Surface Sampling (multi-point)

Sample wave at **3 points** each frame:

- **Center**: the foil position itself
- **Left wingtip**: `center + rotate_by_heading(-span/2, 0, 0)`
- **Right wingtip**: `center + rotate_by_heading(+span/2, 0, 0)`

Use existing `getSurfaceInfoAtWorldPos(x, z, time, windSpeed)` for each point. This gives us:

- Wave height and surface normal at center (for ride height and slope)
- Height difference between wingtips (for wave-induced roll torque)
- Average gradient across the span (for wave energy)

Extract the **wave gradient** (slope in XZ) from the surface normal:

```typescript
const gradient = new THREE.Vector2(
  -normal.x / normal.y,
  -normal.z / normal.y
);
```

### 3b. Gravity + Lift Balance (vertical axis)

- **Weight**: `F_gravity = -mass * 9.81` (downward)
- **Lift**: `L = 0.5 * rho_water * speed^2 * CL * wingArea` (upward when on foil)
  - `CL` ramps with speed using a smoothstep around `stallSpeed`: `CL = maxLiftCoeff * smoothstep(stallSpeed * 0.7, stallSpeed * 1.3, speed)`
  - This gives a realistic stall curve: gradual lift loss below stall speed
- Net vertical force adjusts `rideHeight` with some damping
- If `rideHeight <= 0`: board touches water -> game over (off foil)
- If `rideHeight > mastLength`: clamp to mast length

### 3c. Wave Energy (propulsion from wave slope)

The dominant power source. The foiler gains energy by riding downhill faces of waves:

```typescript
// In world XZ plane
F_wave = mass * g * vec3(-gradient.x, 0, -gradient.z)
```

This force acts regardless of heading (gravity doesn't care which way you face). When on a favorable slope (downhill in your direction of travel), you accelerate. In a trough or uphill, you decelerate. This is what makes "finding bumps" matter.

### 3d. Drag (opposing velocity)

```typescript
D = 0.5 * rho_water * speed^2 * CD * referenceArea
```

- `CD` = `baseDragCoeff` (from foil config) + induced drag term `CL^2 / (pi * AR * e)` where `e ~ 0.85`
- Add mast drag (small constant based on mast cross section ~0.01 m2)
- If rideHeight is very low (board skimming surface), add substantial wetted-surface drag penalty

Direction: opposing velocity vector.

### 3e. Turning Forces

Player roll input banks the foil. When banked:

- The lift vector tilts, its horizontal component creates centripetal force
- `F_centripetal = L * sin(roll)` directed perpendicular to heading
- This changes heading: `heading_rate = F_centripetal / (mass * speed)`
- Clamp heading rate by `turnRateMax` from foil config
- Add coordinated yaw: heading smoothly follows roll input

Larger wingspan and higher aspect ratio -> lower `turnRateMax` -> more drawn-out turns.

### 3f. Wave-Induced Roll Torque

From multi-point sampling: if the right wingtip is higher than the left:

```typescript
rollTorque = (h_right - h_left) / wingSpan * waveTorqueGain
```

This creates natural roll tendencies when riding across a wave face, making the simulation feel 3D.

### 3g. Pump Mechanic

Spacebar triggers a pump (if `energy > pumpCost`):

- Adds a brief forward impulse along heading: ~2-3 m/s boost
- Costs ~15 energy points
- Energy regenerates slowly over time (~5/sec)
- Short cooldown to prevent spamming

## 4. Physics Integration (each frame)

```
1. Read keyboard input state
2. Update roll toward target (input-driven, with spring damping + wave torque)
3. Update pitch toward target (input-driven, small range)
4. Sample wave surface at 3 points
5. Compute all forces: gravity, lift, wave energy, drag, turning
6. If pump triggered: add impulse
7. acceleration = net_force / mass
8. velocity += acceleration * dt   (semi-implicit Euler)
9. position += velocity * dt
10. Update rideHeight from vertical force balance
11. speed = velocity.length()
12. Check stall/off-foil conditions
13. Update board visual transform
```

Cap `dt` to avoid physics explosion on frame drops (max 1/30s).

## 5. Input System

```typescript
const input = { left: false, right: false, up: false, down: false, pump: false };
```

- **Left/Right arrows**: set target roll angle (+/- ~30 deg max), with yaw coupling
- **Up/Down arrows**: adjust pitch slightly (+/- ~5 deg range)
- **Spacebar**: trigger pump (on keydown, not held)

Listen on `keydown` / `keyup` to track held state.

## 6. Game State

Three states: `riding`, `crashed`, `starting`.

- **starting**: brief countdown or "press space to start", gives initial velocity
- **riding**: physics active, normal gameplay
- **crashed**: triggered when `rideHeight <= 0` or `speed < stallSpeed * 0.5` for too long. Show "Off Foil! Press R to restart". Freeze physics, dim screen.

On restart: reset position (nearby), reset velocity to initial, reset energy.

## 7. Camera

Replace OrbitControls (keep as debug toggle) with a **chase camera**:

- Position: behind and above the rider, offset based on heading
- `camTarget = position + headingDir * (-8) + vec3(0, 4, 0)` (8m behind, 4m up)
- Smooth follow with lerp (~0.05 factor)
- Look-at: slightly ahead of rider
- Gentle roll matching for immersion (optional)

Toggle between chase cam and orbit cam with a key (e.g., `C`).
