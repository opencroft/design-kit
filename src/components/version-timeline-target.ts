// What a press on the version timeline grabs. The thumbs, the band between
// them and the bare track all want a finger-sized target, and on a short span
// they cannot all have one: two thumbs a step apart leave less than a
// finger's width between them. So the target is decided here from where the
// press lands, not by which element happens to be painted on top:
//
//   a thumb's visible disc       always that thumb
//   outward from a thumb         that thumb, up to HIT_REACH from its centre
//   between the two discs        the band, which keeps BAND_MIN of it; each
//                                thumb reaches inward over whatever the band
//                                can spare, up to HIT_REACH
//   anywhere else                the track
//
// The band is at least BAND_MIN wide wherever the thumbs are BAND_MIN plus a
// disc apart; below that it is everything between the discs, and nothing once
// the discs touch.

export type TimelineTarget = 'from' | 'to' | 'band' | 'track'

/** Half the visible thumb disc (the timeline draws it `size-4`), in px. */
export const DISC_RADIUS = 8
/** Half a finger-sized target (44px), in px. */
export const HIT_REACH = 22
/** The band's share of the gap between the discs, in px, before the thumbs
 *  reach into it. */
export const BAND_MIN = 44

/** The target of a press at `x`, with `fromX` and `toX` the centres of the
 *  two thumbs (`fromX <= toX`), all in px along the track. */
export function targetAt(x: number, fromX: number, toX: number): TimelineTarget {
  const fromDistance = Math.abs(x - fromX)
  const toDistance = Math.abs(x - toX)
  if (Math.min(fromDistance, toDistance) <= DISC_RADIUS) {
    // On overlapping discs the nearer centre wins; on one point, the side
    // pressed, so a joined thumb is grabbed by the end facing the press.
    if (fromDistance !== toDistance) {
      return fromDistance < toDistance ? 'from' : 'to'
    }
    return x < fromX ? 'from' : 'to'
  }
  if (x < fromX) {
    return fromDistance <= HIT_REACH ? 'from' : 'track'
  }
  if (x > toX) {
    return toDistance <= HIT_REACH ? 'to' : 'track'
  }
  const gap = toX - fromX - 2 * DISC_RADIUS
  const innerReach = DISC_RADIUS + Math.min(HIT_REACH - DISC_RADIUS, Math.max(0, (gap - BAND_MIN) / 2))
  if (fromDistance <= innerReach) {
    return 'from'
  }
  if (toDistance <= innerReach) {
    return 'to'
  }
  return 'band'
}
