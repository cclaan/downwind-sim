/**
 * A realistic rider: a skinned character (a GLB with a Mixamo skeleton, in public/characters)
 * posed every frame from the solved Rig, in place of the capsule figure. The paddle, board
 * and foil stay as they are.
 *
 * Each bone is turned so that it points from its joint to the next joint the Rig solved, and
 * rolled by the Rig's facing directions (pelvis, chest, gaze, knee and elbow poles, soles), so
 * everything the animator does carries over: strokes, pumps, carves, the crash and the climb
 * back on. The Rig's body sizes (BODY) are taken from the model when it is shown, so the feet
 * stay on the deck and the hands on the paddle.
 *
 * Frames: the holder group is the board frame (+X nose, +Y deck normal, +Z starboard), which
 * is also the Rig's frame. The models face +Z with their left side at +X in their rest pose,
 * which is the rider's own stance (chest to the toe-side rail, left foot forward), so the
 * rest pose needs no turning.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { Rig } from './rig'
import { BODY } from './tune'

export type CharacterName = 'man' | 'woman' | 'capsules'

export interface CharacterSpec {
  label: string
  /**
   * 512 px textures on every device: rendered side by side at Retina desktop size, from the
   * closest camera, 1024 px ones looked the same (the rider is at most ~600 px tall on screen)
   */
  file: string
  /** standing height the model is scaled to (m) */
  height: number
}

export const CHARACTERS: Record<Exclude<CharacterName, 'capsules'>, CharacterSpec> = {
  man: { label: 'Man', file: 'characters/man-foiler.glb', height: 1.78 },
  woman: { label: 'Woman', file: 'characters/woman-foiler.glb', height: 1.68 },
}

/** the capsule figure's body sizes, put back when the capsules are shown again */
export const BODY_DEFAULT = { ...BODY }

const BONES = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTopEnd',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
] as const
type BoneName = (typeof BONES)[number]

/** bones the Rig drives, parents before children */
const DRIVEN: BoneName[] = [
  'Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
]

const V = () => new THREE.Vector3()
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1)
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion()
const _a = V(), _b = V(), _c = V(), _d = V(), _w = V()

/** rotation whose X axis is u and whose Y axis is v made perpendicular to u */
function basis(u: THREE.Vector3, v: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  _w.copy(v).addScaledVector(u, -v.dot(u))
  if (_w.lengthSq() < 1e-8) {
    _w.copy(Math.abs(u.y) < 0.9 ? Y : X).addScaledVector(u, -(Math.abs(u.y) < 0.9 ? u.y : u.x))
  }
  _w.normalize()
  _d.crossVectors(u, _w)
  _m.makeBasis(u, _w, _d)
  return out.setFromRotationMatrix(_m)
}

/** unit direction from a to b (or `fallback` if they meet) */
function dir(a: THREE.Vector3, b: THREE.Vector3, out: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  out.subVectors(b, a)
  const l = out.length()
  return l > 1e-6 ? out.multiplyScalar(1 / l) : out.copy(fallback)
}

/** unit blend of two directions */
function mixDir(a: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(a).multiplyScalar(1 - t).addScaledVector(b, t)
  return out.lengthSq() > 1e-8 ? out.normalize() : out.copy(b)
}

interface BoneData {
  bone: THREE.Bone
  parent: BoneName | null
  /** rest position and orientation in the holder (board) frame */
  p0: THREE.Vector3
  q0: THREE.Quaternion
  /** basis(rest primary, rest secondary)^-1 * q0: target basis * this = the bone's orientation */
  off: THREE.Quaternion
  /** this frame's position and orientation in the holder frame */
  p: THREE.Vector3
  q: THREE.Quaternion
}

export class SkinnedRider {
  readonly holder = new THREE.Group()
  readonly triangles: number
  /** the Rig's body sizes for this model */
  readonly body: typeof BODY
  private readonly bones = new Map<BoneName, BoneData>()
  private readonly armatureQ = new THREE.Quaternion()
  private readonly armatureInv = new THREE.Matrix4()
  private readonly midHips0 = V()
  /** ball of the foot from the ankle in the rest pose: forward and down (m) */
  private readonly ballFwd: number
  private readonly ballDown: number
  private readonly disposables: { dispose(): void }[] = []

  constructor(gltf: { scene: THREE.Group }, spec: CharacterSpec) {
    const root = gltf.scene
    let mesh: THREE.SkinnedMesh | null = null
    const found = new Map<string, THREE.Bone>()
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh && !mesh) mesh = o as THREE.SkinnedMesh
      if ((o as THREE.Bone).isBone) found.set(o.name.replace(/[^A-Za-z0-9]/g, '').replace(/^mixamorig\d*/, ''), o as THREE.Bone)
    })
    if (!mesh) throw new Error('character: no skinned mesh')
    const skinned = mesh as THREE.SkinnedMesh
    for (const name of BONES) if (!found.has(name)) throw new Error(`character: no bone ${name}`)

    // scale to the wanted height, measured on the mesh in its rest pose
    skinned.geometry.computeBoundingBox()
    const box = skinned.geometry.boundingBox as THREE.Box3
    const s = spec.height / Math.max(0.5, box.max.y - box.min.y)
    root.scale.multiplyScalar(s)
    root.position.y -= box.min.y * s
    this.holder.add(root)
    this.holder.updateMatrixWorld(true)

    skinned.frustumCulled = false
    this.triangles = (skinned.geometry.index ? skinned.geometry.index.count : skinned.geometry.attributes.position.count) / 3
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.frustumCulled = false
        this.disposables.push(m.geometry)
        const mats = Array.isArray(m.material) ? m.material : [m.material]
        for (const mat of mats) {
          this.disposables.push(mat)
          for (const v of Object.values(mat)) if (v && (v as THREE.Texture).isTexture) this.disposables.push(v as THREE.Texture)
        }
      }
    })

    // rest pose in the holder frame (the holder sits at the origin, so world = holder here)
    const hips = found.get('Hips') as THREE.Bone
    const armature = hips.parent as THREE.Object3D
    armature.getWorldQuaternion(this.armatureQ)
    this.armatureInv.copy(armature.matrixWorld).invert()
    for (const name of BONES) {
      const bone = found.get(name) as THREE.Bone
      const parentName = (BONES as readonly string[]).find((n) => found.get(n) === bone.parent) as BoneName | undefined
      this.bones.set(name, {
        bone, parent: parentName ?? null,
        p0: bone.getWorldPosition(V()), q0: bone.getWorldQuaternion(new THREE.Quaternion()),
        off: new THREE.Quaternion(), p: V(), q: new THREE.Quaternion(),
      })
    }
    const P = (n: BoneName) => (this.bones.get(n) as BoneData).p0
    this.midHips0.addVectors(P('LeftUpLeg'), P('RightUpLeg')).multiplyScalar(0.5)

    // each bone's rest primary (toward the next joint) and secondary (a facing or a pole)
    const back = V().set(0, 0, -1)
    const rest: Record<BoneName, [THREE.Vector3, THREE.Vector3] | null> = {
      Hips: [Y, Z],
      Spine: [dir(P('Spine'), P('Spine1'), V(), Y), Z],
      Spine1: [dir(P('Spine1'), P('Spine2'), V(), Y), Z],
      Spine2: [dir(P('Spine2'), P('Neck'), V(), Y), Z],
      Neck: [dir(P('Neck'), P('Head'), V(), Y), Z],
      Head: [dir(P('Head'), P('HeadTopEnd'), V(), Y), Z],
      HeadTopEnd: null,
      LeftShoulder: [dir(P('LeftShoulder'), P('LeftArm'), V(), X), Y],
      LeftArm: [dir(P('LeftArm'), P('LeftForeArm'), V(), X), back],
      LeftForeArm: [dir(P('LeftForeArm'), P('LeftHand'), V(), X), back],
      LeftHand: [dir(P('LeftForeArm'), P('LeftHand'), V(), X), back],
      RightShoulder: [dir(P('RightShoulder'), P('RightArm'), V(), X), Y],
      RightArm: [dir(P('RightArm'), P('RightForeArm'), V(), X), back],
      RightForeArm: [dir(P('RightForeArm'), P('RightHand'), V(), X), back],
      RightHand: [dir(P('RightForeArm'), P('RightHand'), V(), X), back],
      LeftUpLeg: [dir(P('LeftUpLeg'), P('LeftLeg'), V(), Y), Z],
      LeftLeg: [dir(P('LeftLeg'), P('LeftFoot'), V(), Y), Z],
      LeftFoot: [dir(P('LeftFoot'), P('LeftToeBase'), V(), Z), X],
      LeftToeBase: [Z, X],
      RightUpLeg: [dir(P('RightUpLeg'), P('RightLeg'), V(), Y), Z],
      RightLeg: [dir(P('RightLeg'), P('RightFoot'), V(), Y), Z],
      RightFoot: [dir(P('RightFoot'), P('RightToeBase'), V(), Z), X],
      RightToeBase: [Z, X],
    }
    for (const name of DRIVEN) {
      const b = this.bones.get(name) as BoneData
      const [u, v] = rest[name] as [THREE.Vector3, THREE.Vector3]
      b.off.copy(basis(u, v, _q).invert()).multiply(b.q0)
    }
    const ball = V().subVectors(P('LeftToeBase'), P('LeftFoot')).add(_a.subVectors(P('RightToeBase'), P('RightFoot'))).multiplyScalar(0.5)
    this.ballFwd = Math.max(0.03, ball.z)
    this.ballDown = Math.max(0, -ball.y)

    // the Rig's body sizes, measured on the model
    const L = (a: BoneName, b: BoneName) => P(a).distanceTo(P(b))
    const avg = (a: number, b: number) => 0.5 * (a + b)
    const k = spec.height / 1.78
    const trunk = Math.max(0.3, P('Neck').y - this.midHips0.y)
    const lowShare = BODY_DEFAULT.spineLow / (BODY_DEFAULT.spineLow + BODY_DEFAULT.spineUp)
    const wrist = avg(L('LeftForeArm', 'LeftHand'), L('RightForeArm', 'RightHand'))
    this.body = {
      ...BODY_DEFAULT,
      thigh: avg(L('LeftUpLeg', 'LeftLeg'), L('RightUpLeg', 'RightLeg')),
      shin: avg(L('LeftLeg', 'LeftFoot'), L('RightLeg', 'RightFoot')),
      ankle: Math.max(0.03, avg(P('LeftFoot').y, P('RightFoot').y)),
      hipHalf: 0.5 * L('LeftUpLeg', 'RightUpLeg'),
      spineLow: trunk * lowShare,
      spineUp: trunk * (1 - lowShare),
      shoulderHalf: 0.5 * Math.abs(P('LeftArm').x - P('RightArm').x),
      shoulderDrop: Math.max(0, P('Neck').y - avg(P('LeftArm').y, P('RightArm').y)),
      neck: L('Neck', 'Head'),
      head: 0.45 * Math.max(0.1, P('HeadTopEnd').y - P('Head').y),
      headRadius: BODY_DEFAULT.headRadius * k,
      upperArm: avg(L('LeftArm', 'LeftForeArm'), L('RightArm', 'RightForeArm')),
      wrist,
      foreArm: wrist + (BODY_DEFAULT.foreArm - BODY_DEFAULT.wrist) * k,
      footLen: BODY_DEFAULT.footLen * k,
      footBack: BODY_DEFAULT.footBack * k,
    }
  }

  /** set a bone's orientation from a primary and a secondary direction (holder frame) */
  private orient(name: BoneName, u: THREE.Vector3, v: THREE.Vector3): void {
    const b = this.bones.get(name) as BoneData
    basis(u, v, b.q).multiply(b.off)
    // position from its parent, which has already been posed
    if (b.parent) {
      const p = this.bones.get(b.parent) as BoneData
      _q2.copy(p.q0).invert().premultiply(p.q)
      b.p.subVectors(b.p0, p.p0).applyQuaternion(_q2).add(p.p)
    }
  }

  /** where a bone sits this frame, from its parent (before it is turned itself) */
  private placed(name: BoneName): THREE.Vector3 {
    const b = this.bones.get(name) as BoneData
    const p = this.bones.get(b.parent as BoneName) as BoneData
    _q2.copy(p.q0).invert().premultiply(p.q)
    return b.p.subVectors(b.p0, p.p0).applyQuaternion(_q2).add(p.p)
  }

  /** pose the model from this frame's solved Rig */
  pose(rig: Rig): void {
    const up = dir(rig.pelvis, rig.waist, V0, rig.torso)
    // hips: up the lower spine, facing the pelvis; placed so the hip joints meet the Rig's
    const hips = this.bones.get('Hips') as BoneData
    this.orient('Hips', up, rig.pelvisFwd)
    _q2.copy(hips.q0).invert().premultiply(hips.q)
    hips.p.subVectors(hips.p0, this.midHips0).applyQuaternion(_q2).add(rig.pelvis)

    // spine: from the pelvis's lean and facing to the chest's
    this.orient('Spine', mixDir(up, rig.torso, 0.15, V1), mixDir(rig.pelvisFwd, rig.chestFwd, 0.25, V2))
    this.orient('Spine1', mixDir(up, rig.torso, 0.55, V1), mixDir(rig.pelvisFwd, rig.chestFwd, 0.6, V2))
    this.orient('Spine2', rig.torso, rig.chestFwd)
    this.orient('Neck', mixDir(rig.torso, rig.headUp, 0.4, V1), mixDir(rig.chestFwd, rig.gaze, 0.4, V2))
    this.orient('Head', rig.headUp, rig.gaze)

    // arms: collarbone to the Rig's shoulder joint, then shoulder -> elbow -> wrist -> palm
    for (let side = 0; side < 2; side++) {
      const L = side === 0
      const sh = L ? rig.shoulderL : rig.shoulderR
      const el = L ? rig.elbowL : rig.elbowR
      const palm = L ? rig.palmL : rig.palmR
      const pole = L ? rig.elbowPoleL : rig.elbowPoleR
      const n: [BoneName, BoneName, BoneName, BoneName] = L
        ? ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand']
        : ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand']
      this.orient(n[0], dir(this.placed(n[0]), sh, V1, L ? X : NX), rig.torso)
      this.orient(n[1], dir(this.placed(n[1]), el, V1, NY), pole)
      const fore = dir(el, palm, V3, NY)
      _c.copy(el).addScaledVector(fore, BODY.wrist)
      this.orient(n[2], dir(this.placed(n[2]), _c, V1, fore), pole)
      this.orient(n[3], fore, pole)
    }

    // legs: hip -> knee -> ankle, then the foot down to the ball and the toes along the sole
    for (let side = 0; side < 2; side++) {
      const L = side === 0
      const knee = L ? rig.kneeL : rig.kneeR
      const ankle = L ? rig.footL : rig.footR
      const pole = L ? rig.kneePoleL : rig.kneePoleR
      const toe = L ? rig.toeDirL : rig.toeDirR
      const sole = L ? rig.soleUpL : rig.soleUpR
      const n: [BoneName, BoneName, BoneName, BoneName] = L
        ? ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase']
        : ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase']
      this.orient(n[0], dir(this.placed(n[0]), knee, V1, NY), pole)
      this.orient(n[1], dir(this.placed(n[1]), ankle, V1, NY), pole)
      // lateral axis of the foot: the sole's up crossed with the way the toes point
      _b.crossVectors(sole, toe)
      if (_b.lengthSq() < 1e-8) _b.copy(X)
      _b.normalize()
      _a.copy(ankle).addScaledVector(toe, this.ballFwd).addScaledVector(sole, -this.ballDown)
      this.orient(n[2], dir(this.placed(n[2]), _a, V1, toe), _b)
      V3.copy(toe).addScaledVector(sole, -toe.dot(sole))
      if (V3.lengthSq() < 1e-8) V3.copy(toe)
      this.orient(n[3], V3.normalize(), _b)
    }

    // write the bones: local orientation = parent's^-1 * own; the hips also get their place
    for (const name of DRIVEN) {
      const b = this.bones.get(name) as BoneData
      const parentQ = b.parent ? (this.bones.get(b.parent) as BoneData).q : this.armatureQ
      b.bone.quaternion.copy(parentQ).invert().multiply(b.q)
    }
    hips.bone.position.copy(hips.p).applyMatrix4(this.armatureInv)
  }

  dispose(): void {
    this.holder.removeFromParent()
    for (const d of this.disposables) d.dispose()
  }
}

const V0 = V(), V1 = V(), V2 = V(), V3 = V()
const NX = new THREE.Vector3(-1, 0, 0), NY = new THREE.Vector3(0, -1, 0)

/** load a character's GLB */
export async function loadCharacter(spec: CharacterSpec): Promise<SkinnedRider> {
  const url = new URL(spec.file, document.baseURI).href
  const gltf = await new GLTFLoader().loadAsync(url)
  return new SkinnedRider(gltf, spec)
}
