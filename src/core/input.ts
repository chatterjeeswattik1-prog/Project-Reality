// Keyboard and mouse state with pointer lock. Bindings follow Project Reality where sensible.
export const BIND = {
  fwd: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', sprint: 'ShiftLeft', crouch: 'ControlLeft', crouch2: 'KeyC', prone: 'KeyZ', jump: 'Space',
  reload: 'KeyR', mode: 'KeyB', use: 'KeyF', map: 'KeyM', score: 'Tab', leanL: 'KeyQ', leanR: 'KeyE', bandage: 'KeyF', menu: 'Escape', giveUp: 'Enter',
  slot1: 'Digit1', slot2: 'Digit2', slot3: 'Digit3', slot4: 'Digit4', slot5: 'Digit5', light: 'KeyT', bipod: 'KeyG', orderMove: 'KeyY', orderHold: 'KeyH', orderSuppress: 'KeyU', freeLook: 'AltLeft', camera: 'KeyV',
} as const;

export class Input {
  down = new Set<string>();
  pressed = new Set<string>();
  mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false, wheel: 0 };
  locked = false;
  sens = 0.0021;
  private wheelAcc = 0; private wheelT = 0;
  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || (e.code.startsWith('Digit') && this.locked) || e.code === 'Space' || e.code === 'AltLeft') e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.down.add(e.code);
    });
    addEventListener('keyup', (e) => this.down.delete(e.code));
    addEventListener('blur', () => { this.down.clear(); this.mouse.left = this.mouse.right = false; });
    el.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    addEventListener('mousemove', (e) => { if (this.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; } });
    // Touchpads send streams of tiny wheel events: count a notch only per ~100 px of travel, at most every 250 ms.
    addEventListener('wheel', (e) => {
      if (!this.locked) return;
      const now = performance.now();
      this.wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(this.wheelAcc) >= 100 && now - this.wheelT > 250) { this.mouse.wheel += Math.sign(this.wheelAcc); this.wheelAcc = 0; this.wheelT = now; }
      if (now - this.wheelT > 600) this.wheelAcc *= 0.5;
    }, { passive: true });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === this.el; if (!this.locked) this.down.clear(); });
  }
  lock() { if (!this.locked) this.el.requestPointerLock()?.catch?.(() => undefined); }
  unlock() { if (this.locked) document.exitPointerLock(); }
  is(code: string) { return this.down.has(code); }
  hit(code: string) { return this.pressed.has(code); }
  /** Call at the end of every frame. */
  endFrame() { this.pressed.clear(); this.mouse.dx = this.mouse.dy = 0; this.mouse.leftPressed = this.mouse.rightPressed = false; this.mouse.wheel = 0; }
}
