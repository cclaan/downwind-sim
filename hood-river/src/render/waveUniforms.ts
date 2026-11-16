/**
 * The one way to feed the shared wave function (WAVE_GLSL) to a shader, so every material
 * that needs the water surface draws exactly the surface the physics rides.
 *
 *   const wave = makeWaveUniforms(app)
 *   new THREE.ShaderMaterial({ uniforms: { ...wave.uniforms, ...mine }, vertexShader: WAVE_GLSL + ... })
 *   // every frame, with the same origin the mesh positions are relative to:
 *   wave.update(originX, originZ)
 *
 * In the shader, waveSurface(p, lodCell) takes p = world position minus that origin.
 */
import * as THREE from 'three'
import type { App } from '../app/types'
import { LEVEL } from '../sim/level'
import { MAX_WAVE_COMPONENTS } from '../sim/waves'

export interface WaveUniforms {
  uniforms: {
    uWave: { value: Float32Array }
    uWaveCount: { value: number }
    uWaveK: { value: number }
    uWaveS: { value: number }
    uWaveEnv: { value: THREE.Vector4 }
    uWaveCrestNorm: { value: number }
    uWaveEnvMode: { value: number }
    uWaveEnvTex: { value: THREE.DataTexture }
    uWaveEnvRect: { value: THREE.Vector4 }
  }
  /** call once per frame; (originX, originZ) is what the shader's p is measured from */
  update(originX: number, originZ: number): void
}

let envTexture: THREE.DataTexture | null = null

/** The level's wave-size map as a texture (shared by every material). */
export function waveEnvTexture(): THREE.DataTexture {
  if (!envTexture) {
    const g = LEVEL.coarse
    envTexture = new THREE.DataTexture(LEVEL.env, g.nx, g.nz, THREE.RedFormat, THREE.UnsignedByteType)
    envTexture.magFilter = THREE.LinearFilter
    envTexture.minFilter = THREE.LinearFilter
    envTexture.wrapS = THREE.ClampToEdgeWrapping
    envTexture.wrapT = THREE.ClampToEdgeWrapping
    envTexture.generateMipmaps = false
    envTexture.unpackAlignment = 1
    envTexture.needsUpdate = true
  }
  return envTexture
}

export function makeWaveUniforms(app: App): WaveUniforms {
  const data = new Float32Array(MAX_WAVE_COMPONENTS * 4)
  const uniforms = {
    uWave: { value: data },
    uWaveCount: { value: 0 },
    uWaveK: { value: 0 },
    uWaveS: { value: 0 },
    uWaveEnv: { value: new THREE.Vector4() },
    uWaveCrestNorm: { value: 0.5 },
    uWaveEnvMode: { value: 1 },
    uWaveEnvTex: { value: waveEnvTexture() },
    uWaveEnvRect: { value: new THREE.Vector4() },
  }
  return {
    uniforms,
    update(originX: number, originZ: number) {
      const w = app.sim.waves
      const p = w.params
      w.fillUniforms(originX, originZ, app.time, data)
      uniforms.uWaveCount.value = w.n
      uniforms.uWaveK.value = w.K
      uniforms.uWaveS.value = w.S
      uniforms.uWaveCrestNorm.value = Math.max(0.05, 0.5 * p.hs)
      uniforms.uWaveEnv.value.set(p.channelZ - originZ, p.channelHalfWidth, p.channelFalloff, p.shoreScale)
      uniforms.uWaveEnvMode.value = w.level && p.useLevel > 0.5 ? 1 : 0
      // texel centres sit on the grid nodes, so the map's edge is half a cell outside x0/z0
      const g = LEVEL.coarse
      uniforms.uWaveEnvRect.value.set(
        g.x0 - 0.5 * g.step - originX + app.groundShift,
        g.z0 - 0.5 * g.step - originZ,
        1 / (g.nx * g.step),
        1 / (g.nz * g.step),
      )
    },
  }
}
