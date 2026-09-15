// net.js — PeerJS P2P 联机封装
// 房主权威模型:房主做伤害判定与状态同步

const PEER_ID_PREFIX = 'cf-webgame-'; // 防冲突前缀

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class NetManager {
  constructor() {
    this.peer = null;
    this.conn = null;       // DataConnection
    this.isHost = false;
    this.roomCode = null;
    this.connected = false;
    this.onOpen = null;     // 房间已就绪回调
    this.onPeerJoin = null;  // 对方加入回调
    this.onPeerLeave = null; // 对方离开回调
    this.onMessage = null;   // 收到消息回调(msg) => void
    this.onError = null;
  }

  // 房主:创建房间
  hostRoom() {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.roomCode = randomCode();
      const peerId = PEER_ID_PREFIX + this.roomCode;
      try {
        this.peer = new Peer(peerId, { debug: 1 });
      } catch (e) {
        reject(e); return;
      }

      const onTaken = (err) => {
        // id被占用 → 换一个码重试
        if (err.type === 'unavailable-id') {
          this.peer.destroy();
          this.roomCode = randomCode();
          const newId = PEER_ID_PREFIX + this.roomCode;
          this.peer = new Peer(newId, { debug: 1 });
          this.peer.on('open', onOpen);
          this.peer.on('error', onErr);
          this.peer.on('connection', onConn);
        } else {
          if (this.onError) this.onError(err);
          reject(err);
        }
      };

      const onOpen = (id) => {
        resolve(this.roomCode);
        if (this.onOpen) this.onOpen(this.roomCode);
      };
      const onErr = (err) => {
        if (err.type === 'unavailable-id') {
          onTaken(err);
        } else {
          if (this.onError) this.onError(err);
        }
      };
      const onConn = (conn) => {
        this.conn = conn;
        conn.on('open', () => {
          this.connected = true;
          if (this.onPeerJoin) this.onPeerJoin(conn.peer);
        });
        conn.on('data', (data) => {
          if (this.onMessage) this.onMessage(data);
        });
        conn.on('close', () => {
          this.connected = false;
          if (this.onPeerLeave) this.onPeerLeave();
        });
        conn.on('error', (e) => {
          if (this.onError) this.onError(e);
        });
      };

      this.peer.on('open', onOpen);
      this.peer.on('error', onErr);
      this.peer.on('connection', onConn);
    });
  }

  // 客户端:加入房间
  joinRoom(code) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      this.roomCode = code.toUpperCase();
      const targetId = PEER_ID_PREFIX + this.roomCode;
      try {
        this.peer = new Peer({ debug: 1 });
      } catch (e) {
        reject(e); return;
      }
      let connected = false;

      this.peer.on('open', (myId) => {
        const conn = this.peer.connect(targetId, { reliable: false, metadata: { role: 'client' } });
        this.conn = conn;
        conn.on('open', () => {
          connected = true;
          this.connected = true;
          resolve();
          if (this.onOpen) this.onOpen();
        });
        conn.on('data', (data) => {
          if (this.onMessage) this.onMessage(data);
        });
        conn.on('close', () => {
          this.connected = false;
          if (this.onPeerLeave) this.onPeerLeave();
        });
        conn.on('error', (e) => {
          if (this.onError) this.onError(e);
          if (!connected) reject(e);
        });
      });
      this.peer.on('error', (err) => {
        if (this.onError) this.onError(err);
        if (!connected) reject(err);
      });
      // 超时(15秒)
      setTimeout(() => {
        if (!connected) reject(new Error('连接超时,请检查房间码或网络'));
      }, 15000);
    });
  }

  send(msg) {
    if (this.conn && this.connected) {
      try { this.conn.send(msg); } catch (e) { /* ignore */ }
    }
  }

  // 是否可发送(对方在线)
  get alive() {
    return !!(this.conn && this.connected);
  }

  close() {
    if (this.conn) { try { this.conn.close(); } catch(e){} this.conn = null; }
    if (this.peer) { try { this.peer.destroy(); } catch(e){} this.peer = null; }
    this.connected = false;
  }
}

// 消息类型常量
export const Msg = {
  HELLO:   'hello',    // 客户端→房主: 告知自己的装备
  WELCOME: 'welcome',  // 房主→客户端: 分配team/spawn/初始状态
  INPUT:   'input',     // 客户端→房主: 我的位置/朝向/武器/弹药/换弹状态
  FIRE:    'fire',      // 客户端→房主: 我开火(枪口位+方向+武器id+时间)
  STATE:   'state',     // 房主→客户端: 全局快照(双方位置/HP/弹药/比分)
  HIT:     'hit',       // 房主→客户端: 命中通知(攻击者/受害者/伤害/是否爆头)
  KILL:    'kill',      // 房主→客户端: 击杀通知
  RESPAWN: 'respawn',   // 房主→客户端: 复活
  END:     'end',       // 房主→客户端: 游戏结束
  PING:    'ping',
  PONG:    'pong',
};
