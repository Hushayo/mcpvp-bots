// Multi-bot runner (ONE process). bots.local.yml is the synced copy of bots.yml.
// Java server, offline-mode: plain username, no Microsoft auth. No /login needed.
const fs = require('fs');
const path = require('path');
// Load /home/container/.env when present (Wispbyte exposes env via file, not process env).
try { require('dotenv').config(); } catch {}
const yaml = require('js-yaml');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const MC_HOST = process.env.MC_HOST || '15.235.212.121';
const MC_PORT = parseInt(process.env.MC_PORT || '13247', 10);
// Node assignment: this runner only launches bots whose entry node matches.
// Unset NODE_NAME ("") runs unassigned bots only — wispbyte sets NODE_NAME=wispbyte.
const NODE_NAME = process.env.NODE_NAME || '';
const FILE = path.join(__dirname, 'bots.local.yml');
const POLL_MS = 10_000;
const TICK_MS = 250;

const ATTACK_MS = { 1: 1200, 2: 800, 3: 500, 4: 350, 5: 250 };
const RANGE = { 1: 6, 2: 8, 3: 16, 4: 24, 5: 32 };

// key -> { bot, cfg, wantStop, backoff, timer, lastAttacker, lastHurtAt, lastAttackAt }
const bots = new Map();
let friends = new Set(); // all bot names (lowercase) from file

const log = (name, ...a) => console.log(`[${name}]`, ...a);

function loadFile() {
  try {
    if (!fs.existsSync(FILE)) return { bots: {} };
    const doc = yaml.load(fs.readFileSync(FILE, 'utf8')) || {};
    return { bots: doc.bots || {} };
  } catch (e) {
    console.error('[runner] parse error:', e.message);
    return { bots: {} };
  }
}

function friendsFrom(entries) {
  const s = new Set();
  for (const e of Object.values(entries)) if (e && e.name) s.add(String(e.name).toLowerCase());
  return s;
}

// FancyNPCs spawn PLAYER-type entities: only real tablist players count as enemies.
function isRealPlayer(bot, username) {
  try { return !!bot.players[username]; } catch { return false; }
}

function spawnBot(key, cfg) {
  let st = bots.get(key);
  if (!st) { st = { bot: null, timer: null, backoff: 5000 }; bots.set(key, st); }
  st.cfg = cfg;
  st.wantStop = false;
  if (st.bot) return; // already alive/connecting

  const name = cfg.name;
  log(name, `connect ${MC_HOST}:${MC_PORT}`);
  let bot;
  try {
    bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: name });
  } catch (e) { scheduleReconnect(key, st); return; }
  st.bot = bot;
  bot.loadPlugin(pathfinder);
  bot.on('message', (msg) => { try { log(name, '[chat]', String(msg).slice(0, 160)); } catch {} });

  // 'spawn' fires on login AND every respawn: re-kit + re-warp every time
  // (cooldowns harmlessly reject dup claims; death drops make re-kit mandatory).
  bot.on('spawn', () => {
    st.backoff = 5000; // reset on success
    log(name, 'spawned');
    try {
      const mv = new Movements(bot); // default safe (no parkour)
      try { mv.allowSprinting = false; } catch {} // walk everywhere: sprint looks inhuman on bots
      bot.pathfinder.setMovements(mv);
    } catch {}
    // Claim syntax depends on claim_kit_short_command (fresh installs: true).
    // Send BOTH forms: short `/kit <kit>` and full `/kit claim <kit>` — one
    // always lands, the other errors harmlessly (errors only echo to the bot).
    // mace arena needs BOTH kits: mace (armor) + Mace (weapons).
    const claimKit = () => {
      const c = st.cfg || cfg;
      st.lastClaimAt = Date.now();
      try { bot.chat(`/playerkits2:kit ${c.kit}`); } catch {}
      try { bot.chat(`/playerkits2:kit claim ${c.kit}`); } catch {}
      log(name, `/playerkits2:kit ${c.kit}`);
      if (String(c.arena || '').toLowerCase() === 'mace') {
        try { bot.chat('/playerkits2:kit Mace'); } catch {}
        try { bot.chat('/playerkits2:kit claim Mace'); } catch {}
      }
    };
    st.claimKit = claimKit;
    if (cfg.kit) claimKit();
    setTimeout(() => {
      if (st.bot !== bot || st.wantStop) return;
      // Retry once if the claim raced login and inventory is still empty.
      try {
        const n = bot.inventory.items().length;
        log(name, 'inv: ' + n);
        if (cfg.kit && n === 0) claimKit();
      } catch {}
      if (cfg.warp) { try { bot.chat(`/warp ${cfg.warp}`); log(name, `/warp ${cfg.warp}`); } catch {} }
    }, 2000);
  });

  bot.on('health', () => {
    // hp moved (totem may have just popped): refill offhand NOW, don't wait for the tick
    if (st.totemBusy) return;
    st.totemBusy = true;
    try {
      const off = bot.inventory.slots[45];
      if (!off || off.name !== 'totem_of_undying') {
        const t = bot.inventory.items().find((i) => i && i.name === 'totem_of_undying');
        if (t) bot.equip(t, 'off-hand').catch(() => {});
      }
    } catch {}
    setTimeout(() => { st.totemBusy = false; }, 500);
  });

  bot.on('hurt', () => {    // remember last attacker: nearest non-friend player within 8 blocks
    try {
      let best = null, bd = 8;
      for (const e of Object.values(bot.entities)) {
        if (!e || e.type !== 'player' || !e.username || !e.position) continue;
        if (friends.has(e.username.toLowerCase())) continue;
        if (e.username === name) continue;
        if (!isRealPlayer(bot, e.username)) continue;
        try { const pl = bot.players[e.username]; if (pl && typeof pl.gamemode === 'number' && pl.gamemode !== 0) continue; } catch {}
        const d = e.position.distanceTo(bot.entity.position);
        if (d < bd) { bd = d; best = e.username; }
      }
      if (best) { st.lastAttacker = best; st.lastHurtAt = Date.now(); }
    } catch {}
  });

  const cleanup = () => {
    if (st.bot === bot) st.bot = null;
    try { bot.pathfinder.setGoal(null); } catch {}
  };
  bot.on('end', () => { cleanup(); log(name, 'disconnected'); scheduleReconnect(key, st); });
  bot.on('error', (e) => log(name, 'error:', e && e.message ? e.message : e));
}

function scheduleReconnect(key, st) {
  if (st.wantStop || !st.cfg || st.cfg.enabled === false) return; // disabled/gone: stay offline
  if (st.timer) return;
  const wait = Math.min(st.backoff || 5000, 60000);
  st.backoff = Math.min(wait * 2, 60000);
  st.timer = setTimeout(() => { st.timer = null; spawnBot(key, st.cfg); }, wait);
}

function stopBot(key, st) {
  st.wantStop = true;
  st.cfg = null;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  const b = st.bot;
  st.bot = null;
  st.lastAttacker = null;
  if (b) { try { b.pathfinder.setGoal(null); } catch {} try { b.quit(); } catch {} }
}

function nearestEnemy(bot, selfName, range, lowestHealth, exclude) {
  let best = null, bd = range, bh = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (!e || e.type !== 'player' || !e.username || !e.position) continue;
    if (e.username === selfName || friends.has(e.username.toLowerCase())) continue;
    if (e.isValid === false) continue;
    if (!isRealPlayer(bot, e.username)) continue;
    if (exclude) { try { if (exclude.has(e.username.toLowerCase())) continue; } catch {} }
    try { // ignore creative/spectator: can't hurt them, don't waste swings
      const pl = bot.players[e.username];
      if (pl && typeof pl.gamemode === 'number' && pl.gamemode !== 0) continue;
    } catch {}
    const d = e.position.distanceTo(bot.entity.position);
    if (d > range) continue;
    if (lowestHealth) {
      const h = e.health != null ? e.health : 20;
      if (!best || h < bh || (h === bh && d < bd)) { best = e; bh = h; bd = d; }
    } else if (d < bd) { best = e; bd = d; }
  }
  return best;
}

// Fight loop: one timer for all bots.
const claimedTargets = new Set(); // per-tick target claims so bots spread instead of 4-ganging
setInterval(() => {
  const now = Date.now();
  claimedTargets.clear();
  for (const [key, st] of bots) {
    const bot = st.bot, cfg = st.cfg;
    if (!bot || !cfg || !bot.entity) continue;
    const aggro = Math.min(Math.max(parseInt(cfg.aggression || '3', 10) || 3, 1), 5);
    const mode = String(cfg.mode || 'attack').toLowerCase();
    if (mode === 'noattack') continue;
    if (aggro === 1) {
      // retaliate only: 10s attacker memory (explicit hunt order bypasses this)
      if ((!st.lastAttacker || now - (st.lastHurtAt || 0) > 10_000) && !cfg.target) continue;
    }
    const range = RANGE[aggro];
    // spread: prefer unclaimed players; gang only when everyone's taken
    let target = nearestEnemy(bot, cfg.name, aggro === 1 ? 24 : range, aggro === 4, claimedTargets);
    if (!target) target = nearestEnemy(bot, cfg.name, aggro === 1 ? 24 : range, aggro === 4, null);
    if (!target && aggro === 1 && st.lastAttacker) {
      target = Object.values(bot.entities).find(
        (e) => e && e.type === 'player' && e.username === st.lastAttacker && e.position && isRealPlayer(bot, e.username) &&
          e.position.distanceTo(bot.entity.position) <= 24 &&
          (() => { try { const pl = bot.players[e.username]; return !(pl && typeof pl.gamemode === 'number' && pl.gamemode !== 0); } catch { return true; } })()) || null;
    }
    // explicit hunt order (/bot target): focus that player up to 48 blocks, friends excluded
    try {
      const want = String(cfg.target || '').toLowerCase();
      if (want && mode !== 'noattack') {
        const t = Object.values(bot.entities).find((e) => e && e.type === 'player' && e.username && e.username.toLowerCase() === want && e.position && !friends.has(want) && isRealPlayer(bot, e.username) && e.isValid !== false && e.position.distanceTo(bot.entity.position) <= 48);
        if (t) { target = t; if (!st.focus || st.focus !== t.username) { st.focus = t.username; st.engageAt = now + 300 + Math.random() * 500; } }
      }
    } catch {}
    if (target) { try { claimedTargets.add(target.username.toLowerCase()); } catch {} }
    if (!target) {
      try { if (bot.pathfinder.isMoving()) bot.pathfinder.setGoal(null); } catch {}
      try { bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('left', false); bot.setControlState('right', false); } catch {}
      st.focus = null;
      continue;
    }

    const dist = target.position.distanceTo(bot.entity.position);
    const interval = ATTACK_MS[aggro];
    // engage delay: humans don't insta-react to a new target
    if (!st.focus || st.focus !== target.username) { st.focus = target.username; st.engageAt = now + 300 + Math.random() * 500; }
    // aim with error, throttled (snapping every tick looks robotic)
    if (now - (st.lastAimAt || 0) >= 220 + Math.random() * 250) {
      st.lastAimAt = now;
      try {
        const err = aggro >= 4 ? 0.15 : 0.35;
        bot.lookAt(target.position.offset((Math.random() - 0.5) * err, 1.4 + (Math.random() - 0.5) * err, (Math.random() - 0.5) * err));
      } catch {}
    }
    // strafe overlay in melee. Locomotion belongs to the pathfinder alone:
    // manual forward/sprint fights it and jitters the bot in place.
    try {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      if (dist <= 4.5) {
        if (!st.strafeAt || now >= st.strafeAt) {
          st.strafeAt = now + 800 + Math.random() * 2200;
          const r = Math.random();
          st.strafeDir = r < 0.4 ? 'left' : (r < 0.8 ? 'right' : 'none');
        }
        bot.setControlState('left', st.strafeDir === 'left');
        bot.setControlState('right', st.strafeDir === 'right');
      } else { bot.setControlState('left', false); bot.setControlState('right', false); }
    } catch {}
    // pathfind on a leash: repath at most 1/s, not every tick
    try {
      if ((dist > 3 || aggro === 5) && now - (st.lastGoalAt || 0) >= 1000) {
        st.lastGoalAt = now;
        bot.pathfinder.setGoal(new goals.GoalFollow(target, 1), true);
      }
    } catch {}
    // attack with jitter, engage delay, occasional whiff, half the jump-spam
    const jittered = interval * (0.8 + Math.random() * 0.5);
    // vanilla reach: swing at 3 blocks like a real client (server doesn't enforce, we do)
    if (dist <= 3 && now >= (st.engageAt || 0) && now - (st.lastAttackAt || 0) >= jittered && Math.random() > 0.12) {
      st.lastAttackAt = now;
      if (aggro >= 4 && Math.random() < 0.5) { try { bot.setControlState('jump', true); setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 150); } catch {} }
      try { bot.attack(target); } catch {}
    }
    // ender pearls: chase ONLY (never flee — running from crystals looks trash).
    // Chase at 10-30 blocks (aggro 3+). Max one per 1.5s.
    if (!st.pearling && now - (st.lastPearlAt || 0) >= 1500) {
      const chase = target && aggro >= 3 && dist > 10 && dist < 30;
      if (chase) {
        let pearl = null;
        try { pearl = bot.inventory.items().find((i) => i && i.name === 'ender_pearl'); } catch {}
        if (pearl) {
          st.pearling = true;
          let aim = null;
          try {
            aim = target.position.offset(0, 1.5, 0);
          } catch { aim = null; }
          if (!aim) { st.pearling = false; }
          else {
            bot.equip(pearl, 'hand').then(() => {
              try { bot.lookAt(aim); } catch {}
              try { bot.activateItem(); } catch {}
              log(name, 'pearl chase');
              st.lastPearlAt = Date.now(); st.pearling = false;
              // weapon back in hand, otherwise the bot keeps holding the pearl
              try {
                const w = bot.inventory.items().find((i) => i && /sword|mace|axe/i.test(i.name));
                if (w) bot.equip(w, 'hand').catch(() => {});
              } catch {}
            }).catch(() => { st.pearling = false; });
          }
        }
      }
    }
    // auto-totem: keep one in offhand whenever stocked (checked 2/s + instant on hp change)
    if (now - (st.lastTotemAt || 0) >= 500) {
      st.lastTotemAt = now;
      try {
        const off = bot.inventory.slots[45];
        if (!off || off.name !== 'totem_of_undying') {
          const t = bot.inventory.items().find((i) => i && i.name === 'totem_of_undying');
          if (t) bot.equip(t, 'off-hand').catch(() => {});
        }
      } catch {}
    }
    // naked re-kit: died too fast to claim, or cooldown expired since (alive only, 5/s)
    if (bot.health > 0 && now - (st.lastClaimAt || 0) >= 5000) {
      let n = -1;
      try { n = bot.inventory.items().length; } catch {}
      if (n === 0) { try { st.claimKit && st.claimKit(); } catch {} }
    }
    // auto-sword: always hold the best weapon (claims/pearls leave hands wrong)
    if (!st.pearling && now - (st.lastWeaponAt || 0) >= 1000) {
      st.lastWeaponAt = now;
      try {
        const held = bot.heldItem;
        if (!held || !/sword|mace|_axe|spear|trident/i.test(held.name)) {
          const order = ['_sword', 'mace', '_axe', 'spear', 'trident'];
          let best = null;
          for (const k of order) {
            best = bot.inventory.items().find((i) => i && i.name.includes(k));
            if (best) break;
          }
          if (best) bot.equip(best, 'hand').catch(() => {});
        }
      } catch {}
    }
  }
}, TICK_MS);

function reconcile() {
  const { bots: entries } = loadFile();
  friends = friendsFrom(entries);
  const seen = new Set(Object.keys(entries));
  for (const [key, cfg] of Object.entries(entries)) {
    if (!cfg || !cfg.name) continue;
    // node gate: only run bots assigned to THIS machine ("" = unassigned = local default)
    if (String(cfg.node || '') !== NODE_NAME) {
      const st = bots.get(key);
      if (st) stopBot(key, st);
      continue;
    }
    if (cfg.enabled === false) {
      const st = bots.get(key);
      if (st) { log(cfg.name, 'disabled -> quit'); stopBot(key, st); }
      continue;
    }
    const st = bots.get(key);
    if (!st || (!st.bot && !st.timer)) spawnBot(key, cfg);
    else if (st.cfg && st.cfg.name !== cfg.name) { stopBot(key, st); spawnBot(key, cfg); } // renamed
    else st.cfg = cfg; // live-update aggression/mode/kit/warp
  }
  for (const [key, st] of bots) {
    if (!seen.has(key) || !st.cfg) { stopBot(key, st); bots.delete(key); } // removed -> stay offline
  }
}

reconcile();
setInterval(reconcile, POLL_MS);
console.log(`[runner] watching ${FILE} host=${MC_HOST} port=${MC_PORT} node='${NODE_NAME}'`);
