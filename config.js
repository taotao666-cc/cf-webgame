// config.js — 武器数据、玩家参数、常量
// 通过 ES module 导出

export const WEAPONS = {
  m4a1: {
    id: 'm4a1', name: 'M4A1', side: 'US', type: 'rifle',
    dmg: 28, headMul: 2.0, fireRate: 100, mag: 30, reserve: 90,
    reload: 2.1, recoil: 0.012, spread: 0.006, adsSpread: 0.0015,
    adsFov: 55, auto: true, range: 200, bulletSpeed: 280,
    tracerColor: 0xffcf6b,
  },
  deagle: {
    id: 'deagle', name: 'Desert Eagle', side: 'US', type: 'pistol',
    dmg: 48, headMul: 2.2, fireRate: 280, mag: 7, reserve: 35,
    reload: 1.8, recoil: 0.03, spread: 0.01, adsSpread: 0.003,
    adsFov: 65, auto: false, range: 120, bulletSpeed: 260,
    tracerColor: 0xffcf6b,
  },
  awp: {
    id: 'awp', name: 'AWP', side: 'US', type: 'sniper',
    dmg: 115, headMul: 2.5, fireRate: 1500, mag: 5, reserve: 20,
    reload: 3.0, recoil: 0.02, spread: 0.002, adsSpread: 0.0002,
    adsFov: 20, auto: false, range: 400, bulletSpeed: 400,
    tracerColor: 0xff5544, scope: true,
  },
  qbz95: {
    id: 'qbz95', name: 'QBZ-95', side: 'CN', type: 'rifle',
    dmg: 26, headMul: 2.0, fireRate: 95, mag: 30, reserve: 90,
    reload: 2.2, recoil: 0.013, spread: 0.007, adsSpread: 0.0018,
    adsFov: 55, auto: true, range: 200, bulletSpeed: 290,
    tracerColor: 0xffcf6b,
  },
  qsz92: {
    id: 'qsz92', name: 'QSZ-92', side: 'CN', type: 'pistol',
    dmg: 34, headMul: 2.0, fireRate: 200, mag: 20, reserve: 80,
    reload: 1.6, recoil: 0.02, spread: 0.009, adsSpread: 0.0025,
    adsFov: 65, auto: false, range: 100, bulletSpeed: 250,
    tracerColor: 0xffcf6b,
  },
  type88: {
    id: 'type88', name: '88式狙击', side: 'CN', type: 'sniper',
    dmg: 95, headMul: 2.4, fireRate: 1200, mag: 10, reserve: 30,
    reload: 2.8, recoil: 0.015, spread: 0.004, adsSpread: 0.0003,
    adsFov: 25, auto: false, range: 380, bulletSpeed: 380,
    tracerColor: 0xff5544, scope: true,
  },
};

export const PRIMARY_IDS = ['m4a1', 'awp', 'qbz95', 'type88'];
export const SECONDARY_IDS = ['deagle', 'qsz92'];

// 玩家参数
export const PLAYER = {
  maxHp: 100,
  height: 1.7,            // 站立眼高
  crouchHeight: 1.2,
  radius: 0.35,           // 胶囊半径
  walkSpeed: 5.5,
  runSpeed: 8.5,
  jumpVel: 6.0,
  gravity: 18,
  airControl: 0.3,
  accel: 12,
  decel: 10,
  respawnTime: 3,         // 秒
  invulnTime: 1.5,        // 复活无敌
};

// AI 难度参数
export const AI_DIFFICULTY = {
  easy:   { reaction: 0.6, accuracy: 0.35, burst: 3, moveSpeed: 0.6, reloadAt: 0.3 },
  normal: { reaction: 0.35, accuracy: 0.55, burst: 4, moveSpeed: 0.85, reloadAt: 0.4 },
  hard:   { reaction: 0.18, accuracy: 0.78, burst: 5, moveSpeed: 1.0, reloadAt: 0.5 },
};

// 游戏常量
export const CONST = {
  teamA: 'A',
  teamB: 'B',
  killGoalDefault: 30,
  stateSyncHz: 20,
  stateSyncInterval: 1000 / 20,
};

// 出生点(位于两侧外墙与月台之间的贯通走廊,无遮挡)
export const SPAWN_POINTS = {
  A: [
    { x: -24, y: 0, z: -20 },
    { x: -24, y: 0, z: -26 },
    { x: -26, y: 0, z: -16 },
    { x: -26, y: 0, z: -24 },
  ],
  B: [
    { x: 24, y: 0, z: 20 },
    { x: 24, y: 0, z: 26 },
    { x: 26, y: 0, z: 16 },
    { x: 26, y: 0, z: 24 },
  ],
};

// 武器选择枚举的UI辅助
export function buildWeaponOptions() {
  const primary = PRIMARY_IDS.map(id => `<option value="${id}">${WEAPONS[id].name} (${WEAPONS[id].side})</option>`).join('');
  const secondary = SECONDARY_IDS.map(id => `<option value="${id}">${WEAPONS[id].name} (${WEAPONS[id].side})</option>`).join('');
  return { primary, secondary };
}
