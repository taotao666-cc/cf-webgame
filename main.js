// main.js — 启动入口、UI 状态机、HUD 接线
import { Game } from './game.js';
import { WEAPONS, PRIMARY_IDS, SECONDARY_IDS, buildWeaponOptions, CONST } from './config.js';
import { NetManager } from './net.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gameCanvas');

let game = null;
let netManager = null;

// 填充武器下拉
function fillWeaponSelects() {
  const { primary, secondary } = buildWeaponOptions();
  ['primaryWeapon', 'primaryWeaponHost', 'primaryWeaponJoin'].forEach(id => { $(id).innerHTML = primary; });
  ['secondaryWeapon', 'secondaryWeaponHost', 'secondaryWeaponJoin'].forEach(id => { $(id).innerHTML = secondary; });
  // 默认值
  ['primaryWeapon', 'primaryWeaponHost', 'primaryWeaponJoin'].forEach(id => { $(id).value = PRIMARY_IDS[0]; });
  ['secondaryWeapon', 'secondaryWeaponHost', 'secondaryWeaponJoin'].forEach(id => { $(id).value = SECONDARY_IDS[0]; });
}

// === Tab 切换 ===
function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      $(`panel-${tab}`).classList.add('active');
    });
  });
}

// === Range 显示 ===
function setupRanges() {
  const pairs = [
    ['botCount', 'botCountVal'],
    ['killLimit', 'killLimitVal'],
    ['killLimitHost', 'killLimitHostVal'],
  ];
  for (const [input, label] of pairs) {
    $(input).addEventListener('input', () => { $(label).textContent = $(input).value; });
  }
}

// === 通用 UI 显示 ===
function showOverlay(el) { el.classList.remove('hidden'); }
function hideOverlay(el) { el.classList.add('hidden'); }
function hideAll() {
  ['menu','loading','pauseMenu','deadScreen','resultScreen'].forEach(id => hideOverlay($(id)));
}

function showLoading(text) {
  $('loadingText').textContent = text || '载入中...';
  showOverlay($('loading'));
}

// === HUD 接线 ===
function bindGameCallbacks(g) {
  g.onHudUpdate = (s) => {
    $('hpFill').style.width = `${(s.hp / s.hpMax) * 100}%`;
    $('hpText').textContent = s.hp;
    if (s.hp < 30) $('hpFill').style.background = 'linear-gradient(90deg, #ff6b6b, #c93a3a)';
    else if (s.hp < 60) $('hpFill').style.background = 'linear-gradient(90deg, #ffd24a, #f5b942)';
    else $('hpFill').style.background = 'linear-gradient(90deg, #4fff7a, #2dc96a)';
    $('weaponName').textContent = s.weaponName;
    $('ammoMag').textContent = s.reloading ? '...' : s.mag;
    $('ammoReserve').textContent = s.reserve;
    $('weaponSide').textContent = s.weaponSide;
    $('weaponSide').className = `side-tag ${s.weaponSide}`;
    $('scoreA').textContent = s.scoreA;
    $('scoreB').textContent = s.scoreB;
  };
  g.onKill = (info) => {
    const feed = $('killFeed');
    const item = document.createElement('div');
    item.className = 'kill-item';
    const isMe = info.attacker === 'player';
    item.innerHTML = `<span class="${isMe ? 'me' : ''}">${info.attacker === 'player' ? '你' : info.attacker}</span> 击杀 <span class="victim">${info.victim || '敌人'}</span>${info.headShot ? ' 💥爆头' : ''}`;
    feed.appendChild(item);
    setTimeout(() => item.remove(), 4000);
  };
  g.onDeath = (info) => {
    showOverlay($('deadScreen'));
    $('deadBy').textContent = info.by === 'remote' ? '被远程玩家击杀' : (info.by === 'bot' ? '被人机击杀' : '阵亡');
    let t = 3;
    $('respawnBtn').textContent = `复活 (${t})`;
    const iv = setInterval(() => {
      t--;
      $('respawnBtn').textContent = `复活 (${t})`;
      if (t <= 0) { clearInterval(iv); $('respawnBtn').textContent = '复活'; }
    }, 1000);
  };
  g.onTakeDamage = () => {
    const f = $('hitFlash');
    f.classList.add('flash');
    setTimeout(() => f.classList.remove('flash'), 150);
  };
  g.onHit = (info) => {
    // 简易:命中marker已在game画粒子
  };
  g.onPause = () => {
    showOverlay($('pauseMenu'));
  };
  g.onResume = () => {
    hideOverlay($('pauseMenu'));
  };
  g.onGameEnd = (winner, kills) => {
    showOverlay($('resultScreen'));
    const isWin = winner === 'A';
    $('resultTitle').textContent = isWin ? '胜利!' : '失败';
    $('resultTitle').className = isWin ? 'victory' : 'defeat';
    let k = 0, d = 0;
    if (game.player) { k = game.player.kills; d = game.player.deaths; }
    $('resultStats').innerHTML = `
      比分 A vs B: <b>${kills.A} - ${kills.B}</b><br/>
      你的击杀: <b>${k}</b> · 阵亡: <b>${d}</b> · K/D: <b>${d === 0 ? k.toFixed(2) : (k/d).toFixed(2)}</b>
    `;
  };
  g.onNetStatus = (msg) => {
    const el = $('netStatus');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 3000);
  };
}

// === 开始单人 ===
async function startSingle() {
  hideAll();
  showLoading('正在部署战场...');
  await new Promise(r => setTimeout(r, 200));
  const opts = {
    mode: 'single',
    primaryId: $('primaryWeapon').value,
    secondaryId: $('secondaryWeapon').value,
    difficulty: $('difficulty').value,
    botCount: parseInt($('botCount').value),
    killGoal: parseInt($('killLimit').value),
    isHost: false,
  };
  game = new Game(canvas);
  bindGameCallbacks(game);
  showHUD();
  game.start(opts);
  hideOverlay($('loading'));
}

// === 创建房间(房主) ===
async function startHost() {
  hideAll();
  showLoading('正在创建房间...');
  netManager = new NetManager();
  try {
    const code = await netManager.hostRoom();
    // 显示房间信息
    $('roomCode').textContent = code;
    const url = `${location.origin}${location.pathname}?room=${code}`;
    $('shareLink').value = url;
    showOverlay($('menu'));
    $('roomInfo').classList.remove('hidden');
    $('hostHint').textContent = '等待好友加入... 当好友加入后会自动开始。';

    // 装备
    const opts = {
      mode: 'host',
      primaryId: $('primaryWeaponHost').value,
      secondaryId: $('secondaryWeaponHost').value,
      killGoal: parseInt($('killLimitHost').value),
      isHost: true,
      netManager,
    };

    netManager.onPeerJoin = () => {
      // 对方已加入,直接开始
      $('hostHint').textContent = '对手已加入,战斗开始!';
      setTimeout(() => {
        hideAll();
        showLoading('正在部署战场...');
        setTimeout(() => {
          game = new Game(canvas);
          bindGameCallbacks(game);
          showHUD();
          game.start(opts);
          hideOverlay($('loading'));
        }, 100);
      }, 500);
    };
    netManager.onError = (err) => {
      $('hostHint').textContent = '错误: ' + (err.message || err.type || JSON.stringify(err));
    };
  } catch (e) {
    showOverlay($('menu'));
    $('hostHint').textContent = '创建失败: ' + (e.message || e);
  }
}

// === 加入房间 ===
async function startJoin() {
  const code = $('joinCode').value.trim().toUpperCase();
  if (code.length < 6) {
    $('joinHint').textContent = '请输入 6 位房间码';
    return;
  }
  hideAll();
  showLoading('正在连接房间...');
  netManager = new NetManager();
  try {
    await netManager.joinRoom(code);
    hideOverlay($('loading'));
    showHUD();
    const opts = {
      mode: 'join',
      primaryId: $('primaryWeaponJoin').value,
      secondaryId: $('secondaryWeaponJoin').value,
      isHost: false,
      netManager,
      spawn: { x: 22, y: 0, z: 18 },
    };
    game = new Game(canvas);
    bindGameCallbacks(game);
    game.start(opts);
  } catch (e) {
    showOverlay($('menu'));
    $('joinHint').textContent = '加入失败: ' + (e.message || e);
    netManager.close();
    netManager = null;
  }
}

function showHUD() { $('hud').classList.remove('hidden'); }
function hideHUD() { $('hud').classList.add('hidden'); }

// === 暂停/继续 ===
function setupPause() {
  $('resumeBtn').addEventListener('click', () => { if (game) game.resume(); });
  $('quitBtn').addEventListener('click', () => {
    if (game) { game.quit(); game = null; }
    hideAll(); hideHUD();
    showOverlay($('menu'));
  });
  $('respawnBtn').addEventListener('click', () => {
    hideOverlay($('deadScreen'));
    // 玩家自动复活由game控制
  });
  $('rematchBtn').addEventListener('click', () => {
    hideAll();
    if (game) { game.quit(); game = null; }
    showOverlay($('menu'));
  });
  $('toMenuBtn').addEventListener('click', () => {
    hideAll(); hideHUD();
    if (game) { game.quit(); game = null; }
    showOverlay($('menu'));
  });
}

// === 复制链接 ===
function setupCopy() {
  $('copyLink').addEventListener('click', () => {
    const input = $('shareLink');
    input.select();
    try {
      document.execCommand('copy');
      $('copyLink').textContent = '已复制!';
      setTimeout(() => $('copyLink').textContent = '复制链接', 1500);
    } catch(e) {}
  });
}

// === 入口 ===
function init() {
  fillWeaponSelects();
  setupTabs();
  setupRanges();
  setupPause();
  setupCopy();

  $('startSingle').addEventListener('click', startSingle);
  $('startHost').addEventListener('click', startHost);
  $('startJoin').addEventListener('click', startJoin);

  // URL 参数自动跳到加入页
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    // 自动切换到加入 tab 并填入
    document.querySelector('.tab[data-tab="join"]').click();
    $('joinCode').value = room.toUpperCase();
  }
}

init();
