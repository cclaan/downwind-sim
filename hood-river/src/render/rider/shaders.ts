/**
 * The rider's two shader programs: instanced capsules (the body, the paddle and the foil)
 * and a plain vertex-coloured mesh (the board). Both light with the shared atmosphere so
 * the rider sits in the same light and haze as the water and the land, with or without
 * the sky module's scene lights.
 */
import { SKY_GLSL } from '../atmosphere'

/**
 * One capsule per instance, given as two end points with a radius each (so limbs taper), a
 * "wide" direction and a squash factor for the thin axis (so a chest, a foot, a paddle
 * blade and a wing are all the same primitive). The base mesh is a unit sphere cut at the
 * equator; `aEnd` says which end a vertex belongs to.
 *
 * Thin parts are never allowed to fall below a set number of pixels, so the paddle shaft
 * and the mast stay solid lines on a phone instead of crawling dots. A part only a few
 * pixels wide also loses its gloss (all of it under two pixels, none of it from eight): with
 * no antialiasing each of its pixels would be either rim (sky sheen, white) or middle
 * (black), a dashed line that crawls as it moves.
 */
export const CAPSULE_VERT = /* glsl */ `
precision highp float;
attribute float aEnd;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iS;
attribute vec4 iC;
uniform float uPx;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
void main() {
  // a hidden capsule (squash < 0): every vertex outside the clip volume, so nothing is drawn
  if (iS.w < 0.0) {
    vN = vec3(0.0); vW = vec3(0.0); vC = vec4(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 ax = iB.xyz - iA.xyz;
  float len = length(ax);
  vec3 Y = len > 1e-5 ? ax / len : vec3(0.0, 1.0, 0.0);
  vec3 S = iS.xyz - Y * dot(iS.xyz, Y);
  float sl = length(S);
  if (sl > 1e-4) S /= sl;
  else S = normalize(cross(Y, abs(Y.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 X = cross(Y, S);
  vec3 c = mix(iA.xyz, iB.xyz, aEnd);
  vec4 wc = modelMatrix * vec4(c, 1.0);
  float minR = uPx * distance(cameraPosition, wc.xyz);
  float r = max(mix(iA.w, iB.w, aEnd), minR);
  float thin = max(iS.w * r, minR);
  vec3 p = position;
  vec3 off = X * (p.x * thin) + Y * (p.y * r) + S * (p.z * r);
  vec3 n = X * (p.x * r / thin) + Y * p.y + S * p.z;
  mat3 rot = mat3(modelMatrix);
  vW = wc.xyz + rot * off;
  vN = rot * n;
  // (r / minR = half its width in pixels over half the least width)
  vC = vec4(iC.rgb, iC.a * smoothstep(1.5, 6.5, r / max(minR, 1e-6)));
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`

export const MESH_VERT = /* glsl */ `
precision highp float;
attribute vec4 aColor;
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = mat3(modelMatrix) * normal;
  vC = aColor;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`

/**
 * Sun plus a sky/water hemisphere. The colour's alpha is gloss: a wet highlight from the
 * sun and a sky sheen at grazing angles (neoprene, a glassed board, a carbon blade).
 */
export const LIT_FRAG = /* glsl */ `
precision highp float;
${SKY_GLSL}
varying vec3 vN;
varying vec3 vW;
varying vec4 vC;
void main() {
  vec3 N = normalize(vN);
  vec3 V = cameraPosition - vW;
  float dist = length(V);
  V /= max(dist, 1e-4);
  float ndl = dot(N, uSunDir);
  // the shared sun + hemisphere light (as skyLight), with a little wrap on the sun term so
  // the terminator on a round limb is not a hard line
  float sun = 0.8 * max(ndl, 0.0) + 0.2 * max((ndl + 0.35) / 1.35, 0.0);
  vec3 amb = mix(uAmbientGround, uAmbientSky, N.y * 0.5 + 0.5);
  vec3 col = vC.rgb * (uSunLight * sun + amb);
  float gloss = vC.a;
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * step(0.0, ndl);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  col += uSunLight * (spec * gloss) + uAmbientSky * (fres * gloss * 1.2);
  col = applyHaze(col, dist);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
