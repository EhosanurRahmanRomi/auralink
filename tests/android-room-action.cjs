'use strict';

// Native fixture helper: find stable physical bounds without invoking JavaScript
// or Accessibility actions. The caller still taps with Android's input command.
function rect(node) {
  const match = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  return match ? match.slice(1).map(Number) : null;
}
function viewport(nodes) {
  const view = rect(nodes.find(node => node.class === 'android.webkit.WebView')) || [0, 136, 720, 1245];
  const nav = rect(nodes.find(node => node.class === 'android.widget.Button' && (node.text === 'Rooms' || node['content-desc'] === 'Rooms')));
  const container = nav && nodes.map(rect).filter(box => box && box[0] <= view[0] && box[2] >= view[2] &&
    box[1] <= nav[1] && box[3] >= nav[3] && box[3] - box[1] <= 200).sort((a,b) => a[3]-a[1]-(b[3]-b[1]))[0];
  return [view[0], view[1] + 8, view[2], Math.min(view[3], container?.[1] ?? (nav ? nav[1] - 20 : 1147)) - 8];
}
function fits(node, area) {
  const box = rect(node);
  return Boolean(box && node['visible-to-user'] !== 'false' && box[2] > box[0] && box[3] > box[1] &&
    box[0] >= area[0] && box[2] <= area[2] && box[1] >= area[1] && box[3] <= area[3]);
}
function signature(nodes, area) {
  return nodes.filter(node => fits(node, area)).map(node => [node['resource-id'], node.class, node.bounds, node.text, node['content-desc']].join('|')).join('\n');
}
async function findRoomAction(predicate, {read, swipe, wait, now = Date.now, timeout = 30000, observe}) {
  const deadline = now() + timeout;
  let stableBounds, previousViewport, sameViewport = 0, direction = 'earlier', scans = 0;
  do {
    const nodes = await read(); const area = viewport(nodes); const node = nodes.find(predicate);
    observe?.(nodes, node);
    if (node && fits(node, area)) {
      if (node.bounds === stableBounds) return node;
      stableBounds = node.bounds; await wait(300); continue;
    }
    stableBounds = undefined;
    const box = rect(node);
    if (box && box[3] > box[1]) {
      // Above the viewport needs a downward finger swipe; below needs upward.
      direction = box[1] < area[1] ? 'earlier' : 'later';
      previousViewport = undefined; sameViewport = 0; scans = 0;
    } else {
      // WebView omits offscreen nodes. Search back to the top, then advance in
      // overlapping steps rather than assuming an absent action lies below.
      const current = signature(nodes, area);
      sameViewport = current === previousViewport ? sameViewport + 1 : 0;
      previousViewport = current;
      if (sameViewport >= 2 || scans >= 8) {
        if (direction === 'later') throw new Error('Room action is absent after searching the native viewport in both directions');
        direction = 'later'; previousViewport = undefined; sameViewport = 0; scans = 0;
      }
      scans++;
    }
    const x = Math.round(area[2] - (area[2] - area[0]) * .07);
    const middle = Math.round((area[1] + area[3]) / 2);
    const half = Math.round((area[3] - area[1]) * .23);
    await swipe(x, direction === 'earlier' ? middle - half : middle + half, x, direction === 'earlier' ? middle + half : middle - half);
    await wait(500);
  } while (now() < deadline);
  throw new Error('Room action did not expose stable fully visible native bounds before the deadline');
}
module.exports = {findRoomAction, fits, viewport};
