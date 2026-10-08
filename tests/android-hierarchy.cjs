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

function immersiveTutorialButton(nodes) {
  const systemUI = 'com.android.systemui';
  const titles = nodes.filter(node => node.package === systemUI && node.class === 'android.widget.TextView' &&
    node['resource-id'] === `${systemUI}:id/immersive_cling_title` && node.text === 'Viewing full screen' &&
    node.enabled === 'true' && node['visible-to-user'] === 'true');
  const buttons = nodes.filter(node => node.package === systemUI && node.class === 'android.widget.Button' &&
    node['resource-id'] === `${systemUI}:id/ok` && node.text === 'Got it' && node.enabled === 'true' &&
    node.clickable === 'true' && node['visible-to-user'] === 'true');
  if (titles.length !== 1 || buttons.length !== 1) return null;
  const title = bounds(titles[0]), button = bounds(buttons[0]);
  if (!title || !button || [...title,...button].some(value => value < 0)) return null;
  const contains = (frame, box) => box[0] >= frame[0] && box[1] >= frame[1] && box[2] <= frame[2] && box[3] <= frame[3];
  const frame = nodes.find(node => node.package === systemUI && node.class === 'android.widget.FrameLayout' &&
    node['visible-to-user'] === 'true' && bounds(node) && contains(bounds(node),title) && contains(bounds(node),button));
  return frame ? buttons[0] : null;
}

function createImmersiveTutorialHandler({tap,onDismissed}) {
  let attempted = false;
  return async nodes => {
    const button = immersiveTutorialButton(nodes);
    if (!button) return false;
    if (attempted) throw new Error('Android fullscreen tutorial remained after its single observed dismissal');
    attempted = true;
    await tap(button);
    onDismissed();
    return true;
  };
}

module.exports = {visibleInWebView,immersiveTutorialButton,createImmersiveTutorialHandler};
