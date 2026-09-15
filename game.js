// game.js — 核心游戏:场景、玩家、武器、命中、AI、HUD、联机对接
import * as THREE from 'three';
import { buildMap } from './map.js';
import { WEAPONS, PLAYER, CONST, SPAWN_POINTS } from './config.js';
import { Bot } from './ai.js';
import { Msg } from './net.js';

// 天空盒渐变
function makeSky() {
  const skyGeo = new THREE.SphereGeometry(200, 24, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      top: { value: new THREE.Color(0x4a7fb8) },
      mid: { value: new THREE.Color(0xb8d2eb) },
      bot: { value: new THREE.Color(0xd8c89a) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
    `,
    fragmentShader: `
      varying vec3 vPos;
      uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main(){
        float h = normalize(vPos).y;
        vec3 c;
        if (h > 0.0) c = mix(mid, top, smoothstep(0.0, 0.7, h));
        else c = mix(mid, bot, smoothstep(0.0, -0.3, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  return new THREE.Mesh(skyGeo, skyMat);
}

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.clock = new THREE.Clock();
    this.raycaster = new THREE.Raycaster();
    this.running = false;
    this.paused = false;
    this.disposed = false;

    // 玩家
    this.player = null;
    // AI列表
    this.bots = [];
    // 远程玩家(联机)
    this.remotePlayer = null;  // {mesh, position, hp, dead, weaponId, ...}
    // 地图碰撞
    this.colliders = [];
    this.spawnPoints = SPAWN_POINTS;

    // 武器视图
    this.viewmodel = null;
    this.recoil = { pitch: 0, yaw: 0, time: 0 };
    this.muzzleFlash = null;
    this.adsActive = false;
    this.adsFov = 75;

    // 输入
    this.keys = {};
    this.mouseDown = false;
    this.yaw = 0; this.pitch = 0;
    this.pointerLocked = false;

    // 状态
    this.kills = { A: 0, B: 0 };
    this.killGoal = CONST.killGoalDefault;
    this.ended = false;

    // 联机
    this.net = null;
    this.isHost = false;
    this.mode = 'single';
    this.lastStateSent = 0;

    // 视觉特效
    this.tracers = [];      // {line, ttl}
    this.particles = [];    // {points, vel, ttl}

    // 回调
    this.onKill = null;
    this.onDeath = null;
    this.onHit = null;       // 命中敌人反馈
    this.onTakeDamage = null;
    this.onHudUpdate = null;
    this.onGameEnd = null;
    this.onNetStatus = null;

    // 音效(WebAudio合成)
    this.audioCtx = null;
  }

  initAudio() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch(e) { this.audioCtx = null; }
  }

  // 简单合成枪声
  playShot(weaponId) {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    const w = WEAPONS[weaponId];
    const now = ctx.currentTime;
    const isSniper = w.type === 'sniper';
    const dur = isSniper ? 0.18 : 0.07;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(isSniper ? 220 : 380, now);
    osc.frequency.exponentialRampToValueAtTime(40, now + dur);
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(now); osc.stop(now + dur);

    // 噪声叠加
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i/data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + dur);
    noise.connect(ng); ng.connect(ctx.destination);
    noise.start(now);
  }

  playHit() {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.12);
    g.gain.setValueAtTime(0.25, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.12);
  }

  playReload() {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx; const now = ctx.currentTime;
    [0, 0.15, 0.35].forEach((t, i) => {
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.type = 'square'; osc.frequency.setValueAtTime(120 + i * 60, now + t);
      g.gain.setValueAtTime(0.15, now + t);
      g.gain.exponentialRampToValueAtTime(0.001, now + t + 0.08);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(now + t); osc.stop(now + t + 0.08);
    });
  }

  // === 启动 ===
  start(opts) {
    this.mode = opts.mode;
    this.killGoal = opts.killGoal || CONST.killGoalDefault;
    this.isHost = opts.isHost || false;
    this.net = opts.netManager || null;

    this.initThree();
    this.initPlayer(opts);
    this.initControls();

    if (this.mode === 'single') {
      // 创建 bots
      this.spawnBots(opts.botCount, opts.difficulty);
    }

    this.running = true;
    this.paused = false;
    this.ended = false;
    this.clock.start();

    // 启动主循环
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);

    // 联机:设置消息处理
    if (this.net) {
      this.net.onMessage = (msg) => this.onNetMessage(msg);
      if (this.mode === 'join') {
        // 加入后向房主发送HELLO
        this.net.send({ type: Msg.HELLO, primaryId: opts.primaryId, secondaryId: opts.secondaryId });
      }
    }
  }

  initThree() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0xb8c8d8, 0.012);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 500);
    this.camera.position.set(0, PLAYER.height, 0);

    // 天空
    this.scene.add(makeSky());

    // 光照
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0xc8a060, 0.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff0d0, 1.4);
    sun.position.set(-30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -50; sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50; sun.shadow.camera.bottom = -50;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 120;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    // 地图
    const { group, colliders } = buildMap();
    this.scene.add(group);
    this.colliders = colliders;

    // resize
    window.addEventListener('resize', this._onResize);
  }

  initPlayer(opts) {
    const team = 'A';
    const spawn = opts.spawn || this.spawnPoints.A[0];
    this.player = {
      position: new THREE.Vector3(spawn.x, 0, spawn.z),
      velocity: new THREE.Vector3(),
      yaw: 0, pitch: 0,
      onGround: true,
      hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      team,
      kills: 0, deaths: 0,
      primaryId: opts.primaryId,
      secondaryId: opts.secondaryId,
      currentSlot: 'primary',
      mag: { [opts.primaryId]: WEAPONS[opts.primaryId].mag, [opts.secondaryId]: WEAPONS[opts.secondaryId].mag },
      reserve: { [opts.primaryId]: WEAPONS[opts.primaryId].reserve, [opts.secondaryId]: WEAPONS[opts.secondaryId].reserve },
      reloading: false, reloadT: 0,
      fireCd: 0,
      invulnT: PLAYER.invulnTime,
      dead: false, respawnT: 0,
    };
    this.yaw = 0; this.pitch = 0;
    this.buildViewmodel();
    this.updateCameraTransform();
  }

  spawnBots(count, difficulty) {
    this.bots = [];
    const names = ['Kilo', 'Bravo', 'Echo', 'Zulu', 'Tango', 'Delta'];
    for (let i = 0; i < count; i++) {
      const spawn = this.spawnPoints.B[i % this.spawnPoints.B.length];
      const primaryId = ['qbz95','type88','deagle','qsz92'][i % 4];
      const bot = new Bot(this.scene, {
        id: i + 1, team: 'B', difficulty,
        spawn, primaryId,
        name: names[i] || `Bot${i+1}`,
      });
      bot.worldColliders = this.colliders;
      this.bots.push(bot);
    }
  }

  // === 控制输入 ===
  initControls() {
    this.canvas.addEventListener('click', () => {
      if (this.running && !this.paused && !this.pointerLocked) {
        this.canvas.requestPointerLock();
      }
    });
    document.addEventListener('pointerlockchange', this._onPLChange = () => {
      this.pointerLocked = (document.pointerLockElement === this.canvas);
      if (!this.pointerLocked && this.running && !this.paused && !this.ended) {
        // 失锁 → 暂停
        this.pause();
      }
    });
    document.addEventListener('mousemove', this._onMouseMove = (e) => {
      if (!this.pointerLocked) return;
      const sens = 0.0022 * (this.adsActive ? 0.5 : 1);
      this.yaw -= e.movementX * sens;
      this.pitch -= e.movementY * sens;
      this.pitch = Math.max(-Math.PI/2 + 0.01, Math.min(Math.PI/2 - 0.01, this.pitch));
    });
    document.addEventListener('mousedown', this._onMouseDown = (e) => {
      if (!this.pointerLocked) return;
      if (e.button === 0) this.mouseDown = true;
      if (e.button === 2) { this.adsActive = true; }
    });
    document.addEventListener('mouseup', this._onMouseUp = (e) => {
      if (e.button === 0) this.mouseDown = false;
      if (e.button === 2) this.adsActive = false;
    });
    document.addEventListener('contextmenu', this._onCtx = (e) => e.preventDefault());
    document.addEventListener('keydown', this._onKeyDown = (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyR') this.reload();
      if (e.code === 'Digit1') this.switchWeapon('primary');
      if (e.code === 'Digit2') this.switchWeapon('secondary');
      if (e.code === 'Escape' && this.running && !this.ended) {
        if (this.paused) this.resume(); else this.pause();
      }
    });
    document.addEventListener('keyup', this._onKeyUp = (e) => {
      this.keys[e.code] = false;
    });
    window.addEventListener('resize', this._onResize = () => {
      if (!this.renderer) return;
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // === 武器系统 ===
  currentWeapon() {
    const slot = this.player.currentSlot;
    const id = slot === 'primary' ? this.player.primaryId : this.player.secondaryId;
    return WEAPONS[id];
  }

  buildViewmodel() {
    if (this.viewmodel) {
      this.camera.remove(this.viewmodel);
      this.viewmodel.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    }
    this.viewmodel = new THREE.Group();
    const w = this.currentWeapon();

    // 简化的视图模型:枪身、枪管、弹匣、握把、瞄准镜(狙击)
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222428, roughness: 0.45, metalness: 0.7 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.3, metalness: 0.9 });
    const magMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 });

    const gun = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.55), bodyMat);
    body.position.set(0, 0, -0.15);
    gun.add(body);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.4, 8), accentMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.5);
    gun.add(barrel);

    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.08), magMat);
    mag.position.set(0, -0.13, -0.05);
    gun.add(mag);

    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.15, 0.08), bodyMat);
    grip.position.set(0, -0.12, 0.08);
    grip.rotation.x = -0.2;
    gun.add(grip);

    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.2), bodyMat);
    stock.position.set(0, -0.02, 0.2);
    gun.add(stock);

    if (w.type === 'sniper') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.25, 12), accentMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.1, -0.15);
      gun.add(scope);
    }
    if (w.side === 'US') {
      // 装饰条纹
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.02, 0.1), new THREE.MeshStandardMaterial({color:0xb0b0b0}));
      stripe.position.set(0, 0.06, -0.1);
      gun.add(stripe);
    }

    // 枪口火焰(默认隐藏)
    this.muzzleFlash = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd070, transparent: true, opacity: 0 })
    );
    this.muzzleFlash.position.set(0, 0.02, -0.7);
    gun.add(this.muzzleFlash);

    // 整体放置(右下角,枪托贴脸)
    gun.position.set(0.18, -0.18, -0.35);
    gun.rotation.y = -0.05;

    this.viewmodel.add(gun);
    this.viewmodel._gun = gun;
    this.camera.add(this.viewmodel);
    if (!this.camera.parent) this.scene.add(this.camera);
  }

  switchWeapon(slot) {
    if (this.player.currentSlot === slot) return;
    if (this.player.reloading) {
      this.player.reloading = false;
    }
    this.player.currentSlot = slot;
    this.player.fireCd = 0.3;
    this.buildViewmodel();
  }

  reload() {
    const w = this.currentWeapon();
    const id = w.id;
    if (this.player.reloading) return;
    if (this.player.mag[id] >= w.mag) return;
    if (this.player.reserve[id] <= 0) return;
    this.player.reloading = true;
    this.player.reloadT = w.reload;
    this.playReload();
  }

  fire() {
    const p = this.player;
    const w = this.currentWeapon();
    if (p.fireCd > 0) return;
    if (p.reloading) return;
    if (p.mag[w.id] <= 0) {
      // 空仓自动换弹
      this.reload();
      return;
    }
    p.mag[w.id]--;
    p.fireCd = w.fireRate / 1000;

    // 后坐力
    const recoilMul = this.adsActive ? 0.6 : 1.0;
    this.recoil.pitch += w.recoil * recoilMul * (0.6 + Math.random() * 0.4);
    this.recoil.yaw += (Math.random() - 0.5) * w.recoil * recoilMul * 1.5;
    this.recoil.time = 0.06;

    // 枪口火焰
    if (this.muzzleFlash) {
      this.muzzleFlash.material.opacity = 1;
      this.muzzleFlash.scale.setScalar(0.8 + Math.random() * 0.4);
    }

    // 弹道方向(基于相机中心 + 散布)
    const spread = this.adsActive ? w.adsSpread : w.spread;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.x += (Math.random() - 0.5) * spread * 2;
    dir.y += (Math.random() - 0.5) * spread * 2;
    dir.z += (Math.random() - 0.5) * spread * 2;
    dir.normalize();

    const origin = new THREE.Vector3();
    this.camera.getWorldPosition(origin);

    // 命中检测:房主权威 - 仅 single/host 模式本地判定,客户端只发FIRE事件等房主判定
    if (this.mode === 'single' || this.isHost) {
      this.performHitscan(origin, dir, w, this.player.team, 'player');
    }

    // tracer
    this.spawnTracer(origin, dir, w);

    this.playShot(w.id);

    // 联机:发送开火事件(只发必要信息,房主或客户端都发)
    if (this.net && this.net.alive) {
      this.net.send({
        type: Msg.FIRE,
        origin: [origin.x, origin.y, origin.z],
        dir: [dir.x, dir.y, dir.z],
        weaponId: w.id,
        t: performance.now(),
      });
    }
  }

  performHitscan(origin, dir, weapon, attackerTeam, attackerId) {
    // 检测 bot / 远程玩家 / 地图
    this.raycaster.set(origin, dir);
    this.raycaster.far = weapon.range;

    // 候选目标:bot列表 + remotePlayer
    const targets = [];
    for (const b of this.bots) {
      if (!b.dead && b.team !== attackerTeam) {
        targets.push({ kind: 'bot', obj: b, dist: Infinity });
      }
    }
    if (this.remotePlayer && !this.remotePlayer.dead && this.remotePlayer.team !== attackerTeam) {
      targets.push({ kind: 'remote', obj: this.remotePlayer, dist: Infinity });
    }
    // 玩家自己(当房主执行远程开火命中时)
    if (this.player && !this.player.dead && this.player.team !== attackerTeam && attackerId !== 'player') {
      targets.push({ kind: 'self', obj: this.player, dist: Infinity });
    }

    // 与地图碰撞先求最近距离(阻挡判定)
    // 注:colliders 是 Box3 列表,不能用 intersectObjects,需用 ray.intersectBox
    const block = this.raycastBoxes(origin, dir, weapon.range);
    const blockDist = block ? block.distance : Infinity;

    // 与每个target的AABB求交
    let bestHit = null;
    for (const t of targets) {
      const box = t.kind === 'self' ? this._playerBox() : t.obj.aabb;
      if (!box) continue;
      const hit = this.raycaster.ray.intersectBox(box, new THREE.Vector3());
      if (hit) {
        const d = origin.distanceTo(hit);
        if (d < blockDist && d < (bestHit ? bestHit.dist : Infinity)) {
          bestHit = { kind: t.kind, obj: t.obj, dist: d, point: hit };
        }
      }
    }

    if (bestHit) {
      // 爆头判定:命中点y > head位置
      const headY = bestHit.obj.position.y + 1.5;
      const isHead = bestHit.point.y >= headY - 0.15;
      const dmg = weapon.dmg * (isHead ? weapon.headMul : 1) * (this.isHost ? 1 : 1);
      this.applyDamage(bestHit.obj, dmg, isHead, attackerId, bestHit.point);
    }
  }

  _playerBox() {
    if (!this.player) return null;
    const p = this.player.position;
    const box = new THREE.Box3(
      new THREE.Vector3(p.x - 0.4, p.y, p.z - 0.4),
      new THREE.Vector3(p.x + 0.4, p.y + 1.8, p.z + 0.4)
    );
    return box;
  }

  // 对 Box3 列表做射线相交检测,返回 {distance, point} 或 null
  raycastBoxes(origin, dir, maxDist) {
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxDist;
    let best = null;
    const tmp = new THREE.Vector3();
    for (const c of this.colliders) {
      if (this.raycaster.ray.intersectBox(c, tmp)) {
        const d = origin.distanceTo(tmp);
        if (d <= maxDist && (!best || d < best.distance)) {
          best = { distance: d, point: tmp.clone() };
        }
      }
    }
    return best;
  }

  applyDamage(target, dmg, headShot, attackerId, hitPoint) {
    let died = false;
    if (target instanceof Bot) {
      died = target.takeDamage(dmg, headShot, attackerId, this._gameState());
      this.onHitFeedback(hitPoint, true);
    } else if (target === this.player) {
      // 玩家被击中(由远程或bot)
      if (this.player.invulnT > 0 || this.player.dead) return;
      this.player.hp -= dmg;
      this.onTakeDamageFeedback();
      if (this.player.hp <= 0) {
        this.player.dead = true;
        this.player.respawnT = PLAYER.respawnTime;
        this.player.deaths++;
        died = true;
        if (this.onDeath) this.onDeath({ by: attackerId });
      }
    } else if (target === this.remotePlayer) {
      // 远程玩家被击中(房主判定)
      target.hp -= dmg;
      if (target.hp <= 0) {
        target.dead = true;
        target.respawnT = PLAYER.respawnTime;
        target.deaths = (target.deaths || 0) + 1;
        died = true;
      }
    }

    if (died) {
      // 计算击杀方队伍并加分
      let attackerTeam;
      if (attackerId === 'player') attackerTeam = this.player.team;
      else if (attackerId === 'remote' && this.remotePlayer) attackerTeam = this.remotePlayer.team;
      else attackerTeam = 'B'; // bot
      this.kills[attackerTeam]++;
      if (attackerId === 'player') this.player.kills++;
      if (this.onKill) this.onKill({ attacker: attackerId, victim: target.name || (target === this.player ? 'You' : 'Remote'), headShot });
      // 房主广播KILL
      if (this.isHost && this.net && this.net.alive) {
        this.net.send({ type: Msg.KILL, attacker: attackerId, victim: target === this.player ? 'remote' : 'host', headShot });
      }
      this.checkWin();
    }
  }

  _gameState() {
    return {
      player: this.player,
      bots: this.bots,
      remotePlayer: this.remotePlayer,
      raycaster: this.raycaster,
      worldColliders: this.colliders,
      spawnPoints: this.spawnPoints,
      onBotFire: (bot, targetPos) => {
        // bot开火视觉(只tracer,不实际伤害,伤害由fire函数处理)
        const origin = new THREE.Vector3(bot.position.x, 1.4, bot.position.z);
        const dir = new THREE.Vector3().subVectors(
          new THREE.Vector3(targetPos.x, 1.4, targetPos.z), origin
        ).normalize();
        this.spawnTracer(origin, dir, bot.weapon);
        this.playShot(bot.weapon.id);
      },
      onBotHit: (bot, target, dmg, head) => {
        // bot击中了target(player或另一bot)
        this.applyDamage(target, dmg, head, bot.id);
      },
    };
  }

  spawnTracer(origin, dir, weapon) {
    const end = origin.clone().add(dir.clone().multiplyScalar(weapon.range));
    const geo = new THREE.BufferGeometry().setFromPoints([origin, end]);
    const mat = new THREE.LineBasicMaterial({ color: weapon.tracerColor, transparent: true, opacity: 0.9 });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this.tracers.push({ line, ttl: 0.08 });

    // 击中点火花
    const block = this.raycastBoxes(origin, dir, weapon.range);
    if (block) {
      this.spawnSparks(block.point);
    }
  }

  spawnSparks(point) {
    const count = 8;
    const positions = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      positions[i*3] = point.x; positions[i*3+1] = point.y; positions[i*3+2] = point.z;
      vels.push(new THREE.Vector3(
        (Math.random()-0.5)*3, Math.random()*3, (Math.random()-0.5)*3
      ));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0xffcc66, size: 0.08, transparent: true, opacity: 1 });
    const pts = new THREE.Points(geo, mat);
    this.scene.add(pts);
    this.particles.push({ pts, vels, ttl: 0.4 });
  }

  onHitFeedback(point, killed) {
    this.playHit();
    if (this.onHit) this.onHit({ point, killed });
  }

  onTakeDamageFeedback() {
    if (this.onTakeDamage) this.onTakeDamage();
  }

  // === 主循环 ===
  _loop() {
    if (this.disposed) return;
    requestAnimationFrame(this._loop);
    if (!this.running) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (!this.paused && !this.ended) {
      this.updatePlayer(dt);
      this.updateWeapon(dt);
      this.updateBots(dt);
      this.updateRemote(dt);
      this.updateEffects(dt);
      this.updateHUD();
      this.maybeSendNetState();
    }
    this.renderer.render(this.scene, this.camera);
  }

  updatePlayer(dt) {
    const p = this.player;
    if (p.dead) {
      p.respawnT -= dt;
      if (p.respawnT <= 0) this.respawnPlayer();
      return;
    }
    p.invulnT = Math.max(0, p.invulnT - dt);
    p.fireCd = Math.max(0, p.fireCd - dt);

    if (p.reloading) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        const w = WEAPONS[p.currentSlot === 'primary' ? p.primaryId : p.secondaryId];
        const need = w.mag - p.mag[w.id];
        const take = Math.min(need, p.reserve[w.id]);
        p.mag[w.id] += take;
        p.reserve[w.id] -= take;
        p.reloading = false;
      }
    }

    // 输入移动
    const moveDir = new THREE.Vector3();
    if (this.keys['KeyW']) moveDir.z -= 1;
    if (this.keys['KeyS']) moveDir.z += 1;
    if (this.keys['KeyA']) moveDir.x -= 1;
    if (this.keys['KeyD']) moveDir.x += 1;

    const running = this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    const speed = (running ? PLAYER.runSpeed : PLAYER.walkSpeed);

    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      // 应用yaw旋转
      const e = new THREE.Euler(0, this.yaw, 0, 'YXZ');
      moveDir.applyEuler(e);
      p.velocity.x = THREE.MathUtils.lerp(p.velocity.x, moveDir.x * speed, dt * PLAYER.accel);
      p.velocity.z = THREE.MathUtils.lerp(p.velocity.z, moveDir.z * speed, dt * PLAYER.accel);
    } else {
      p.velocity.x = THREE.MathUtils.lerp(p.velocity.x, 0, dt * PLAYER.decel);
      p.velocity.z = THREE.MathUtils.lerp(p.velocity.z, 0, dt * PLAYER.decel);
    }

    // 跳跃与重力
    if (this.keys['Space'] && p.onGround) {
      p.velocity.y = PLAYER.jumpVel;
      p.onGround = false;
    }
    p.velocity.y -= PLAYER.gravity * dt;

    // 移动+碰撞(分轴)
    this.movePlayerAxis(p, 'x', dt);
    this.movePlayerAxis(p, 'z', dt);
    p.position.y += p.velocity.y * dt;

    // 地面
    if (p.position.y <= 0) {
      p.position.y = 0;
      p.velocity.y = 0;
      p.onGround = true;
    } else {
      p.onGround = false;
    }

    // 开火:自动武器按住连发,半自动仅在mousedown边沿触发
    if (this.mouseDown && !p.dead) {
      const w = this.currentWeapon();
      if (w.auto) {
        this.fire();
      } else if (!this._lastMouseDown) {
        this.fire();
      }
    }
    this._lastMouseDown = this.mouseDown;

    this.updateCameraTransform();
  }

  movePlayerAxis(p, axis, dt) {
    const delta = p.velocity[axis] * dt;
    if (delta === 0) return;
    const old = p.position[axis];
    p.position[axis] += delta;
    if (this._playerCollides()) {
      p.position[axis] = old;
      p.velocity[axis] = 0;
    }
  }

  _playerCollides() {
    const p = this.player.position;
    const radius = PLAYER.radius;
    const box = new THREE.Box3(
      new THREE.Vector3(p.x - radius, p.y + 0.1, p.z - radius),
      new THREE.Vector3(p.x + radius, p.y + 1.8, p.z + radius)
    );
    for (const c of this.colliders) {
      if (c.intersectsBox(box)) return true;
    }
    return false;
  }

  updateCameraTransform() {
    this.camera.position.set(this.player.position.x, this.player.position.y + PLAYER.height, this.player.position.z);
    const e = new THREE.Euler(this.pitch + this.recoil.pitch, this.yaw + this.recoil.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(e);

    // ADS fov插值
    const w = this.currentWeapon();
    const targetFov = this.adsActive ? w.adsFov : 75;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 0.2);
    this.camera.updateProjectionMatrix();

    // 视图模型位置:ADS时居中,否则右下
    if (this.viewmodel && this.viewmodel._gun) {
      const targetX = this.adsActive ? 0 : 0.18;
      const targetY = this.adsActive ? -0.13 : -0.18;
      const targetZ = this.adsActive ? -0.28 : -0.35;
      this.viewmodel._gun.position.x = THREE.MathUtils.lerp(this.viewmodel._gun.position.x, targetX, 0.25);
      this.viewmodel._gun.position.y = THREE.MathUtils.lerp(this.viewmodel._gun.position.y, targetY, 0.25);
      this.viewmodel._gun.position.z = THREE.MathUtils.lerp(this.viewmodel._gun.position.z, targetZ, 0.25);
    }
  }

  updateWeapon(dt) {
    // 后坐力回弹
    if (this.recoil.time > 0) {
      this.recoil.time -= dt;
    } else {
      this.recoil.pitch = THREE.MathUtils.lerp(this.recoil.pitch, 0, dt * 8);
      this.recoil.yaw = THREE.MathUtils.lerp(this.recoil.yaw, 0, dt * 8);
    }
    // 枪口火焰淡出
    if (this.muzzleFlash && this.muzzleFlash.material.opacity > 0) {
      this.muzzleFlash.material.opacity = Math.max(0, this.muzzleFlash.material.opacity - dt * 12);
    }
    // 视图模型轻微bob(走动时)
    if (this.viewmodel && this.viewmodel._gun) {
      const speed = this.player.velocity.length();
      if (speed > 0.5 && this.player.onGround) {
        const t = performance.now() * 0.008;
        this.viewmodel._gun.position.y += Math.sin(t) * 0.0008;
        this.viewmodel._gun.rotation.z = Math.sin(t) * 0.005;
      }
    }
  }

  updateBots(dt) {
    const state = this._gameState();
    for (const b of this.bots) b.update(dt, state);
  }

  updateRemote(dt) {
    if (!this.remotePlayer) return;
    const r = this.remotePlayer;
    if (r.dead) {
      r.respawnT -= dt;
      if (r.respawnT <= 0 && this.isHost) {
        r.dead = false; r.hp = PLAYER.maxHp;
        const sp = this.spawnPoints.B[0];
        r.position.set(sp.x, 0, sp.z);
        r.mesh.visible = true;
        if (this.net && this.net.alive) {
          this.net.send({ type: Msg.RESPAWN, position: [sp.x, 0, sp.z] });
        }
      }
      return;
    }
    // 平滑插值到目标位置(由net消息更新)
    if (r.targetPos) {
      r.position.lerp(r.targetPos, Math.min(1, dt * 12));
    }
    if (r.targetYaw !== undefined) {
      r.mesh.rotation.y = THREE.MathUtils.lerp(r.mesh.rotation.y, r.targetYaw, Math.min(1, dt * 12));
    }
    r.mesh.position.copy(r.position);
    // 同步aabb用于命中检测
    if (r.aabb) {
      r.aabb.min.set(r.position.x - 0.4, r.position.y, r.position.z - 0.4);
      r.aabb.max.set(r.position.x + 0.4, r.position.y + 1.9, r.position.z + 0.4);
    }
  }

  updateEffects(dt) {
    // tracers
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.ttl -= dt;
      t.line.material.opacity = Math.max(0, t.ttl / 0.08 * 0.9);
      if (t.ttl <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose(); t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
    // 粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.ttl -= dt;
      const pos = p.pts.geometry.attributes.position.array;
      for (let j = 0; j < p.vels.length; j++) {
        p.vels[j].y -= 9 * dt;
        pos[j*3] += p.vels[j].x * dt;
        pos[j*3+1] += p.vels[j].y * dt;
        pos[j*3+2] += p.vels[j].z * dt;
      }
      p.pts.geometry.attributes.position.needsUpdate = true;
      p.pts.material.opacity = Math.max(0, p.ttl / 0.4);
      if (p.ttl <= 0) {
        this.scene.remove(p.pts);
        p.pts.geometry.dispose(); p.pts.material.dispose();
        this.particles.splice(i, 1);
      }
    }
  }

  respawnPlayer() {
    const p = this.player;
    p.dead = false;
    p.hp = PLAYER.maxHp;
    p.invulnT = PLAYER.invulnTime;
    const sp = this.spawnPoints.A[Math.floor(Math.random() * this.spawnPoints.A.length)];
    p.position.set(sp.x, 0, sp.z);
    p.velocity.set(0,0,0);
    const w = WEAPONS[p.primaryId];
    p.mag[w.id] = w.mag;
    const w2 = WEAPONS[p.secondaryId];
    p.mag[w2.id] = w2.mag;
    if (this.net && this.net.alive && this.isHost) {
      this.net.send({ type: Msg.RESPAWN, position: [sp.x, 0, sp.z], who: 'host' });
    }
  }

  checkWin() {
    if (this.kills.A >= this.killGoal || this.kills.B >= this.killGoal) {
      this.ended = true;
      const winner = this.kills.A >= this.killGoal ? 'A' : 'B';
      if (this.onGameEnd) this.onGameEnd(winner, this.kills);
      if (this.net && this.net.alive && this.isHost) {
        this.net.send({ type: Msg.END, winner, kills: this.kills });
      }
    }
  }

  updateHUD() {
    if (!this.onHudUpdate) return;
    const p = this.player;
    const w = this.currentWeapon();
    this.onHudUpdate({
      hp: Math.max(0, Math.ceil(p.hp)),
      hpMax: p.maxHp,
      weaponName: w.name,
      weaponSide: w.side,
      mag: p.mag[w.id],
      reserve: p.reserve[w.id],
      reloading: p.reloading,
      scoreA: this.kills.A,
      scoreB: this.kills.B,
      killGoal: this.killGoal,
      dead: p.dead,
      respawnT: p.respawnT,
    });
  }

  // === 联机 ===
  maybeSendNetState() {
    if (!this.net || !this.net.alive) return;
    const now = performance.now();
    if (now - this.lastStateSent < CONST.stateSyncInterval) return;
    this.lastStateSent = now;
    const p = this.player;
    if (this.isHost) {
      // 房主发送完整状态
      this.net.send({
        type: Msg.STATE,
        host: {
          pos: [p.position.x, p.position.y, p.position.z],
          yaw: this.yaw, pitch: this.pitch,
          hp: p.hp, dead: p.dead,
          weaponId: this.currentWeapon().id,
          kills: this.kills,
        },
        remote: this.remotePlayer ? {
          pos: [this.remotePlayer.position.x, this.remotePlayer.position.y, this.remotePlayer.position.z],
          yaw: this.remotePlayer.mesh ? this.remotePlayer.mesh.rotation.y : 0,
          hp: this.remotePlayer.hp, dead: this.remotePlayer.dead,
        } : null,
        kills: this.kills,
      });
    } else {
      // 客户端发送自己的输入
      this.net.send({
        type: Msg.INPUT,
        pos: [p.position.x, p.position.y, p.position.z],
        yaw: this.yaw, pitch: this.pitch,
        hp: p.hp, dead: p.dead,
        weaponId: this.currentWeapon().id,
        reloading: p.reloading,
      });
    }
  }

  onNetMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case Msg.HELLO: {
        // 房主:收到客户端的装备 → 分配team/spawn → 创建remotePlayer → 发WELCOME
        if (!this.isHost) return;
        this.remotePlayer = this.createRemotePlayer('B', msg.primaryId);
        this.net.send({
          type: Msg.WELCOME,
          team: 'B',
          spawn: [this.spawnPoints.B[0].x, 0, this.spawnPoints.B[0].z],
          killGoal: this.killGoal,
        });
        if (this.onNetStatus) this.onNetStatus('已与对手连线,战斗开始!');
        break;
      }
      case Msg.WELCOME: {
        // 客户端:收到房主欢迎
        this.player.team = msg.team;
        this.player.position.set(msg.spawn[0], 0, msg.spawn[2]);
        this.killGoal = msg.killGoal;
        // 创建远程玩家(房主)mesh
        this.remotePlayer = this.createRemotePlayer('A', this.player.primaryId);
        if (this.onNetStatus) this.onNetStatus('已加入房间,战斗开始!');
        break;
      }
      case Msg.INPUT: {
        // 房主收到客户端输入
        if (!this.isHost || !this.remotePlayer) return;
        this.remotePlayer.targetPos = new THREE.Vector3(msg.pos[0], msg.pos[1], msg.pos[2]);
        this.remotePlayer.targetYaw = msg.yaw;
        this.remotePlayer.hp = msg.hp;
        this.remotePlayer.dead = msg.dead;
        if (this.remotePlayer.mesh) this.remotePlayer.mesh.visible = !msg.dead;
        if (msg.weaponId && (!this.remotePlayer.weaponId || this.remotePlayer.weaponId !== msg.weaponId)) {
          this.remotePlayer.weaponId = msg.weaponId;
        }
        break;
      }
      case Msg.STATE: {
        // 客户端收到房主权威状态
        if (this.isHost) return;
        // 房主的状态 = remote player状态
        if (this.remotePlayer) {
          this.remotePlayer.targetPos = new THREE.Vector3(msg.host.pos[0], msg.host.pos[1], msg.host.pos[2]);
          this.remotePlayer.targetYaw = msg.host.yaw;
          this.remotePlayer.hp = msg.host.hp;
          this.remotePlayer.dead = msg.host.dead;
          if (this.remotePlayer.mesh) this.remotePlayer.mesh.visible = !msg.host.dead;
        }
        // 自己的状态由房主裁定(HP/dead)
        if (typeof msg.remote === 'object' && msg.remote) {
          // 我被房主同步HP
          this.player.hp = msg.remote.hp;
          this.player.dead = msg.remote.dead;
          if (msg.remote.dead && !this.player._wasDead) {
            this.player.respawnT = PLAYER.respawnTime;
            if (this.onDeath) this.onDeath({ by: 'remote' });
          }
          this.player._wasDead = msg.remote.dead;
        }
        this.kills = msg.kills || this.kills;
        break;
      }
      case Msg.FIRE: {
        // 远程玩家开火
        if (!this.remotePlayer || this.remotePlayer.dead) return;
        // 仅做视觉(房主实际做命中判定对玩家;客户端只画tracer)
        const origin = new THREE.Vector3(msg.origin[0], msg.origin[1], msg.origin[2]);
        const dir = new THREE.Vector3(msg.dir[0], msg.dir[1], msg.dir[2]);
        const w = WEAPONS[msg.weaponId];
        this.spawnTracer(origin, dir, w);
        this.playShot(msg.weaponId);
        if (this.muzzleFlash) {
          this.muzzleFlash.material.opacity = 1;
        }
        // 房主做命中判定:玩家是target
        if (this.isHost) {
          this.performHitscan(origin, dir, w, 'B', 'remote');
        }
        break;
      }
      case Msg.KILL: {
        if (this.onKill) this.onKill({ attacker: msg.attacker, victim: msg.victim, headShot: msg.headShot });
        break;
      }
      case Msg.RESPAWN: {
        if (this.isHost && this.remotePlayer) {
          this.remotePlayer.dead = false;
          this.remotePlayer.hp = PLAYER.maxHp;
          this.remotePlayer.position.set(msg.position[0], msg.position[1], msg.position[2]);
          if (this.remotePlayer.mesh) this.remotePlayer.mesh.visible = true;
        } else if (!this.isHost) {
          // 客户端:房主复活我
          this.player.dead = false;
          this.player.hp = PLAYER.maxHp;
          this.player.position.set(msg.position[0], msg.position[1], msg.position[2]);
        }
        break;
      }
      case Msg.END: {
        this.ended = true;
        const winner = msg.winner;
        if (this.onGameEnd) this.onGameEnd(winner, msg.kills || this.kills);
        break;
      }
    }
  }

  createRemotePlayer(team, weaponId) {
    const color = team === 'A' ? 0x4fa3ff : 0xff6b6b;
    const mesh = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffd2a0, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
    body.position.y = 0.9; body.castShadow = true;
    mesh.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), headMat);
    head.position.y = 1.65; head.castShadow = true;
    mesh.add(head);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.7 }));
    gun.position.set(0.35, 1.1, 0.3);
    mesh.add(gun);
    this.scene.add(mesh);

    return {
      mesh,
      body,
      position: new THREE.Vector3(),
      targetPos: null,
      targetYaw: 0,
      hp: PLAYER.maxHp,
      dead: false,
      respawnT: 0,
      team,
      weaponId,
      aabb: new THREE.Box3(),
    };
  }

  // === 暂停/退出 ===
  pause() {
    if (this.paused || this.ended) return;
    this.paused = true;
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.onPause) this.onPause();
  }
  resume() {
    this.paused = false;
    this.clock.getDelta(); // 重置
    if (this.onResume) this.onResume();
    if (this.running && !this.pointerLocked) this.canvas.requestPointerLock();
  }
  quit() {
    this.running = false;
    this.dispose();
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('pointerlockchange', this._onPLChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mousedown', this._onMouseDown);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('contextmenu', this._onCtx);
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('resize', this._onResize);
    if (this.net) this.net.close();
    if (this.renderer) this.renderer.dispose();
    // 清理bots
    for (const b of this.bots) b.dispose(this.scene);
    this.bots = [];
    // 清理地图与特效
    if (this.scene) {
      this.scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
    }
    this.scene = null;
  }
}
