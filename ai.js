// ai.js — 人机 AI
// 状态机: PATROL(巡逻) → APPROACH(听声接近,无视线) → ENGAGE(看见,开火) ; RELOAD
// 移动: 贴墙滑动 + 卡住绕行,保证能绕过月台等长障碍
import * as THREE from 'three';
import { WEAPONS, AI_DIFFICULTY, PLAYER } from './config.js';

const BOT_COLOR_A = 0x3a6ec9;
const BOT_COLOR_B = 0xc94f3a;

// 巡逻点:全部位于地面可行区域(外侧走廊 / 地图两端绕行带 / 中轴开阔地)
const WAYPOINTS = [
  // 右侧走廊(月台与外墙之间)
  new THREE.Vector3(24, 0, -32),
  new THREE.Vector3(24, 0, -12),
  new THREE.Vector3(24, 0, 12),
  new THREE.Vector3(24, 0, 32),
  // 左侧走廊
  new THREE.Vector3(-24, 0, -32),
  new THREE.Vector3(-24, 0, -12),
  new THREE.Vector3(-24, 0, 12),
  new THREE.Vector3(-24, 0, 32),
  // 地图两端(月台外侧,可横穿铁轨)
  new THREE.Vector3(0, 0, -36),
  new THREE.Vector3(0, 0, 36),
  // 中轴开阔地(集装箱之间的缝隙)
  new THREE.Vector3(0, 0, -20),
  new THREE.Vector3(0, 0, 20),
  new THREE.Vector3(0, 0, -8),
  new THREE.Vector3(0, 0, 8),
  new THREE.Vector3(-5, 0, -6),
  new THREE.Vector3(5, 0, 6),
];

const VIEW_RANGE = 45;    // 看见敌人的距离(需视线)
const HEAR_RANGE = 75;    // "听声"距离:无视线也会主动压过去

export class Bot {
  constructor(scene, { id, team, difficulty, spawn, primaryId, name }) {
    this.id = id;
    this.team = team; // 'A' 或 'B'
    this.diff = AI_DIFFICULTY[difficulty] || AI_DIFFICULTY.normal;
    this.difficulty = difficulty;
    this.name = name || `Bot${id}`;
    this.weapon = WEAPONS[primaryId] || WEAPONS.m4a1;
    this.maxHp = PLAYER.maxHp;
    this.hp = this.maxHp;
    this.dead = false;
    this.respawnT = 0;
    this.kills = 0;
    this.deaths = 0;
    this.position = new THREE.Vector3().copy(spawn);
    this.velocity = new THREE.Vector3();
    this.facing = new THREE.Vector3(1, 0, 0);
    this.target = new THREE.Vector3().copy(spawn);
    this.state = 'PATROL';
    this.fireCd = 0;
    this.burstLeft = 0;
    this.burstCd = 0;
    this.reactionT = 0;
    this.ammo = this.weapon.mag;
    this.reloading = false;
    this.reloadT = 0;
    this.invulnT = PLAYER.invulnTime;
    this.lastHitFlash = 0;
    this.bobPhase = Math.random() * Math.PI * 2;

    // 绕行状态
    this.stuckT = 0;        // 完全无法移动的累计时间
    this.detourT = 0;       // 绕行剩余时间
    this.detourDir = 1;     // 绕行方向
    this.strafeSign = Math.random() < 0.5 ? 1 : -1;
    this.strafeSwapT = 1 + Math.random() * 2;
    // 垂直运动(跳月台)
    this.velY = 0;
    this.onGround = true;

    // 视觉模型
    this.mesh = new THREE.Group();
    const color = team === 'A' ? BOT_COLOR_A : BOT_COLOR_B;
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.3 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffd2a0, roughness: 0.7 });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.7 });

    this.bodyMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), bodyMat);
    this.bodyMesh.position.y = 0.9;
    this.bodyMesh.castShadow = true;
    this.mesh.add(this.bodyMesh);

    this.headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), headMat);
    this.headMesh.position.y = 1.65;
    this.headMesh.castShadow = true;
    this.mesh.add(this.headMesh);

    this.gunMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.18, 0.7), gunMat);
    this.gunMesh.position.set(0.35, 1.1, 0.3);
    this.mesh.add(this.gunMesh);

    // 头顶敌方标识(红色菱形,Basic材质不受光照影响,雾中也醒目)
    this.marker = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.22),
      new THREE.MeshBasicMaterial({ color: 0xff3333 })
    );
    this.marker.position.y = 2.35;
    this.mesh.add(this.marker);

    this.mesh.position.copy(this.position);
    scene.add(this.mesh);

    // 用于命中检测的AABB
    this.aabb = new THREE.Box3();
    this.updateAABB();

    this.worldColliders = [];
    this.pickWaypoint();
  }

  updateAABB() {
    this.aabb.min.set(this.position.x - 0.4, this.position.y, this.position.z - 0.4);
    this.aabb.max.set(this.position.x + 0.4, this.position.y + 1.9, this.position.z + 0.4);
  }

  pickWaypoint() {
    // 倾向于选择离当前位置不太远的点,避免长距离卡住
    const candidates = WAYPOINTS.filter(w => w.distanceTo(this.position) > 6);
    const pool = candidates.length ? candidates : WAYPOINTS;
    const wpt = pool[Math.floor(Math.random() * pool.length)];
    this.target.set(wpt.x, 0, wpt.z);
  }

  // 由 game.js 调用:每帧更新
  update(dt, gameState) {
    if (this.dead) {
      this.respawnT -= dt;
      this.mesh.visible = false;
      if (this.respawnT <= 0) {
        this.respawn(gameState);
      }
      return null;
    }

    this.invulnT = Math.max(0, this.invulnT - dt);
    this.lastHitFlash = Math.max(0, this.lastHitFlash - dt);
    this.fireCd -= dt;
    this.burstCd -= dt;
    this.detourT = Math.max(0, this.detourT - dt);
    this.strafeSwapT -= dt;
    if (this.strafeSwapT <= 0) {
      this.strafeSign *= -1;
      this.strafeSwapT = 1.2 + Math.random() * 1.8;
    }

    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloading = false;
        this.ammo = this.weapon.mag;
      }
      this.syncMesh(dt);
      return null;
    }

    // 选择目标:可见敌人优先;否则找最近敌人"听声"
    const visibleEnemy = this.findEnemy(gameState, VIEW_RANGE, true);
    const anyEnemy = visibleEnemy || this.findEnemy(gameState, HEAR_RANGE, false);

    if (visibleEnemy) {
      if (this.state !== 'ENGAGE') {
        this.reactionT = this.diff.reaction;
        this.state = 'ENGAGE';
      }
      if (this.reactionT <= 0) {
        this.engage(visibleEnemy, dt, gameState);
      } else {
        this.faceTo(visibleEnemy.position);
        this.moveTowards(visibleEnemy.position, dt, false);
      }
    } else if (anyEnemy) {
      // 看不见但在听觉范围内:主动压上(滑动会绕过长障碍)
      this.state = 'APPROACH';
      this.faceTo(anyEnemy.position);
      this.moveTowards(anyEnemy.position, dt, true);
      // 接近中也顺手换弹
      if (this.ammo < this.weapon.mag * this.diff.reloadAt) this.startReload();
    } else {
      this.state = 'PATROL';
      if (this.ammo < this.weapon.mag * this.diff.reloadAt) this.startReload();
      this.patrol(dt);
    }

    this.syncMesh(dt);
    return null;
  }

  syncMesh(dt) {
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = Math.atan2(this.facing.x, this.facing.z);
    const speed = this.velocity.length();
    if (speed > 0.1) {
      this.bobPhase += dt * 9;
      this.bodyMesh.position.y = 0.9 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
      this.headMesh.position.y = 1.65 + Math.abs(Math.sin(this.bobPhase)) * 0.05;
    }
    // 头顶标识旋转
    this.marker.rotation.y += dt * 2.5;
    this.marker.position.y = 2.35 + Math.sin(performance.now() * 0.004 + this.id) * 0.08;
    // 受伤红闪
    if (this.lastHitFlash > 0) {
      this.bodyMesh.material.emissive.setRGB(0.5, 0, 0);
    } else {
      this.bodyMesh.material.emissive.setRGB(0, 0, 0);
    }
    this.updateAABB();
  }

  // 找最近敌人;requireLOS=true 时要求视线
  findEnemy(gameState, range, requireLOS) {
    let best = null, bestDist = Infinity;
    const check = (a) => {
      if (!a || a.dead) return;
      if (a === this || a.team === this.team) return;
      if (a.invulnT > 0) return;
      const d = a.position.distanceTo(this.position);
      if (d > range) return;
      if (requireLOS && !this.hasLineOfSight(a.position, gameState)) return;
      if (d < bestDist) { best = a; bestDist = d; }
    };
    if (gameState.player) check(gameState.player);
    if (gameState.bots) gameState.bots.forEach(b => check(b));
    if (gameState.remotePlayer) check(gameState.remotePlayer);
    return best;
  }

  hasLineOfSight(targetPos, gameState) {
    if (!gameState.worldColliders || !gameState.raycaster) return true;
    const origin = new THREE.Vector3(this.position.x, 1.4, this.position.z);
    const tgt = new THREE.Vector3(targetPos.x, 1.4, targetPos.z);
    const dist = origin.distanceTo(tgt);
    if (dist < 0.01) return true;
    const dir = new THREE.Vector3().subVectors(tgt, origin).normalize();
    gameState.raycaster.set(origin, dir);
    gameState.raycaster.far = dist;
    const tmp = new THREE.Vector3();
    for (const c of gameState.worldColliders) {
      if (gameState.raycaster.ray.intersectBox(c, tmp)) {
        if (origin.distanceTo(tmp) < dist) return false;
      }
    }
    return true;
  }

  faceTo(pos) {
    const dx = pos.x - this.position.x;
    const dz = pos.z - this.position.z;
    if (dx * dx + dz * dz > 0.001) this.facing.set(dx, 0, dz).normalize();
  }

  // 朝目标点移动(贴墙滑动 + 卡住绕行 + 矮障碍跳跃)
  moveTowards(pos, dt, run) {
    const speed = (run ? PLAYER.runSpeed : PLAYER.walkSpeed) * this.diff.moveSpeed;
    let dx = pos.x - this.position.x;
    let dz = pos.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.6) {
      this.velocity.set(0, 0, 0);
      this.updateVertical(dt);
      return true;
    }
    let nx = dx / dist, nz = dz / dist;

    // 卡住时偏转方向绕行(绕月台等长墙)
    if (this.detourT > 0) {
      const a = this.detourDir * 1.25;
      const cos = Math.cos(a), sin = Math.sin(a);
      const rx = nx * cos - nz * sin;
      const rz = nx * sin + nz * cos;
      nx = rx; nz = rz;
    }

    // 地面遇矮障碍(月台0.8m) → 起跳越过
    if (this.onGround) {
      const aheadBlocked = this.blockedAt3(this.position.x + nx * 0.7, this.position.y, this.position.z + nz * 0.7);
      const airClear = !this.blockedAt3(this.position.x + nx * 0.7, this.position.y + 0.9, this.position.z + nz * 0.7);
      if (aheadBlocked && airClear) {
        this.velY = 6.4;
        this.onGround = false;
      }
    }

    const mx = nx * speed * dt;
    const mz = nz * speed * dt;
    const moved = this.slideMove(mx, mz);

    this.facing.set(dx, 0, dz).normalize();

    if (!moved) {
      this.stuckT += dt;
      this.velocity.set(0, 0, 0);
      if (this.stuckT > 0.4 && this.detourT <= 0) {
        // 启动绕行,随机选一侧
        this.detourDir = Math.random() < 0.5 ? 1 : -1;
        this.detourT = 2.2;
        this.stuckT = 0;
      }
    } else {
      this.stuckT = 0;
      this.velocity.set(nx * speed, 0, nz * speed);
    }
    this.updateVertical(dt);
    return moved;
  }

  // 重力 + 两档台阶着陆(地面0 / 月台顶0.8)
  updateVertical(dt) {
    const p = this.position;
    this.velY -= PLAYER.gravity * dt;
    const ny = p.y + this.velY * dt;
    if (this.velY <= 0) {
      if (ny <= 0.001) {
        p.y = 0; this.velY = 0; this.onGround = true;
      } else if (!this.blockedAt3(p.x, ny, p.z)) {
        // 空中
        p.y = ny; this.onGround = false;
      } else {
        // 落到表面:吸附到最近的可行走高度
        if (ny <= 0.85 && !this.blockedAt3(p.x, 0.8, p.z)) {
          p.y = 0.8;
        } else {
          p.y = 0;
        }
        this.velY = 0; this.onGround = true;
      }
    } else {
      // 上升
      if (!this.blockedAt3(p.x, ny, p.z)) { p.y = ny; this.onGround = false; }
      else { this.velY = 0; }
    }
  }

  // 滑动:先整体移动,失败则分轴滑动
  slideMove(mx, mz) {
    const p = this.position;
    if (!this.blockedAt3(p.x + mx, p.y, p.z + mz)) {
      p.x += mx; p.z += mz;
      return true;
    }
    let moved = false;
    if (mx !== 0 && !this.blockedAt3(p.x + mx, p.y, p.z)) { p.x += mx; moved = true; }
    if (mz !== 0 && !this.blockedAt3(p.x, p.y, p.z + mz)) { p.z += mz; moved = true; }
    return moved;
  }

  patrol(dt) {
    const dist = this.target.distanceTo(this.position);
    if (dist < 1.8) this.pickWaypoint();
    this.moveTowards(this.target, dt, false);
  }

  engage(enemy, dt, gameState) {
    const dist = this.position.distanceTo(enemy.position);
    const ideal = this.weapon.type === 'sniper' ? 20 : 11;

    if (!this.hasLineOfSight(enemy.position, gameState)) {
      // 交火中丢失视线 → 压上去
      this.moveTowards(enemy.position, dt, true);
    } else if (dist > ideal + 2) {
      this.moveTowards(enemy.position, dt, true);
    } else if (dist < ideal - 3) {
      const back = new THREE.Vector3().subVectors(this.position, enemy.position).setY(0).normalize();
      this.moveTowards(this.position.clone().add(back.multiplyScalar(3)), dt, true);
    } else {
      // 横向晃动(直接给切向位移,避免每帧重算目标点)
      const right = new THREE.Vector3(-this.facing.z, 0, this.facing.x);
      this.slideMove(
        right.x * this.strafeSign * PLAYER.walkSpeed * this.diff.moveSpeed * 0.6 * dt,
        right.z * this.strafeSign * PLAYER.walkSpeed * this.diff.moveSpeed * 0.6 * dt
      );
      this.velocity.set(right.x * this.strafeSign, 0, right.z * this.strafeSign).multiplyScalar(PLAYER.walkSpeed);
    }
    this.faceTo(enemy.position);

    if (this.ammo <= 0 && !this.reloading) { this.startReload(); return; }
    if (this.ammo < this.weapon.mag * 0.25 && !this.reloading && this.burstLeft <= 0 && Math.random() < 0.3) {
      this.startReload();
      return;
    }

    if (this.fireCd <= 0 && this.ammo > 0 && !this.reloading) {
      if (this.burstLeft <= 0 && this.burstCd <= 0) {
        this.burstLeft = this.diff.burst;
        this.burstCd = 0.7 + Math.random() * 0.6;
      }
      if (this.burstLeft > 0) {
        this.fire(enemy, gameState);
        this.burstLeft--;
        this.fireCd = this.weapon.fireRate / 1000;
        this.ammo--;
      }
    }
  }

  fire(enemy, gameState) {
    if (gameState.onBotFire) gameState.onBotFire(this, enemy.position);
    const hitChance = this.diff.accuracy * this.hitModifier(enemy);
    if (Math.random() < hitChance) {
      const head = Math.random() < 0.15;
      const dmg = this.weapon.dmg * (head ? this.weapon.headMul : 1);
      if (gameState.onBotHit) gameState.onBotHit(this, enemy, dmg, head);
    }
  }

  hitModifier(enemy) {
    const dist = this.position.distanceTo(enemy.position);
    if (dist < 8) return 1.2;
    if (dist < 20) return 1.0;
    if (dist < 30) return 0.7;
    return 0.5;
  }

  startReload() {
    if (this.reloading || this.ammo >= this.weapon.mag) return;
    this.reloading = true;
    this.reloadT = this.weapon.reload;
  }

  blockedAt3(x, y, z) {
    if (!this.worldColliders) return false;
    const radius = 0.4;
    // +0.02 皮肤间隙,避免盒底恰好贴着表面时被误判为碰撞
    const min = new THREE.Vector3(x - radius, y + 0.02, z - radius);
    const max = new THREE.Vector3(x + radius, y + 1.85, z + radius);
    for (const c of this.worldColliders) {
      if (c.intersectsBox(_tmpBox.set(min, max))) return true;
    }
    // 地图边界
    if (x < -36.5 || x > 36.5 || z < -36.5 || z > 36.5) return true;
    return false;
  }

  takeDamage(dmg, headShot, fromId, gameState) {
    if (this.dead || this.invulnT > 0) return false;
    this.hp -= dmg;
    this.lastHitFlash = 0.15;
    if (this.hp <= 0) {
      this.die(gameState);
      return true;
    }
    this.state = 'ENGAGE';
    this.reactionT = Math.min(this.reactionT, this.diff.reaction * 0.4);
    return false;
  }

  die(gameState) {
    this.dead = true;
    this.deaths++;
    this.respawnT = PLAYER.respawnTime;
    this.mesh.visible = false;
  }

  respawn(gameState) {
    this.dead = false;
    this.hp = this.maxHp;
    this.invulnT = PLAYER.invulnTime;
    this.ammo = this.weapon.mag;
    this.reloading = false;
    this.state = 'PATROL';
    this.stuckT = 0; this.detourT = 0;
    const spawns = gameState.spawnPoints[this.team];
    const p = spawns[Math.floor(Math.random() * spawns.length)];
    this.position.set(p.x, 0, p.z);
    this.velocity.set(0, 0, 0);
    this.velY = 0;
    this.onGround = true;
    this.stuckT = 0; this.detourT = 0;
    this.mesh.visible = true;
    this.mesh.position.copy(this.position);
    this.updateAABB();
    this.pickWaypoint();
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.bodyMesh.geometry.dispose();
    this.headMesh.geometry.dispose();
    this.gunMesh.geometry.dispose();
    this.marker.geometry.dispose();
    this.marker.material.dispose();
  }
}

const _tmpBox = new THREE.Box3();
