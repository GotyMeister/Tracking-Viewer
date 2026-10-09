/* Small Three.js scene with local orbit controls (no modules/server required). */
(function () {
  'use strict';
  class MotionScene {
    constructor(host) {
      this.host = host; this.data = null; this.showTrails = true;
      const T = THREE;
      this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setClearColor(0x12191f);
      host.prepend(this.renderer.domElement);
      this.world = new T.Scene();
      this.camera = new T.PerspectiveCamera(42, 1, 0.005, 1000);
      this.target = new T.Vector3(0, -0.2, 0);
      this.yaw = 0.45; this.pitch = 0.35; this.distance = 1.8;
      this.world.add(new T.HemisphereLight(0xffffff, 0x506070, 2.7));
      this.grid = new T.GridHelper(3, 30, 0x405363, 0x25323d);
      this.grid.position.y = -0.75; this.world.add(this.grid);
      const axes = new T.AxesHelper(0.18); axes.position.set(-0.7, -0.749, 0.5);
      this.axes = axes; this.world.add(axes);
      this.axisLabels = ['X', 'Y', 'Z'].map((text, i) => {
        const label = this.label(text, '#b8c6d1');
        label.scale.set(0.065, 0.025, 1);
        axes.add(label); label.position.set(i === 0 ? .23 : 0, i === 1 ? .23 : 0, i === 2 ? .23 : 0);
        return label;
      });
      this.head = new T.Group();
      const shell = new T.Mesh(new T.BoxGeometry(.18, .115, .11), new T.MeshStandardMaterial({ color:0xb6a2ff, roughness:.5 }));
      const visor = new T.Mesh(new T.BoxGeometry(.155, .064, .015), new T.MeshStandardMaterial({ color:0x323152, roughness:.3 }));
      visor.position.z = -.06; this.head.add(shell, visor);
      this.head.add(new T.ArrowHelper(new T.Vector3(0, 0, -1), new T.Vector3(0, 0, -.07), .15, 0xb6a2ff, .03, .025));
      this.head.visible = false; this.world.add(this.head);
      this.headLabel = this.label('Голова', '#d8ceff'); this.world.add(this.headLabel); this.headLabel.visible = false;
      this.hands = [this.makeHand(0x69d5ff, 'Левая'), this.makeHand(0xffaf68, 'Правая')];
      this.installControls();
      this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(host);
      this.resize();
    }
    label(text, color) {
      const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.font = '28px Segoe UI, Arial'; ctx.textAlign = 'center';
      ctx.fillStyle = color; ctx.fillText(text, 128, 43);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map:new THREE.CanvasTexture(canvas), depthTest:false }));
      sprite.scale.set(.22, .055, 1); return sprite;
    }
    makeHand(color, name) {
      const T = THREE, group = new T.Group();
      const material = new T.MeshStandardMaterial({ color, roughness:.4 });
      const geometry = new T.SphereGeometry(.005, 10, 8);
      const dots = Array.from({ length:26 }, (_, i) => {
        const mesh = new T.Mesh(geometry, material); if (i < 2) mesh.scale.setScalar(1.4);
        group.add(mesh); return mesh;
      });
      const positions = new Float32Array(256 * 3);
      const linesGeometry = new T.BufferGeometry();
      linesGeometry.setAttribute('position', new T.BufferAttribute(positions, 3).setUsage(T.DynamicDrawUsage));
      linesGeometry.setDrawRange(0, 0);
      const lines = new T.LineSegments(linesGeometry, new T.LineBasicMaterial({ color }));
      lines.frustumCulled = false; group.add(lines);
      const label = this.label(name, '#' + color.toString(16)); group.add(label);
      group.visible = false; this.world.add(group);
      const trailGeometry = new T.BufferGeometry();
      trailGeometry.setAttribute('position', new T.BufferAttribute(new Float32Array(2400), 3).setUsage(T.DynamicDrawUsage));
      trailGeometry.setDrawRange(0, 0);
      const trail = new T.LineSegments(trailGeometry, new T.LineBasicMaterial({ color, transparent:true, opacity:.32 }));
      trail.frustumCulled = false; this.world.add(trail);
      return { group, dots, label, linesGeometry, trailGeometry, trail };
    }
    setData(data) {
      this.data = data;
      const box = new THREE.Box3();
      for (let i = 0; i < data.frames.length; i += Math.max(1, Math.floor(data.frames.length / 1500))) {
        const f = data.frames[i];
        for (const p of [f.head?.slice(0, 3), Tracking.wrist(f.left), Tracking.wrist(f.right)]) {
          if (p) box.expandByPoint(new THREE.Vector3(...p));
        }
      }
      if (box.isEmpty()) box.set(new THREE.Vector3(-.5, -.5, -.5), new THREE.Vector3(.5, .5, .5));
      box.getCenter(this.target);
      this.baseDistance = Math.max(1.15, box.getSize(new THREE.Vector3()).length() * 1.45);
      this.distance = this.baseDistance;
      this.grid.position.set(this.target.x, box.min.y - .15, this.target.z);
      this.axes.position.set(this.target.x - .6, this.grid.position.y + .001, this.target.z + .5);
      this.view('perspective');
    }
    view(name) {
      const views = { perspective:[.45, .35], front:[0, 0], side:[Math.PI / 2, 0], top:[0, Math.PI / 2 - .005] };
      [this.yaw, this.pitch] = views[name] || views.perspective;
      this.distance = this.baseDistance || 1.8; this.draw();
    }
    update(index) {
      if (!this.data) return;
      const f = this.data.frames[index];
      this.head.visible = !!f.head && f.headStatus !== 0;
      this.headLabel.visible = this.head.visible;
      if (this.head.visible) {
        this.head.position.set(...f.head.slice(0, 3));
        const q = f.head.slice(3, 7), norm = Math.hypot(...q);
        this.head.quaternion.set(...q).normalize();
        if (norm < .5 || norm > 1.5) this.head.quaternion.identity();
        this.headLabel.position.copy(this.head.position).add(new THREE.Vector3(0, .11, 0));
      }
      [f.left, f.right].forEach((h, side) => {
        const model = this.hands[side]; model.group.visible = h.active === 1;
        for (let j = 0; j < 26; j++) {
          model.dots[j].visible = Tracking.validJoint(h, j);
          if (model.dots[j].visible) model.dots[j].position.fromArray(h.poses, j * 7);
        }
        const attr = model.linesGeometry.attributes.position; let count = 0;
        for (const chain of Tracking.CHAINS) {
          for (let j = 1; j < chain.length; j++) {
            const a = chain[j - 1], b = chain[j];
            if (!Tracking.validJoint(h, a) || !Tracking.validJoint(h, b)) continue;
            attr.setXYZ(count++, ...h.poses.subarray(a * 7, a * 7 + 3));
            attr.setXYZ(count++, ...h.poses.subarray(b * 7, b * 7 + 3));
          }
        }
        attr.needsUpdate = true; model.linesGeometry.setDrawRange(0, count);
        const w = Tracking.wrist(h); model.label.visible = !!w;
        if (w) model.label.position.set(w[0], w[1] + .04, w[2]);
        this.updateTrail(model, side === 0 ? 'left' : 'right', index);
      });
      this.draw();
    }
    updateTrail(model, side, index) {
      model.trail.visible = this.showTrails;
      if (!this.showTrails) return;
      const frames = this.data.frames, start = Tracking.lowerBound(frames, frames[index].t - 2);
      const attr = model.trailGeometry.attributes.position;
      let count = 0, previous = null, previousT = 0;
      // Check EVERY frame for validity, so trails never bridge a short loss of tracking.
      for (let i = start; i <= index && count < 798; i++) {
        const p = Tracking.wrist(frames[i][side]);
        if (!p) { previous = null; continue; }
        if (previous && frames[i].t - previousT < .022 && i !== index) continue;
        if (previous && frames[i].t - previousT < .08) {
          attr.setXYZ(count++, ...previous); attr.setXYZ(count++, ...p);
        }
        previous = p; previousT = frames[i].t;
      }
      attr.needsUpdate = true; model.trailGeometry.setDrawRange(0, count);
    }
    installControls() {
      const canvas = this.renderer.domElement; let drag = null;
      canvas.addEventListener('pointerdown', e => { if (e.button !== 0) return; drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', e => {
        if (!drag) return;
        this.yaw -= (e.clientX - drag[0]) * .006;
        this.pitch = Math.max(-1.5, Math.min(1.565, this.pitch + (e.clientY - drag[1]) * .006));
        drag = [e.clientX, e.clientY]; this.draw();
      });
      canvas.addEventListener('pointerup', () => { drag = null; });
      canvas.addEventListener('pointercancel', () => { drag = null; });
      canvas.addEventListener('wheel', e => {
        e.preventDefault(); this.distance = Math.max(.12, Math.min(100, this.distance * Math.exp(e.deltaY * .001)));
        this.draw();
      }, { passive:false });
    }
    resize() {
      const width = this.host.clientWidth, height = this.host.clientHeight;
      this.renderer.setSize(width, height, false); this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix(); this.draw();
    }
    draw() {
      this.camera.position.set(this.target.x + this.distance * Math.sin(this.yaw) * Math.cos(this.pitch),
        this.target.y + this.distance * Math.sin(this.pitch),
        this.target.z + this.distance * Math.cos(this.yaw) * Math.cos(this.pitch));
      this.camera.lookAt(this.target); this.renderer.render(this.world, this.camera);
    }
  }
  window.MotionScene = MotionScene;
})();
