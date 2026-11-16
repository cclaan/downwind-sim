/**
 * Ambient life, purely visual: the people and traffic that make the river read as the
 * Hatchery on a windy afternoon.
 *
 *   - wing-foilers and windsurfers reaching across the wind off the Hatchery, with smaller
 *     groups at Swell City upwind, off Underwood and off the Hood River waterfront downwind
 *     (ambient/fleet.ts);
 *   - kiters off the sandbar, 3.5 km east;
 *   - a tug pushing four barges up the charted channel, kept 1 to 2 km ahead (ambient/traffic.ts);
 *   - a freight train on the Washington waterline (ambient/train.ts).
 *
 * Everything is in ground coordinates under one group that slides with app.groundShift.
 * Nothing comes into the water kept clear around the rider (see KEEP_OUT in fleet.ts).
 *
 * Costs: one shader program, one draw call per shape (wing-foiler, windsurfer, kiter,
 * boxes), 7k to 9k triangles depending on the tier (74, 85 and 94 sailors at about 80
 * triangles each, and 82 boxes at 18 while the whole train is on the reach), no textures.
 * The Hatchery crowd is the same on every tier; the far groups thin out on the smaller ones.
 *
 * Query flags: sails=N (override the number of sailors), fleetseed=N (a different fleet, for
 * checks), hazecard=1 (debug ridge lines), watch=i[,dx,dy,dz] (debug: park the camera beside
 * sailor i, default 22 m upwind and 3 m up). The fleet's own checks: `check()` on this
 * module (ambient/fleetCheck.ts).
 */
import * as THREE from 'three'
import type { App, FeatureModule, Quality } from '../app/types'
import { Fleet } from './ambient/fleet'
import type { CheckRider } from './ambient/fleetCheck'
import { InstanceSet, makeAmbientMaterial } from './ambient/instances'
import { makeBox, makeKiter, makeWindsurfer, makeWingFoiler } from './ambient/shapes'
import { Tow, TOW_BOXES } from './ambient/traffic'
import { Train, TRAIN_BOXES } from './ambient/train'

/** The module also exposes its fleet and tow, for checks from the console and the capture tool. */
export interface AmbientModule extends FeatureModule {
  fleet: Fleet
  tow: Tow
  train: Train
  /** debug: the fleet's own checks, over `seconds` of the app's rider or a scripted one (see ambient/fleetCheck.ts) */
  check(seconds?: number, rider?: CheckRider): Promise<unknown>
}

export async function create(app: App): Promise<AmbientModule> {
  const group = new THREE.Group()
  app.scene.add(group)
  const shader = makeAmbientMaterial(app)

  const q = app.options.query
  const tow = new Tow(app)
  const train = new Train(app)
  const override = q.has('sails') ? Math.max(0, Math.min(200, Math.round(Number(q.get('sails')) || 0))) : -1
  const seed = q.has('fleetseed') ? Number(q.get('fleetseed')) || 0 : undefined
  const fleet = new Fleet(app, override, seed)
  fleet.tow = tow
  fleet.active = Math.min(fleet.n, fleet.activeFor(app.quality.tier))

  const wings = new InstanceSet(makeWingFoiler(), Math.max(1, fleet.n), shader.material)
  const windsurfers = new InstanceSet(makeWindsurfer(), Math.max(1, fleet.n), shader.material)
  const kites = new InstanceSet(makeKiter(), Math.max(1, fleet.n), shader.material)
  const boxes = new InstanceSet(makeBox(), TOW_BOXES + TRAIN_BOXES, shader.material)
  group.add(wings.mesh, windsurfers.mesh, kites.mesh, boxes.mesh)

  // debug: a camera that rides along with one sailor
  const watch = q.has('watch') ? (q.get('watch') ?? '').split(',').map(Number) : null

  const parts: { update(dt: number): void }[] = []
  if (q.has('hazecard')) {
    const { createHazeCard } = await import('./ambient/hazeCard')
    parts.push(createHazeCard(app))
  }

  const module: AmbientModule = {
    fleet,
    tow,
    train,
    async check(seconds = 600, rider: CheckRider = 'app') {
      const { checkFleet } = await import('./ambient/fleetCheck')
      return checkFleet(app, fleet, tow, (dt) => module.update(dt), () => module.reset?.(), seconds, rider)
    },
    update(dt) {
      group.position.x = app.groundShift
      shader.update()
      fleet.update(dt)
      fleet.write(wings, windsurfers, kites)
      tow.update(dt)
      boxes.commit(train.write(boxes, tow.write(boxes, 0)))
      for (const p of parts) p.update(dt)
      if (watch && fleet.n > 0) {
        const w = fleet.where(Math.max(0, Math.min(fleet.n - 1, watch[0] || 0)))
        const x = w.x + app.groundShift
        app.camera.position.set(x + (watch[1] ?? -22), w.y + (watch[2] ?? 3), w.z + (watch[3] ?? 0))
        app.camera.lookAt(x, w.y + 2, w.z)
      }
    },
    setQuality(quality: Quality) {
      fleet.active = Math.min(fleet.n, fleet.activeFor(quality.tier))
    },
    reset() {
      // the tow first: the fleet clears the water round wherever it has been put
      tow.reset()
      fleet.reset()
    },
    dispose() {
      app.scene.remove(group)
      wings.dispose(); windsurfers.dispose(); kites.dispose(); boxes.dispose()
      shader.material.dispose()
    },
  }
  return module
}
