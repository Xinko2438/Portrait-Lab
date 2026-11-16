function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function horizontalWheelDecision({
  scrollLeft = 0,
  scrollWidth = 0,
  clientWidth = 0,
  deltaX = 0,
  deltaY = 0,
  deltaMode = 0,
  ctrlKey = false,
  metaKey = false,
} = {}) {
  const maximum = Math.max(0, finite(scrollWidth) - finite(clientWidth));
  const current = clamp(finite(scrollLeft), 0, maximum);
  if (ctrlKey || metaKey) return { consume: false, nextScrollLeft: current, reason: 'modifier' };
  if (maximum <= 0) return { consume: false, nextScrollLeft: current, reason: 'no_overflow' };
  const horizontal = finite(deltaX);
  const vertical = finite(deltaY);
  if (Math.abs(horizontal) > Math.abs(vertical)) return { consume: false, nextScrollLeft: current, reason: 'native_horizontal' };
  if (vertical === 0) return { consume: false, nextScrollLeft: current, reason: 'zero_delta' };
  const scale = Number(deltaMode) === 1 ? 16 : Number(deltaMode) === 2 ? Math.max(1, finite(clientWidth)) : 1;
  const nextScrollLeft = clamp(current + (vertical * scale), 0, maximum);
  if (nextScrollLeft === current) return { consume: false, nextScrollLeft: current, reason: 'edge_passthrough' };
  return { consume: true, nextScrollLeft, reason: 'vertical_to_horizontal' };
}

export function attachHorizontalWheelScroll(element) {
  if (!element?.addEventListener) return () => {};
  const onWheel = (event) => {
    const decision = horizontalWheelDecision({
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    });
    if (!decision.consume) return;
    event.preventDefault();
    element.scrollLeft = decision.nextScrollLeft;
  };
  element.addEventListener('wheel', onWheel, { passive: false });
  return () => element.removeEventListener('wheel', onWheel);
}
