/**
 * Small in-place radix-2 FFT, used once at load to synthesise the tileable water textures
 * (a field built from integer wavenumbers repeats exactly at the texture edge).
 */

/** In-place complex FFT of length n (power of two). inverse = true gives the unscaled inverse. */
export function fft1d(re: Float64Array, im: Float64Array, offset: number, stride: number, n: number, inverse: boolean): void {
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const a = offset + i * stride
      const b = offset + j * stride
      const tr = re[a]; re[a] = re[b]; re[b] = tr
      const ti = im[a]; im[a] = im[b]; im[b] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < half; k++) {
        const a = offset + (i + k) * stride
        const b = offset + (i + k + half) * stride
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

/** In-place unscaled inverse 2-D FFT of an n x n complex field stored row-major. */
export function ifft2d(re: Float64Array, im: Float64Array, n: number): void {
  for (let r = 0; r < n; r++) fft1d(re, im, r * n, 1, n, true)
  for (let c = 0; c < n; c++) fft1d(re, im, c, n, n, true)
}
