'use strict';

function bounds(node) {
  const match = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  if (!match) return null;
  const box = match.slice(1).map(Number);
  return box.every(Number.isSafeInteger) && box[2] > box[0] && box[3] > box[1] ? box : null;
}

// Presentation hides Android's bars and expands the native WebView. Use its
// current observed rectangle, not the ordinary room's fixed navigation inset.
// A clipped or hidden action must never count as a visible fullscreen control.
function visibleInWebView(node, nodes) {
  if (node?.['visible-to-user'] !== 'true' || !node.package) return false;
  const box = bounds(node);
  const view = nodes.find(candidate => candidate.class === 'android.webkit.WebView' &&
    candidate.package === node.package && candidate['visible-to-user'] === 'true');
  const viewport = bounds(view);
  return Boolean(box && viewport && box[0] >= viewport[0] && box[1] >= viewport[1] &&
    box[2] <= viewport[2] && box[3] <= viewport[3]);
}

module.exports = {visibleInWebView};
