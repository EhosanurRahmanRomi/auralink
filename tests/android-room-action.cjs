'use strict';

// Native fixture helper: find stable physical bounds without invoking JavaScript
// or Accessibility actions. The caller still taps with Android's input command.
function rect(node) {
  const match = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  const box = match ? match.slice(1).map(Number) : null;
  return box && box.every(Number.isSafeInteger) && box[2] > box[0] && box[3] > box[1] ? box : null;
}
const appPackage = 'local.auralink.mobile';
function viewport(nodes) {
  const view = rect(nodes.find(node => node.class === 'android.webkit.WebView' && node.package === appPackage &&
    node['visible-to-user'] === 'true' && rect(node) && rect(node)[0] >= 0 && rect(node)[1] >= 0));
  if (!view) return null;
  const nav = rect(nodes.find(node => node.package === appPackage && node['visible-to-user'] === 'true' &&
    node.class === 'android.widget.Button' && (node.text === 'Rooms' || node['content-desc'] === 'Rooms')));
  const container = nav && nodes.map(rect).filter(box => box && box[0] <= view[0] && box[2] >= view[2] &&
    box[1] <= nav[1] && box[3] >= nav[3] && box[3] - box[1] <= 200).sort((a,b) => a[3]-a[1]-(b[3]-b[1]))[0];
  const area = [view[0], view[1] + 8, view[2], Math.min(view[3], container?.[1] ?? (nav ? nav[1] - 20 : view[3])) - 8];
  return area[3] > area[1] ? area : null;
}
function fits(node, area) {
  const box = rect(node);
  return Boolean(area && box && node['visible-to-user'] === 'true' &&
    box[0] >= area[0] && box[2] <= area[2] && box[1] >= area[1] && box[3] <= area[3]);
}
function gesturePath(nodes, area, direction) {
  if (!area) return null;
  const middle = Math.round((area[1] + area[3]) / 2), half = Math.round((area[3] - area[1]) * .23);
  if (half < 1) return null;
  const top = middle - half, bottom = middle + half;
  const blockers = nodes.filter(node => node['visible-to-user'] === 'true' &&
    (node.clickable === 'true' || node['long-clickable'] === 'true' || node['resource-id'] === 'stage-video' ||
      /^android\.widget\.(?:Button|ToggleButton|EditText|Spinner|SeekBar|Switch)$/.test(node.class || ''))).map(rect).filter(Boolean);
  for (const fraction of [.025,.975,.5,.25,.75]) {
    const x = Math.round(area[0] + (area[2] - area[0]) * fraction);
    if (x <= area[0] || x >= area[2] || blockers.some(box => x >= box[0] - 4 && x <= box[2] + 4 && bottom >= box[1] - 4 && top <= box[3] + 4)) continue;
    return [x,direction === 'earlier' ? top : bottom,x,direction === 'earlier' ? bottom : top];
  }
  return null;
}
function signature(nodes, area) {
  return nodes.filter(node => fits(node, area)).map(node => [node['resource-id'], node.class, node.bounds, node.text, node['content-desc']].join('|')).join('\n');
}
function diagnosticValue(label, nodes, valuePattern) {
  const area = viewport(nodes), labelBounds = rect(label);
  if (label?.package !== appPackage || !labelBounds || !fits(label,area)) return null;
  const values = nodes.filter(node => {
    const box = rect(node), text = node.text || node['content-desc'] || '';
    const packetCount = /^(\d+) packets$/.exec(text);
    return node !== label && node.package === appPackage && node.class === 'android.widget.TextView' && fits(node,area) &&
      box[0] >= labelBounds[2] && Math.abs(box[1] - labelBounds[1]) <= 3 && Math.abs(box[3] - labelBounds[3]) <= 3 &&
      (!packetCount || Number.isSafeInteger(Number(packetCount[1]))) && valuePattern.test(text);
  });
  return values.length === 1 ? values[0].text || values[0]['content-desc'] : null;
}
async function findRoomAction(predicate, {read, swipe, wait, now = Date.now, timeout = 30000, observe}) {
  const deadline = now() + timeout;
  let stableBounds, previousViewport, sameViewport = 0, direction = 'earlier', scans = 0, observedViewport = false;
  do {
    const nodes = await read(); const area = viewport(nodes); const node = nodes.find(value => value.package === appPackage && predicate(value,nodes));
    observe?.(nodes, node);
    if (now() >= deadline) break;
    // UiAutomation can briefly omit the app while returning only SystemUI.
    // Such a snapshot proves neither a scroll boundary nor an absent action.
    if (!area) { stableBounds = previousViewport = undefined; sameViewport = 0; await wait(300); continue; }
    observedViewport = true;
    if (node && fits(node, area)) {
      if (node.bounds === stableBounds) return node;
      stableBounds = node.bounds; await wait(300); continue;
    }
    stableBounds = undefined;
    if (!gesturePath(nodes,area,direction)) { previousViewport = undefined; sameViewport = 0; await wait(300); continue; }
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
    const path = gesturePath(nodes,area,direction);
    if (!path) { previousViewport = undefined; sameViewport = 0; await wait(300); continue; }
    await swipe(...path);
    await wait(500);
  } while (now() < deadline);
  throw new Error(observedViewport ? 'Room action did not expose stable fully visible native bounds before the deadline' :
    'Production WebView did not expose a valid observed viewport before the deadline');
}
module.exports = {findRoomAction, fits, viewport, gesturePath, diagnosticValue};
