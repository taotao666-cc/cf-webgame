// ai.js — 人机 AI
import * as THREE from 'three';
import { WEAPONS, AI_DIFFICULTY, PLAYER } from './config.js';

const BOT_COLOR_A = 0x3a6ec9;
const BOT_COLOR_B = 0xc94f3a;

// AI 巡逻点(随机选择)
const WAYPOINTS = [
  new THREE.Vector3(-15, 0, -10),
  new THREE.Vector3(-8, 0, -5),
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(8, 0, 5),
  new THREE.Vector3(15, 0, 10),
  new THREE.Vector3(-12, 0, 8),
  new THREE.Vector3(12, 0, -8),
  new THREE.Vector3(-6, 4, 0),  // 天桥上
  new THREE.Vector3(6, 4, 0),
  new THREE.Vector3(-20, 0, -15),
  new THREE.Vector3(20, 0, 15),
];

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

    // 名牌(可选,简化为不可见)
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);

    // 用于命中检测的AABB
    this.aabb = new THREE.Box3();
    this.updateAABB();

    this.pickWaypoint();
  }

  updateAABB() {
    this.aabb.min.set(this.position.x - 0.4, this.position.y, this.position.z - 0.4);
    this.aabb.max.set(this.position.x + 0.4, this.position.y + 1.9, this.position.z + 0.4);
  }

  pickWaypoint() {
    const wpt = WAYPOINTS[Math.floor(Math.random() * WAYPOINTS.length)];
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
    this.reactionT -= dt;

    if (this.reloading) {
      this.reloadT -= dt;
      if (this.reloadT <= 0) {
        this.reloading = false;
        this.ammo = this.weapon.mag;
      } else {
        // 换弹中不能开火
        this.mesh.position.copy(this.position);
        this.updateAABB();
        return null;
      }
    }

    // 选择目标(优先可见敌人)
    const enemy = this.findEnemy(gameState);

    if (enemy) {
      if (this.state !== 'ENGAGE') {
        this.reactionT = this.diff.reaction;
        this.state = 'ENGAGE';
      }
      if (this.reactionT <= 0) {
        this.engage(enemy, dt, gameState);
      } else {
        // 反应中:瞄准但不射击
        this.faceTo(enemy.position);
        this.moveTowards(enemy.position, dt, false);
      }
    } else {
      // 没有敌人 → 巡逻/换弹
      if (this.ammo < this.weapon.mag * this.diff.reloadAt && !this.reloading) {
        this.startReload();
      }
      this.state = 'PATROL';
      this.patrol(dt, gameState);
    }

    // 视觉
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = Math.atan2(this.facing.x, this.facing.z);
    // 走动bob
    const speed = this.velocity.length();
    if (speed > 0.1) {
      this.bobPhase += dt * 8;
      this.bodyMesh.position.y = 0.9 + Math.sin(this.bobPhase) * 0.04;
      this.headMesh.position.y = 1.65 + Math.sin(this.bobPhase) * 0.04;
    }
    // 受伤红色flash
    if (this.lastHitFlash > 0) {
      this.bodyMesh.material.emissive.setRGB(0.5, 0, 0);
    } else {
      this.bodyMesh.material.emissive.setRGB(0, 0, 0);
    }

    this.updateAABB();
    return null;
  }

  findEnemy(gameState) {
    // 找最近的非本队的活着的actor
    let best = null, bestDist = Infinity;
    const check = (a) => {
      if (!a || a.dead) return;
      if (a.team === this.team) return;
      if (a.invulnT > 0) return;
      const d = a.position.distanceTo(this.position);
      if (d > 35) return; // 视野距离
      // 视线检测
      if (!this.hasLineOfSight(a.position, gameState)) return;
      if (d < bestDist) { best = a; bestDist = d; }
    };
    check(gameState.player);
    if (gameState.bots) gameState.bots.forEach(b => b !== this && check(b));
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
        const d = origin.distanceTo(tmp);
        if (d < dist) return false;
      }
    }
    return true;
  }

  faceTo(pos) {
    const dx = pos.x - this.position.x;
    const dz = pos.z - this.position.z;
    this.facing.set(dx, 0, dz).normalize();
  }

  moveTowards(target, dt, run) {
    const speed = (run ? PLAYER.runSpeed : PLAYER.walkSpeed) * this.diff.moveSpeed;
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.5) return;
    const vx = (dx / dist) * speed;
    const vz = (dz / dist) * speed;
    const move = new THREE.Vector3(vx * dt, 0, vz * dt);
    if (!this.collidesAt(this.position.clone().add(move), this.worldColliders)) {
      this.position.add(move);
      this.facing.set(dx, 0, dz).normalize();
    } else {
      // 卡住 → 换waypoint
      this.pickWaypoint();
    }
    this.velocity.set(vx, 0, vz);
  }

  patrol(dt, gameState) {
    const dx = this.target.x - this.position.x;
    const dz = this.target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.5) this.pickWaypoint();
    this.moveTowards(this.target, dt, false);
  }

  engage(enemy, dt, gameState) {
    const dist = this.position.distanceTo(enemy.position);
    // 保持距离
    const ideal = this.weapon.type === 'sniper' ? 18 : 10;
    if (dist > ideal + 2) {
      this.moveTowards(enemy.position, dt, true);
    } else if (dist < ideal - 2) {
      // 后撤
      const back = new THREE.Vector3().subVectors(this.position, enemy.position).setY(0).normalize();
      const tgt = this.position.clone().add(back.multiplyScalar(3));
      this.moveTowards(tgt, dt, true);
    } else {
      // 横向移动(左右晃)
      const right = new THREE.Vector3().crossVectors(this.facing, new THREE.Vector3(0,1,0)).normalize();
      const tgt = this.position.clone().add(right.multiplyScalar(Math.sin(performance.now()*0.002) * 2));
      this.moveTowards(tgt, dt, false);
    }
    this.faceTo(enemy.position);

    // 换弹检查
    if (this.ammo <= 0 && !this.reloading) {
      this.startReload();
      return;
    }
    if (this.ammo < this.weapon.mag * 0.25 && !this.reloading && Math.random() < 0.5) {
      this.startReload();
      return;
    }

    // 开火
    if (this.fireCd <= 0 && this.ammo > 0 && !this.reloading) {
      if (this.burstLeft <= 0 && this.burstCd <= 0) {
        this.burstLeft = this.diff.burst;
        this.burstCd = 0.8 + Math.random() * 0.5;
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
    // 视觉:tracer
    if (gameState.onBotFire) gameState.onBotFire(this, enemy.position);

    // 命中判定:按精度
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
    if (this.reloading) return;
    if (this.ammo >= this.weapon.mag) return;
    this.reloading = true;
    this.reloadT = this.weapon.reload;
  }

  collidesAt(pos, colliders) {
    if (!colliders) return false;
    const radius = 0.4;
    const box = new THREE.Box3(
      new THREE.Vector3(pos.x - radius, 0.1, pos.z - radius),
      new THREE.Vector3(pos.x + radius, 1.9, pos.z + radius)
    );
    for (const c of colliders) {
      if (c.intersectsBox(box)) return true;
    }
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
    // 受伤切到 ENGAGE 状态
    this.state = 'ENGAGE';
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
    const spawns = gameState.spawnPoints[this.team];
    const p = spawns[Math.floor(Math.random() * spawns.length)];
    this.position.set(p.x, 0, p.z);
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
  }
}
