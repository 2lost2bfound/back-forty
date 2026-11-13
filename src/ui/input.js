// input.js — keyboard/mouse state (plan §B9 src/ui/input.js).
// Attached on the first user interaction path; importing this module in Node
// is safe because nothing runs until initInput() is called.

export function initInput(canvas) {
  const keys = new Set();        // currently held key codes
  const justPressed = new Set(); // pressed since last endFrame()
  const mouse = { x: 0, y: 0, buttons: 0, wheel: 0 };

  // Keys the game owns; stop the browser from scrolling/toggling on them.
  const gameKeys = new Set([
    'Space', 'Tab', 'AltLeft', 'AltRight', 'F3', 'F4',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE', 'KeyR', 'KeyI', 'KeyF',
  ]);

  function onKeyDown(e) {
    if (gameKeys.has(e.code)) e.preventDefault();
    if (!e.repeat) justPressed.add(e.code);
    keys.add(e.code);
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function onBlur() {
    keys.clear(); // no stuck keys when the tab loses focus
  }

  function onMouseMove(e) {
    const r = canvas.getBoundingClientRect();
    mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
    mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
  }

  function onMouseDown(e) {
    mouse.buttons |= 1 << e.button;
  }

  function onMouseUp(e) {
    mouse.buttons &= ~(1 << e.button);
  }

  function onWheel(e) {
    mouse.wheel += Math.sign(e.deltaY);
    e.preventDefault();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  // Keep the browser context menu off right-click (secondary action, §A2).
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    keys,
    mouse,

    /** Key was pressed since the last endFrame(). */
    wasPressed(code) {
      return justPressed.has(code);
    },

    /** Call once per rendered frame, after update+render. */
    endFrame() {
      justPressed.clear();
      mouse.wheel = 0;
    },
  };
}
