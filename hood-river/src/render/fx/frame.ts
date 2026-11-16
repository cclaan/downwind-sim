/**
 * The frame the water effects are drawn in, as slots of one Float64Array that fx.ts owns
 * and the buffers (decals.ts, spray.ts) read. It is shared this way, and not passed as
 * arguments, because a number handed to a function that the engine has not inlined is
 * boxed on the heap (V8): a dozen small allocations per frame for nothing.
 */
/** the time now, on the clock the stored birth times use */
export const F_NOW = 0
/** origin of the stored positions (world x and z) */
export const F_OX = 1
export const F_OZ = 2
/** length of the frame (s) */
export const F_DT = 3
/** the air's velocity in the water frame near the surface (m/s) */
export const F_WIND_X = 4
export const F_WIND_Z = 5
/** drawing-buffer pixels that one metre covers at one metre from the camera */
export const F_PX = 6
export const F_SLOTS = 7
