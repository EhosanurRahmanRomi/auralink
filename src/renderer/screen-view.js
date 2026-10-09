// Local viewing geometry only. Zooming never changes a capture, stream or
// control permission; coordinates are inverted before approved remote input.
export class ScreenView {
  constructor(maxScale = 4) {
    this.maxScale = Math.max(1, Math.min(8, Number(maxScale) || 4));
    this.width = this.height = this.imageWidth = this.imageHeight = 0;
    this.reset();
  }
  reset() { this.scale = 1; this.x = 0; this.y = 0; }
  get ready() { return this.width > 0 && this.height > 0 && this.imageWidth > 0 && this.imageHeight > 0; }
  get fit() {
    if (!this.ready) return { width: 0, height: 0 };
    const ratio = Math.min(this.width / this.imageWidth, this.height / this.imageHeight);
    return { width: this.imageWidth * ratio, height: this.imageHeight * ratio };
  }
  resize(width, height, imageWidth, imageHeight) {
    const previous = this.fit;
    [this.width, this.height, this.imageWidth, this.imageHeight] = [width, height, imageWidth, imageHeight]
      .map(value => Number.isFinite(value) && value > 0 ? value : 0);
    const next = this.fit;
    if (previous.width && next.width) { const ratio = next.width / previous.width; this.x *= ratio; this.y *= ratio; }
    this.clamp();
  }
  clamp() {
    if (this.scale === 1) { this.x = 0; this.y = 0; return; }
    const image = this.fit;
    const limitX = Math.max(0, (image.width * this.scale - this.width) / 2);
    const limitY = Math.max(0, (image.height * this.scale - this.height) / 2);
    this.x = Math.max(-limitX, Math.min(limitX, this.x));
    this.y = Math.max(-limitY, Math.min(limitY, this.y));
  }
  zoom(scale, anchorX = this.width / 2, anchorY = this.height / 2) {
    if (!this.ready || !Number.isFinite(scale) || !Number.isFinite(anchorX) || !Number.isFinite(anchorY)) return;
    const next = Math.max(1, Math.min(this.maxScale, scale)), ratio = next / this.scale;
    this.x = this.x * ratio + (anchorX - this.width / 2) * (1 - ratio);
    this.y = this.y * ratio + (anchorY - this.height / 2) * (1 - ratio);
    this.scale = next; this.clamp();
  }
  pan(deltaX, deltaY) {
    if (!this.ready || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    this.x += deltaX; this.y += deltaY; this.clamp();
  }
  point(clientX, clientY, clamp = false) {
    if (!this.ready || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    if (!clamp && (clientX < 0 || clientX > this.width || clientY < 0 || clientY > this.height)) return null;
    const image = this.fit, width = image.width * this.scale, height = image.height * this.scale;
    const left = this.width / 2 + this.x - width / 2, top = this.height / 2 + this.y - height / 2;
    const x = (clientX - left) / width, y = (clientY - top) / height;
    if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }
}

export function attachScreenView({ viewport, video, controls, dragToggle, beforeGesture = () => {}, canControl = () => false, onTouchTap = () => {}, onTouchDrag = () => false }) {
  const view = new ScreenView(), touches = new Map();
  let selectedTrack = null, panMode = false, touchDragMode = false, remoteDragging = null, drag = null, pinch = null, gestureUsed = false;
  const [out, level, into, fit, pan] = ['screen-zoom-out', 'screen-zoom-level', 'screen-zoom-in', 'screen-zoom-fit', 'screen-pan']
    .map(id => controls.querySelector(`#${id}`));
  const measure = () => { const box = viewport.getBoundingClientRect(); view.resize(box.width, box.height, video.videoWidth, video.videoHeight); return box; };
  const paint = () => {
    if (view.scale === 1) panMode = false;
    video.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    viewport.classList.toggle('screen-pannable', panMode || !canControl() && view.scale > 1);
    viewport.classList.toggle('screen-panning', Boolean(drag || touches.size > 1));
    viewport.dataset.zoom = String(Math.round(view.scale * 100));
    controls.hidden = !selectedTrack;
    level.textContent = `${Math.round(view.scale * 100)}%`; level.setAttribute('aria-label', `Screen zoom ${Math.round(view.scale * 100)} percent`);
    out.disabled = !view.ready || view.scale <= 1; into.disabled = !view.ready || view.scale >= view.maxScale;
    fit.disabled = !view.ready || view.scale === 1; pan.disabled = !view.ready || view.scale <= 1;
    pan.classList.toggle('enabled', panMode); pan.setAttribute('aria-pressed', String(panMode));
    pan.title = panMode ? 'Pan view is on; drag moves your view only' : 'Pan view; drag without sending remote input';
    if (dragToggle) {
      dragToggle.disabled = !canControl(); dragToggle.classList.toggle('enabled', touchDragMode);
      dragToggle.setAttribute('aria-pressed', String(touchDragMode)); dragToggle.textContent = touchDragMode ? 'Touch drag on' : 'Touch drag';
    }
  };
  const point = (event, clamp = false) => { const box = measure(); return view.point(event.clientX - box.left, event.clientY - box.top, clamp); };
  const stop = () => {
    if (remoteDragging !== null) beforeGesture();
    for (const id of touches.keys()) { try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch {} }
    if (drag) { try { if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id); } catch {} }
    touches.clear(); drag = pinch = null; remoteDragging = null; touchDragMode = false; gestureUsed = false; paint();
  };
  const changeZoom = (factor, event = null) => {
    beforeGesture(); const box = measure();
    view.zoom(view.scale * factor, event ? event.clientX - box.left : box.width / 2, event ? event.clientY - box.top : box.height / 2); paint();
  };
  out.addEventListener('click', () => changeZoom(1 / 1.25)); into.addEventListener('click', () => changeZoom(1.25));
  fit.addEventListener('click', () => { beforeGesture(); stop(); view.reset(); panMode = false; paint(); });
  pan.addEventListener('click', () => { beforeGesture(); stop(); panMode = !panMode; paint(); });
  dragToggle?.addEventListener('click', () => {
    if (!canControl()) return;
    const next = !touchDragMode; beforeGesture(); stop(); touchDragMode = next; panMode = false; paint();
  });
  viewport.addEventListener('wheel', event => {
    if (!selectedTrack || !view.ready || !(event.ctrlKey || event.metaKey || !canControl() || panMode)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const factor = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? view.height : 1;
    changeZoom(Math.exp(-Math.max(-500, Math.min(500, event.deltaY * factor)) * .0018), event);
  }, { capture: true, passive: false });
  const touchPair = () => {
    const [a, b] = [...touches.values()];
    return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) } : null;
  };
  viewport.addEventListener('pointerdown', event => {
    if (!selectedTrack || !view.ready) return;
    if (event.pointerType === 'touch') {
      event.preventDefault(); event.stopImmediatePropagation();
      const box = measure(), x = event.clientX - box.left, y = event.clientY - box.top;
      touches.set(event.pointerId, { x, y, initialX: x, initialY: y });
      viewport.setPointerCapture(event.pointerId);
      if (touches.size > 1) {
        beforeGesture(); remoteDragging = null; touchDragMode = false; gestureUsed = true; pinch = touchPair();
      } else if (touchDragMode && canControl()) {
        beforeGesture(); gestureUsed = true;
        const location = view.point(x, y);
        if (location && onTouchDrag({ type: 'down', point: location })) remoteDragging = event.pointerId;
      }
      paint(); return;
    }
    if (view.scale > 1 && (panMode || event.button === 1 || event.altKey || !canControl() && event.button === 0)) {
      beforeGesture(); event.preventDefault(); event.stopImmediatePropagation();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }; viewport.setPointerCapture(event.pointerId); paint();
    }
  }, { capture: true });
  viewport.addEventListener('pointermove', event => {
    if (touches.has(event.pointerId)) {
      event.preventDefault(); event.stopImmediatePropagation();
      const box = measure(), touch = touches.get(event.pointerId), next = { ...touch, x: event.clientX - box.left, y: event.clientY - box.top };
      touches.set(event.pointerId, next);
      if (remoteDragging === event.pointerId && touchDragMode && canControl() && touches.size === 1) {
        const location = point(event, true); if (location) onTouchDrag({ type: 'move', point: location }); gestureUsed = true;
      } else if (touches.size > 1) {
        const pair = touchPair();
        if (pinch && pinch.distance > 0 && pair.distance > 0) { view.zoom(view.scale * pair.distance / pinch.distance, pinch.x, pinch.y); view.pan(pair.x - pinch.x, pair.y - pinch.y); }
        pinch = pair; gestureUsed = true;
      } else if (view.scale > 1 && (panMode || !canControl())) {
        if (!gestureUsed) beforeGesture(); view.pan(next.x - touch.x, next.y - touch.y); gestureUsed = true;
      } else if (Math.hypot(next.x - next.initialX, next.y - next.initialY) > 8) gestureUsed = true;
      paint(); return;
    }
    if (drag?.id === event.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation(); measure(); view.pan(event.clientX - drag.x, event.clientY - drag.y);
      drag.x = event.clientX; drag.y = event.clientY; paint();
    } else if (panMode) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { capture: true });
  const endPointer = event => {
    const touch = touches.get(event.pointerId);
    if (touch) {
      event.preventDefault(); event.stopImmediatePropagation();
      const tap = !gestureUsed && touches.size === 1 && event.type === 'pointerup' && !panMode && !touchDragMode;
      if (remoteDragging === event.pointerId) {
        const location = point(event, true); if (location) onTouchDrag({ type: 'up', point: location });
        remoteDragging = null;
      }
      touches.delete(event.pointerId); pinch = touchPair();
      try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch {}
      if (tap && canControl()) { const location = point(event); if (location) onTouchTap(location); }
      if (!touches.size) gestureUsed = false;
      paint(); return;
    }
    if (drag?.id === event.pointerId) {
      event.preventDefault(); event.stopImmediatePropagation();
      try { if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch {}
      drag = null; paint();
    }
  };
  viewport.addEventListener('pointerup', endPointer, { capture: true }); viewport.addEventListener('pointercancel', endPointer, { capture: true });
  window.addEventListener('blur', stop); document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
  video.addEventListener('resize', () => { measure(); paint(); }); video.addEventListener('loadedmetadata', () => { measure(); paint(); });
  new ResizeObserver(() => { measure(); paint(); }).observe(viewport);
  return {
    point,
    setTrack(track) { if (track !== selectedTrack) { beforeGesture(); stop(); view.reset(); panMode = false; selectedTrack = track; } measure(); paint(); },
    syncControl() { if (!canControl() && (touchDragMode || remoteDragging !== null)) { beforeGesture(); stop(); } paint(); },
    cancelGesture: stop,
    reset() { beforeGesture(); stop(); view.reset(); panMode = false; paint(); },
  };
}
