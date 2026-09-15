// map.js — 火车站地图(参考 CF 沙漠-灰 / 火车站风格)
import * as THREE from 'three';

const MAT = {
  ground:   new THREE.MeshStandardMaterial({ color: 0xb9a079, roughness: 0.95, metalness: 0.0 }),
  rail:     new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.4, metalness: 0.8 }),
  sleeper:  new THREE.MeshStandardMaterial({ color: 0x5a3d28, roughness: 0.95 }),
  platform: new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.9 }),
  platformEdge: new THREE.MeshStandardMaterial({ color: 0xffd25a, roughness: 0.5 }),
  carBody:  new THREE.MeshStandardMaterial({ color: 0x6e7a82, roughness: 0.55, metalness: 0.7 }),
  carTop:   new THREE.MeshStandardMaterial({ color: 0x3a4348, roughness: 0.5, metalness: 0.7 }),
  glass:    new THREE.MeshStandardMaterial({ color: 0x88c5e0, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.45 }),
  metal:    new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.5, metalness: 0.8 }),
  wall:     new THREE.MeshStandardMaterial({ color: 0xd4c5a0, roughness: 0.9 }),
  wallDark: new THREE.MeshStandardMaterial({ color: 0x8a7a55, roughness: 0.9 }),
  containerRed: new THREE.MeshStandardMaterial({ color: 0xc94f3a, roughness: 0.7, metalness: 0.4 }),
  containerBlue: new THREE.MeshStandardMaterial({ color: 0x3a6ec9, roughness: 0.7, metalness: 0.4 }),
  containerGreen: new THREE.MeshStandardMaterial({ color: 0x4a8c4a, roughness: 0.7, metalness: 0.4 }),
  crate:    new THREE.MeshStandardMaterial({ color: 0xa07a3a, roughness: 0.95 }),
  stair:    new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.5, metalness: 0.7 }),
  pillar:   new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.5, metalness: 0.7 }),
  barrel:   new THREE.MeshStandardMaterial({ color: 0xcc6622, roughness: 0.6, metalness: 0.5 }),
};

function addBox(group, colliders, w, h, d, x, y, z, mat, opts = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  if (opts.cast !== false) mesh.castShadow = true;
  if (opts.recv !== false) mesh.receiveShadow = true;
  if (opts.rotY) mesh.rotation.y = opts.rotY;
  group.add(mesh);
  if (!opts.noCollide) {
    // 旋转的盒子碰撞简化为AABB(覆盖范围)
    const box = new THREE.Box3().setFromObject(mesh);
    colliders.push(box);
  }
  return mesh;
}

export function buildMap() {
  const group = new THREE.Group();
  const colliders = [];

  // ===== 地面 =====
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    MAT.ground
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // 地面纹理网格(视觉细节)
  for (let i = -3; i <= 3; i++) {
    for (let j = -3; j <= 3; j++) {
      if ((i + j) % 2 === 0) continue;
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 10),
        new THREE.MeshStandardMaterial({ color: 0xa89060, roughness: 0.95 })
      );
      tile.rotation.x = -Math.PI / 2;
      tile.position.set(i * 10, 0.01, j * 10);
      tile.receiveShadow = true;
      group.add(tile);
    }
  }

  // ===== 铁轨 (两条,沿Z轴贯通) =====
  for (const zPos of [-6, 6]) {
    // 枕木
    for (let z = -35; z <= 35; z += 1.5) {
      addBox(group, colliders, 0.25, 0.12, 1.2, -0.8, 0.06, z, MAT.sleeper, { cast: false });
      addBox(group, colliders, 0.25, 0.12, 1.2,  0.8, 0.06, z, MAT.sleeper, { cast: false });
    }
    // 钢轨
    for (const xPos of [-0.8, 0.8]) {
      addBox(group, colliders, 0.12, 0.12, 70, xPos, 0.18, 0, MAT.rail, { recv: false });
    }
  }

  // ===== 月台 (两侧) =====
  // 月台A: 左
  addBox(group, colliders, 6, 0.8, 70, -16, 0.4, 0, MAT.platform);
  // 月台B: 右
  addBox(group, colliders, 6, 0.8, 70, 16, 0.4, 0, MAT.platform);
  // 月台边缘黄色安全线
  for (const xPos of [-13.5, 13.5]) {
    addBox(group, colliders, 0.15, 0.02, 70, xPos, 0.81, 0, MAT.platformEdge, { cast: false, noCollide: true });
  }

  // ===== 火车车厢 2节 =====
  // 车厢1 (月台A侧,半进站)
  buildTrainCar(group, colliders, -16, 0, -2, MAT);
  // 车厢2 (月台B侧)
  buildTrainCar(group, colliders, 16, 0, 4, MAT);

  // ===== 集装箱掩体 =====
  // 中央对峙区
  const containers = [
    { x: -6,  z: -10, w: 4, h: 3, d: 2.5, mat: MAT.containerRed,   rotY: 0 },
    { x:  6,  z:  10, w: 4, h: 3, d: 2.5, mat: MAT.containerBlue,  rotY: 0 },
    { x: -8,  z:   4, w: 4, h: 3, d: 2.5, mat: MAT.containerBlue,  rotY: Math.PI/2 },
    { x:  8,  z:  -4, w: 4, h: 3, d: 2.5, mat: MAT.containerRed,   rotY: Math.PI/2 },
    { x:  0,  z:   0, w: 5, h: 3.5, d: 3, mat: MAT.containerGreen, rotY: 0 },
    { x: -3,  z:   8, w: 3, h: 2.5, d: 2, mat: MAT.containerRed,   rotY: Math.PI/2 },
    { x:  3,  z:  -8, w: 3, h: 2.5, d: 2, mat: MAT.containerBlue,  rotY: Math.PI/2 },
    { x: -10, z:  -2, w: 3, h: 2.5, d: 2, mat: MAT.containerGreen, rotY: 0 },
    { x:  10, z:   2, w: 3, h: 2.5, d: 2, mat: MAT.containerGreen, rotY: 0 },
  ];
  for (const c of containers) {
    addBox(group, colliders, c.w, c.h, c.d, c.x, c.h/2, c.z, c.mat, { rotY: c.rotY });
  }

  // 集装箱堆叠 (高层)
  addBox(group, colliders, 3, 2.5, 2.5, -6, 4.25, -10, MAT.containerRed, { rotY: 0 });
  addBox(group, colliders, 3, 2.5, 2.5, 6,  4.25, 10,  MAT.containerBlue, { rotY: 0 });

  // ===== 候车厅 (两端) =====
  // A 端候车厅
  buildWaitingHall(group, colliders, -26, 0, 0, MAT);
  // B 端候车厅
  buildWaitingHall(group, colliders, 26, 0, 0, MAT, true);

  // ===== 楼梯 (上月台二楼) =====
  buildStairs(group, colliders, -13.5, 0, -20, MAT);
  buildStairs(group, colliders, 13.5, 0, 20, MAT, true);

  // ===== 二楼过道 =====
  // 左侧二楼天桥
  addBox(group, colliders, 4, 0.3, 18, -13.5, 4, 0, MAT.metal);
  // 右侧
  addBox(group, colliders, 4, 0.3, 18, 13.5, 4, 0, MAT.metal);
  // 中央天桥连接两端
  addBox(group, colliders, 27, 0.3, 3, 0, 5.5, 0, MAT.metal);
  // 天桥栏杆(装饰,可碰撞)
  addBox(group, colliders, 27, 1.0, 0.2, 0, 6.15, 1.6, MAT.metal, { cast: false });
  addBox(group, colliders, 27, 1.0, 0.2, 0, 6.15, -1.6, MAT.metal, { cast: false });

  // 二楼栏杆两侧
  addBox(group, colliders, 0.2, 1.0, 18, -15.5, 4.65, 0, MAT.metal, { cast: false });
  addBox(group, colliders, 0.2, 1.0, 18, -11.5, 4.65, 0, MAT.metal, { cast: false });
  addBox(group, colliders, 0.2, 1.0, 18,  15.5, 4.65, 0, MAT.metal, { cast: false });
  addBox(group, colliders, 0.2, 1.0, 18,  11.5, 4.65, 0, MAT.metal, { cast: false });

  // ===== 柱子 =====
  const pillars = [
    [-12, 0, -8], [12, 0, 8], [-12, 0, 8], [12, 0, -8],
    [-12, 0, 0], [12, 0, 0], [0, 0, -12], [0, 0, 12],
  ];
  for (const [x, y, z] of pillars) {
    addBox(group, colliders, 0.6, 5, 0.6, x, 2.5, z, MAT.pillar);
  }

  // ===== 木箱小掩体 =====
  const crates = [
    [ -2, 0, -3, 1, 1, 1], [ 2, 0, 3, 1, 1, 1],
    [ -4, 0, 2, 1.2, 1, 1.2], [ 4, 0, -2, 1.2, 1, 1.2],
    [ -1, 0, 5, 1, 1, 1], [ 1, 0, -5, 1, 1, 1],
    [ -9, 0, 6, 1.5, 1.2, 1.5], [ 9, 0, -6, 1.5, 1.2, 1.5],
    [ -5, 0, -7, 1, 1, 1], [ 5, 0, 7, 1, 1, 1],
  ];
  for (const [x, y, z, w, h, d] of crates) {
    addBox(group, colliders, w, h, d, x, h/2, z, MAT.crate);
  }

  // ===== 油桶装饰 =====
  for (const [x, z] of [[-7, -3], [7, 3], [-3, 12], [3, -12]]) {
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 1.2, 16),
      MAT.barrel
    );
    barrel.position.set(x, 0.6, z);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    group.add(barrel);
    colliders.push(new THREE.Box3().setFromObject(barrel));
  }

  // ===== 周围墙(防出界) =====
  const wallMat = MAT.wallDark;
  addBox(group, colliders, 80, 6, 0.5, 0, 3, -38, wallMat, { recv: false });
  addBox(group, colliders, 80, 6, 0.5, 0, 3,  38, wallMat, { recv: false });
  addBox(group, colliders, 0.5, 6, 76, -38, 3, 0, wallMat, { recv: false });
  addBox(group, colliders, 0.5, 6, 76,  38, 3, 0, wallMat, { recv: false });

  return { group, colliders };
}

function buildTrainCar(group, colliders, x, y, z, MAT) {
  // 车身(中空,可在月台与车之间穿行)
  const carLen = 16, carW = 3.5, carH = 3.5;
  // 底盘
  addBox(group, colliders, carW, 0.4, carLen, x, 0.6, z, MAT.carBody);
  // 顶
  addBox(group, colliders, carW, 0.2, carLen, x, carH + 0.1, z, MAT.carTop);
  // 左侧墙(留中间缺口)
  addBox(group, colliders, 0.2, carH - 0.4, carLen/2 - 1.5, x - carW/2, 0.8 + (carH-0.4)/2, z - (carLen/2 - 1.5)/2 + 0, MAT.carBody);
  addBox(group, colliders, 0.2, carH - 0.4, carLen/2 - 1.5, x - carW/2, 0.8 + (carH-0.4)/2, z + (carLen/2 - 1.5)/2 + 0, MAT.carBody);
  // 右侧墙
  addBox(group, colliders, 0.2, carH - 0.4, carLen/2 - 1.5, x + carW/2, 0.8 + (carH-0.4)/2, z - (carLen/2 - 1.5)/2 + 0, MAT.carBody);
  addBox(group, colliders, 0.2, carH - 0.4, carLen/2 - 1.5, x + carW/2, 0.8 + (carH-0.4)/2, z + (carLen/2 - 1.5)/2 + 0, MAT.carBody);
  // 端墙
  addBox(group, colliders, carW, carH - 0.4, 0.2, x, 0.8 + (carH-0.4)/2, z - carLen/2, MAT.carBody);
  addBox(group, colliders, carW, carH - 0.4, 0.2, x, 0.8 + (carH-0.4)/2, z + carLen/2, MAT.carBody);
  // 车窗(装饰,玻璃)
  for (let i = 0; i < 4; i++) {
    const wx = x - carW/2 - 0.02;
    const wz = z - carLen/2 + 2 + i * (carLen - 4) / 3;
    addBox(group, colliders, 0.05, 1.2, 1.5, wx, 2.0, wz, MAT.glass, { cast: false, noCollide: true });
    addBox(group, colliders, 0.05, 1.2, 1.5, x + carW/2 + 0.02, 2.0, wz, MAT.glass, { cast: false, noCollide: true });
  }
  // 车轮(装饰)
  for (let i = 0; i < 4; i++) {
    for (const dir of [-1, 1]) {
      const w = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.2, 12),
        MAT.metal
      );
      w.rotation.z = Math.PI / 2;
      w.position.set(x + dir * 0.3, 0.3, z - carLen/2 + 2 + i * (carLen - 4) / 3);
      w.castShadow = true;
      group.add(w);
    }
  }
}

function buildWaitingHall(group, colliders, x, y, z, MAT, flip = false) {
  // 大厅地板
  addBox(group, colliders, 8, 0.1, 10, x, 0.05, z, MAT.platform, { cast: false });
  // 后墙
  addBox(group, colliders, 0.3, 5, 10, x + (flip ? -4 : 4), 2.5, z, MAT.wall);
  // 侧墙
  addBox(group, colliders, 8, 5, 0.3, x, 2.5, z - 5, MAT.wall);
  addBox(group, colliders, 8, 5, 0.3, x, 2.5, z + 5, MAT.wall);
  // 顶
  addBox(group, colliders, 8, 0.3, 10, x, 5, z, MAT.metal, { cast: false });
  // 入口柱子(开敞)
  for (const zz of [-4, 0, 4]) {
    addBox(group, colliders, 0.5, 5, 0.5, x + (flip ? -0.5 : 0.5) - (flip ? 0 : 0), 2.5, z + zz, MAT.pillar);
  }
  // 长椅(装饰,可碰撞)
  for (const zz of [-3, 3]) {
    addBox(group, colliders, 2, 0.5, 0.6, x, 0.3, z + zz, MAT.wall);
  }
}

function buildStairs(group, colliders, x, y, z, MAT, flip = false) {
  const stepCount = 8;
  const stepH = 0.5;
  const stepD = 0.35;
  const dir = flip ? -1 : 1;
  for (let i = 0; i < stepCount; i++) {
    addBox(group, colliders, 1.8, stepH, stepD,
      x,
      0.25 + i * stepH / 2,
      z + i * stepD * dir,
      MAT.stair
    );
  }
  // 二楼平台接驳
  addBox(group, colliders, 1.8, 0.3, 1, x, 4, z + stepCount * stepD * dir, MAT.metal);
}
