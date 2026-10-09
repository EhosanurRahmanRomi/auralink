'use strict';

// Native fixture helper: find stable physical bounds without invoking JavaScript
// or Accessibility actions. The caller still taps with Android's input command.
function rect(node) {
  const match = node?.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
  const box = match ? match.slice(1).map(Number) : null;
  return box && box.every(Number.isSafeInteger) && box[2] > box[0] && box[3] > box[1] ? box : null;
}
const appPackage = 'local.auralink.mobile';
function parseNativeHierarchy(xml) {
  const nodes=[],ancestors=[];let window=null,root;
  const decode=value=>value.replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
  for(const [,closing,tag,attributes,selfClosing] of xml.matchAll(/<(\/?)(window|node)\b([^>]*?)(\/?)>/g)) {
    if(closing) {if(tag==='node')ancestors.pop();else {window=null;root=undefined;}continue;}
    const values=Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)]));
    if(tag==='window') {window=values;root=undefined;ancestors.length=0;continue;}
    if(root===undefined)root=nodes.length;
    const node={...values,_observerWindowId:window?.id,_observerWindowType:window?.type,_observerWindowRoot:root,
      _observerAncestors:[...ancestors]};
    nodes.push(node);if(!selfClosing)ancestors.push(nodes.length-1);
  }
  return nodes;
}
function nativeQualityOption(nodes,quality) {
  if(!['720','1080'].includes(quality))return null;
  const contained=(node,container)=>fits(node,rect(container));
  const views=nodes.filter(node=>node.package===appPackage && node.class==='android.webkit.WebView' && node._observerWindowType==='1' && node._observerWindowId &&
    node['visible-to-user']==='true' && rect(node)?.every(value=>value>=0));
  const options=[];
  for(const node of nodes) {
    if(node.package!==appPackage || !['android.widget.CheckedTextView','android.widget.TextView'].includes(node.class) ||
      node.text!==`${quality}p` || node.enabled!=='true' || node['visible-to-user']!=='true' ||
      !rect(node) || node._observerWindowType!=='1' || !node._observerWindowId || !Array.isArray(node._observerAncestors))continue;
    const root=nodes[node._observerWindowRoot];
    if(!root || root.package!==appPackage || root._observerWindowId!==node._observerWindowId ||
      root['visible-to-user']!=='true' || !rect(root)?.every(value=>value>=0) || !contained(node,root))continue;
    const containers=node._observerAncestors.map(index=>nodes[index]).filter(parent=>parent && parent.package===appPackage &&
      parent._observerWindowId===node._observerWindowId && parent.class==='android.widget.ListView' &&
      parent['visible-to-user']==='true' && parent.enabled==='true' && contained(node,parent) && contained(parent,root));
    if(containers.length!==1)continue;
    // A native dropdown lives in its own observed application window. Require
    // the row to fit the current visible WebView too, including owner resizes.
    const view=views.find(value=>value._observerWindowId!==node._observerWindowId && contained(node,value));
    if(!view)continue;
    const container=containers[0];
    // Window IDs associate nodes within this snapshot. A fresh UiAutomation
    // connection can renumber them, so compare owner identity and geometry
    // across consecutive observations rather than the connection's IDs.
    options.push({node,container,root,view,identity:JSON.stringify([node.text,...[node,container,root,view]
      .map(value=>[value.package,value.class,value['resource-id'] || '',value.bounds])])});
  }
  return options.length===1 ? options[0] : null;
}
async function findNativeQualityOption(quality,{read,wait,now=Date.now,timeout=30000,observe}) {
  const deadline=now()+timeout;let previous;
  do {
    const nodes=await read(),option=nativeQualityOption(nodes,quality);
    observe?.(nodes,option);
    if(now()>=deadline)break;
    if(option && option.identity===previous)return option;
    previous=option?.identity;await wait(300);
  }while(now()<deadline);
  throw new Error(`Native quality option ${quality}p did not expose stable contained bounds before the deadline`);
}
// This function runs only in the isolated fixture receiver, whose publicRTC
// is the real production RoomRTC. Internal relay peers count decoded blocks
// as audioPackets; receivedAudioPackets belongs only to the projected stats row.
function nativeQualityContinuity({id,trackId,frames,w,h,packetsBefore,diagnose=false}) {
  const screen=publicScreenSnapshot(),peer=publicRTC.relayMedia.peers.get(id),audio=peer?.outputs.get('audio');
  const result={screenPresent:Boolean(screen),nonBlank:screen?.nonBlank===true,
    sameScreenTrack:screen?.trackId===trackId,width:screen?.width || 0,height:screen?.height || 0,
    dimensionsMatch:screen?.width===w && screen?.height===h,frames:screen?.frames ?? 0,
    framesAdvanced:Number.isSafeInteger(screen?.frames) && screen.frames>frames,
    sameDeviceAudioOutput:Boolean(audio && audio===window.qualityAudioOutput),
    sameDeviceAudioTrack:Boolean(audio?.track && audio.track===window.qualityAudioTrack),
    playbackContextState:audio?.context?.state || 'off',
    receivedAudioPackets:Number.isSafeInteger(peer?.audioPackets) ? peer.audioPackets : null,
    audioPacketsAdvanced:Number.isSafeInteger(peer?.audioPackets) && peer.audioPackets>packetsBefore};
  result.passed=result.screenPresent && result.nonBlank && result.sameScreenTrack && result.dimensionsMatch && result.framesAdvanced &&
    result.sameDeviceAudioOutput && result.sameDeviceAudioTrack && result.playbackContextState==='running' && result.audioPacketsAdvanced;
  return diagnose ? result : result.passed;
}
function viewport(nodes) {
  const view = rect(nodes.find(node => node.class === 'android.webkit.WebView' && node.package === appPackage &&
    node['visible-to-user'] === 'true' && rect(node) && rect(node)[0] >= 0 && rect(node)[1] >= 0));
  if (!view) return null;
  const navigation = nodes.filter(node => node.package === appPackage && node['visible-to-user'] === 'true' &&
    node.class === 'android.widget.Button' && ['Rooms','Devices','Settings'].includes(node.text || node['content-desc']));
  const nav = rect(navigation.find(node => (node.text || node['content-desc']) === 'Rooms'));
  const atLowerEdge = box => box && box[1] >= view[1] + (view[3] - view[1]) / 2 &&
    box[3] <= view[3] && view[3] - box[3] <= 200;
  const horizontallyInside = box => box && box[0] >= view[0] && box[2] <= view[2];
  // A wider Android display uses a vertical sidebar. Its Rooms button is not
  // a bottom obstruction: require an observed lower horizontal band or row.
  const container = horizontallyInside(nav) && atLowerEdge(nav) && nodes.filter(node => node.package === appPackage &&
    node['visible-to-user'] === 'true').map(rect).filter(box => atLowerEdge(box) &&
      box[0] <= view[0] && box[2] >= view[2] && box[1] <= nav[1] && box[3] >= nav[3] &&
      box[3] - box[1] <= 200).sort((a,b) => a[3]-a[1]-(b[3]-b[1]))[0];
  const horizontalRow = horizontallyInside(nav) && atLowerEdge(nav) && navigation.some(node => {
    const box = rect(node);
    return (node.text || node['content-desc']) !== 'Rooms' && horizontallyInside(box) && atLowerEdge(box) &&
      Math.abs(box[1] - nav[1]) <= 3 && Math.abs(box[3] - nav[3]) <= 3 &&
      (box[2] <= nav[0] || box[0] >= nav[2]);
  });
  const bottom = container?.[1] ?? (horizontalRow ? nav[1] - 20 : view[3]);
  const area = [view[0], view[1] + 8, view[2], Math.min(view[3], bottom) - 8];
  return area[3] > area[1] ? area : null;
}
function fits(node, area) {
  const box = rect(node);
  return Boolean(area && box && node['visible-to-user'] === 'true' &&
    box[0] >= area[0] && box[2] <= area[2] && box[1] >= area[1] && box[3] <= area[3]);
}
function gestureBlockers(nodes) {
  return nodes.filter(node => node['visible-to-user'] === 'true' &&
    (node.clickable === 'true' || node['long-clickable'] === 'true' || node['resource-id'] === 'stage-video' ||
      /^android\.widget\.(?:Button|ToggleButton|EditText|Spinner|SeekBar|Switch)$/.test(node.class || '')) && rect(node));
}
function gesturePaths(nodes, area, direction) {
  if (!area) return [];
  const blockers = gestureBlockers(nodes).map(rect);
  const minimumStroke = Math.max(24,Math.min(64,Math.round((area[3]-area[1])*.08)));
  const maximumStroke = Math.round((area[3]-area[1])*.46), candidates = [];
  for (const fraction of [.5,.25,.75,.1,.9]) {
    const x = Math.round(area[0] + (area[2] - area[0]) * fraction);
    // Stay inside the observed view, away from system edge-gesture gutters.
    if (x-area[0] < 24 || area[2]-x < 24) continue;
    let free = [[area[1],area[3]]];
    for (const box of blockers) {
      if (x < box[0]-4 || x > box[2]+4) continue;
      const blockedTop=box[1]-4,blockedBottom=box[3]+4;
      free=free.flatMap(([top,bottom])=>blockedBottom<top || blockedTop>bottom ? [[top,bottom]] :
        [[top,Math.min(bottom,blockedTop-1)],[Math.max(top,blockedBottom+1),bottom]].filter(([a,b])=>b>a));
    }
    for (const [start,end] of free) {
      const stroke=Math.min(maximumStroke,end-start);
      if (stroke<minimumStroke) continue;
      const top=Math.round((start+end-stroke)/2),bottom=top+stroke;
      candidates.push({stroke,path:[x,direction==='earlier'?top:bottom,x,direction==='earlier'?bottom:top]});
    }
  }
  return candidates.sort((a,b)=>b.stroke-a.stroke).map(value=>value.path);
}
function gesturePath(nodes, area, direction) {
  return gesturePaths(nodes,area,direction)[0] || null;
}
function contentGeometry(nodes, area) {
  const boxes = new Map();
  for(const node of nodes) {
    const box=rect(node),id=node['resource-id'];
    if(!id || !box || node.package!==appPackage || node['visible-to-user']!=='true')continue;
    boxes.set(id,boxes.has(id)?null:{kind:node.class,box});
  }
  return {area:area.join(','),boxes};
}
function contentMoved(before, after) {
  if(!before || before.area!==after.area)return false;
  for(const [key,value] of after.boxes) {
    const earlier=before.boxes.get(key),box=value?.box,previous=earlier?.box;
    if(box && previous && value.kind===earlier.kind && box[0]===previous[0] && box[2]-box[0]===previous[2]-previous[0] &&
      box[3]-box[1]===previous[3]-previous[1] && Math.abs(box[1]-previous[1])>=4)return true;
  }
  return false;
}
function diagnosticValue(label, nodes, valuePattern) {
  const area = viewport(nodes), labelBounds = rect(label);
  if (label?.package !== appPackage || !labelBounds || !fits(label,area)) return null;
  const values = nodes.filter(node => {
    const box = rect(node), text = node.text || node['content-desc'] || '';
    const packetCount = /^(\d+) packets$/.exec(text);
    return node !== label && node.package === appPackage && ['android.widget.TextView','android.view.View'].includes(node.class) &&
      node.clickable !== 'true' && node['long-clickable'] !== 'true' && node.checkable !== 'true' && fits(node,area) &&
      box[0] >= labelBounds[2] && Math.abs(box[1] - labelBounds[1]) <= 3 && Math.abs(box[3] - labelBounds[3]) <= 3 &&
      (!packetCount || Number.isSafeInteger(Number(packetCount[1]))) && valuePattern.test(text);
  });
  return values.length === 1 ? values[0].text || values[0]['content-desc'] : null;
}
async function findRoomAction(predicate, {read, swipe, wait, now = Date.now, timeout = 30000, observe}) {
  const deadline = now() + timeout;
  let stableBounds, previousGeometry, lastSwipeDirection, direction = 'earlier', observedViewport = false;
  const triedPaths = {earlier:new Set(),later:new Set()}, stalledAttempts={earlier:0,later:0}, progressDirections = new Set();
  do {
    const nodes = await read(); const area = viewport(nodes); const node = nodes.find(value => value.package === appPackage && predicate(value,nodes));
    const attempt = {viewport:area,direction,decision:'pending',path:null};
    observe?.(nodes, node, attempt);
    if (now() >= deadline) { attempt.decision = 'deadline'; break; }
    // UiAutomation can briefly omit the app while returning only SystemUI.
    // Such a snapshot proves neither a scroll boundary nor an absent action.
    if (!area) { attempt.decision = 'wait-no-viewport'; stableBounds = previousGeometry = lastSwipeDirection = undefined; await wait(300); continue; }
    observedViewport = true;
    if (node && fits(node, area)) {
      if (node.bounds === stableBounds) { attempt.decision = 'return-stable-action'; return node; }
      attempt.decision = 'wait-stable-action'; stableBounds = node.bounds; await wait(300); continue;
    }
    stableBounds = undefined;
    const currentGeometry=contentGeometry(nodes,area);
    if (contentMoved(previousGeometry,currentGeometry) && lastSwipeDirection) {
      progressDirections.add(lastSwipeDirection);triedPaths[lastSwipeDirection].clear();stalledAttempts[lastSwipeDirection]=0;attempt.geometryAdvanced=true;
    } else attempt.geometryAdvanced=false;
    previousGeometry=currentGeometry;
    const box = rect(node);
    if (box && box[3] > box[1]) {
      // Above the viewport needs a downward finger swipe; below needs upward.
      const nextDirection=box[1] < area[1] ? 'earlier' : 'later';
      direction=nextDirection;
    }
    let candidates=gesturePaths(nodes,area,direction);
    if (!candidates.length) { attempt.decision='wait-no-safe-gesture';await wait(300);continue; }
    let path=candidates.find(value=>!triedPaths[direction].has(value.join(',')));
    if(!box && (stalledAttempts[direction]>=3 || !path)) {
      // No movement at one safe corridor does not prove a scroll boundary.
      // Bound each direction to three ineffective attempts so a large number
      // of clear gaps cannot consume the whole lookup deadline at one edge.
      if(direction==='later' && !path && progressDirections.has('earlier') && progressDirections.has('later')) {
        attempt.decision='absent-after-search';throw new Error('Room action is absent after searching the native viewport in both directions');
      }
      direction=direction==='earlier'?'later':'earlier';stalledAttempts[direction]=0;
      candidates=gesturePaths(nodes,area,direction);path=candidates.find(value=>!triedPaths[direction].has(value.join(',')));
    }
    if(!path){triedPaths[direction].clear();path=candidates[0];}
    attempt.direction = direction;
    attempt.decision = 'swipe'; attempt.path = path;
    triedPaths[direction].add(path.join(','));stalledAttempts[direction]++;lastSwipeDirection=direction;
    await swipe(...path);
    await wait(500);
  } while (now() < deadline);
  throw new Error(observedViewport ? 'Room action did not expose stable fully visible native bounds before the deadline' :
    'Production WebView did not expose a valid observed viewport before the deadline');
}
module.exports = {findRoomAction, fits, viewport, gesturePath, gesturePaths, gestureBlockers, diagnosticValue,
  parseNativeHierarchy,nativeQualityOption,findNativeQualityOption,nativeQualityContinuity};
