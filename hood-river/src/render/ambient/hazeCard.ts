/**
 * DEBUG ONLY, not loaded in normal play.
 *   ?hazecard=1       stand-in ridge lines at the real skyline distances, for tuning the air
 *                     and the sky without the terrain module: flat walls of forest- and
 *                     grass-coloured hill on arcs round the river off the Hatchery, shaded
 *                     with skyLight() and applyHaze() as the terrain is.
 *   ?hazecard=lights  built-in three.js materials under the sky module's lights and fog,
 *                     beside the same shapes drawn with skyLight() and applyHaze().
 *   ?hazecard=mirror  a flat mirror in place of the river showing skyColor() of the
 *                     reflected ray: what the water module is given to reflect, under the
 *                     sky that is drawn (use with off=water).
 */
import * as THREE from 'three'
import type { App } from '../../app/types'
import { SKY_GLSL } from '../atmosphere'
import { mulberry32 } from '../../sim/rng'

const DEG = Math.PI / 180

/** range (m), bearing from..to (degrees, 0 = +x downwind, positive toward Oregon), peak elevation (degrees), albedo */
const RIDGES: [number, number, number, number, number][] = [
  // Oregon cliff and rim: dark fir, in shade
  [900, 40, 175, 5.0, 0x2e4a34],
  // Washington wall: cured grass
  [1500, -150, -20, 12.0, 0xb89a6a],
  // Mitchell Point and the ridges stepping into the notch from the Oregon side
  [5000, 150, 172, 4.6, 0x2e4a34],
  [8000, 158, 176, 4.4, 0x2e4a34],
  [14000, 163, 178, 5.2, 0x2e4a34],
  [22000, 168, 182, 3.0, 0x2e4a34],
  // from the Washington side
  [3000, -160, -146, 5.4, 0x3a5238],
  [5000, -166, -152, 4.0, 0x2e4a34],
  [8000, -170, -158, 2.8, 0x2e4a34],
  [12000, -174, -164, 2.0, 0x2e4a34],
  // far end of the notch
  [36000, 172, 190, 1.3, 0x2e4a34],
  // downwind: Underwood bluff, Bingen bluff, Burdoin Mountain, the plateau
  [3200, -22, 4, 3.2, 0x8f7d5a],
  [6000, -34, 10, 4.4, 0x9a8460],
  [9000, -12, 22, 4.0, 0xa08a66],
  [16000, 8, 34, 1.5, 0x9c8d7c],
  [7000, 36, 60, 3.6, 0x4a5a40],
]

export function createHazeCard(app: App): { update(): void } {
  const group = new THREE.Group()
  const positions: number[] = []
  const colors: number[] = []
  const normals: number[] = []
  const index: number[] = []
  const rand = mulberry32(99)
  const c = new THREE.Color()
  for (const [range, b0, b1, peak, albedo] of RIDGES) {
    c.setHex(albedo)
    const n = 48
    const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28]
    const start = positions.length / 3
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const b = (b0 + (b1 - b0) * t) * DEG
      const taper = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.6
      const lumps = 0.72 + 0.16 * Math.sin(t * 9 + ph[0]) + 0.08 * Math.sin(t * 23 + ph[1]) + 0.04 * Math.sin(t * 57 + ph[2])
      const top = range * Math.tan(peak * DEG * taper * lumps)
      const x = Math.cos(b) * range, z = Math.sin(b) * range
      positions.push(x, -2, z, x, top, z)
      // slope faces the river and tilts up
      const nx = -Math.cos(b) * 0.8, nz = -Math.sin(b) * 0.8
      normals.push(nx, 0.6, nz, nx, 0.6, nz)
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b)
      if (i < n) {
        const a = start + i * 2
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geo.setIndex(index)
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...app.atmos.uniforms },
    vertexColors: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vColor = color;
        vN = normal;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${SKY_GLSL}
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vec3 col = vColor * skyLight(normalize(vN));
        col = applyHaze(col, distance(cameraPosition, vWorld));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.frustumCulled = false
  if (app.options.query.get('hazecard') === '1') group.add(mesh)
  app.scene.add(group)

  // ?hazecard=lights: built-in materials under the sky module's lights and fog. A white, a
  // mid-grey and a wetsuit-dark ball beside the rider's start, and white towers at 1, 3, 6
  // and 12 km whose fade can be compared with the shader ridges.
  if (app.options.query.get('hazecard') === 'lights') {
    const ball = new THREE.SphereGeometry(0.9, 24, 16)
    const cols = [0xf2f2ee, 0x808080, 0x1d2a33]
    for (let i = 0; i < 3; i++) {
      const lambert = new THREE.Mesh(ball, new THREE.MeshLambertMaterial({ color: cols[i] }))
      lambert.position.set(-205, 1.6, -306 + i * 2.2)
      const standard = new THREE.Mesh(ball, new THREE.MeshStandardMaterial({ color: cols[i], roughness: 0.6 }))
      standard.position.set(-205, 3.8, -306 + i * 2.2)
      group.add(lambert, standard)
    }
    const tower = new THREE.BoxGeometry(1, 1, 1)
    for (const d of [1000, 3000, 6000, 12000]) {
      for (const dir of [1, -1]) {
        const builtin = new THREE.Mesh(tower, new THREE.MeshLambertMaterial({ color: 0xffffff }))
        builtin.scale.set(d * 0.03, d * 0.08, d * 0.03)
        builtin.position.set(-220 + dir * d, d * 0.04, -300 - d * 0.05)
        const shader = new THREE.Mesh(tower, mat)
        shader.scale.copy(builtin.scale)
        shader.position.set(-220 + dir * d, d * 0.04, -300 + d * 0.05)
        const n = shader.geometry.attributes.position.count
        if (!tower.getAttribute('color')) tower.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
        group.add(builtin, shader)
      }
    }
  }
  let mirror: THREE.Mesh | null = null
  if (app.options.query.get('hazecard') === 'mirror') {
    const plane = new THREE.PlaneGeometry(60000, 60000)
    plane.rotateX(-Math.PI / 2)
    mirror = new THREE.Mesh(plane, new THREE.ShaderMaterial({
      uniforms: { ...app.atmos.uniforms },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        ${SKY_GLSL}
        varying vec3 vWorld;
        void main() {
          vec3 v = normalize(vWorld - cameraPosition);
          gl_FragColor = vec4(skyColor(reflect(v, vec3(0.0, 1.0, 0.0))), 1.0);
          #include <colorspace_fragment>
        }
      `,
    }))
    mirror.frustumCulled = false
    app.scene.add(mirror)
  }
  return {
    update() {
      group.position.x = app.groundShift
      if (mirror) mirror.position.set(app.camera.position.x, 0, app.camera.position.z)
    },
  }
}
