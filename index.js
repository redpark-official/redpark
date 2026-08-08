const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Load .env (Node doesn't auto-load it like Vite does)
try { require('fs').readFileSync('.env','utf8').split('\n').forEach(l=>{const m=l.match(/^([A-Z_]+)=(.*)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2];}); } catch(e){}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const sessions = {};
const players = {};
const userCache = {};

function hash(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function genToken() { return crypto.randomBytes(16).toString('hex'); }
function getUsername(token) { return sessions[token] || null; }
function getSocketIdByUsername(username) {
  for (const [sid, p] of Object.entries(players)) if (p.username === username) return sid;
  return null;
}

async function loadUser(username) {
  if (userCache[username]) return userCache[username];
  const { data, error } = await supabase.from('players').select('*').eq('username', username).maybeSingle();
  if (error || !data) return null;
  data.friends = data.friends || [];
  data.friendRequests = data.friend_requests || [];
  userCache[username] = data;
  return data;
}

async function saveUser(username, patch) {
  const { error } = await supabase.from('players').update(patch).eq('username', username);
  if (error) console.error('saveUser error', username, error.message);
  if (userCache[username]) Object.assign(userCache[username], patch);
}

async function ensureAdminSeed() {
  const { data } = await supabase.from('players').select('*').eq('username', 'zlati').maybeSingle();
  if (!data) {
    await supabase.from('players').insert({
      username: 'zlati', password_hash: hash('changeme'), color: '#4ade80', admin: true,
    });
  }
}
ensureAdminSeed().catch(e => console.error('seed admin failed', e.message));

let chatLocked = false;
let nowPlaying = null; // { videoId, url, title, startedAt, startedBy }
let jumbotronSpawned = false;
let weatherState = 'clear'; // 'clear' | 'rain' | 'snow'
let globalLinkButton = null; // { label, url }
let djBoothSpawned = false;
const costumeCatalog = [
  { id: 'robot', name: 'Robot', price: 150 },
  { id: 'ninja', name: 'Ninja', price: 150 },
  { id: 'astronaut', name: 'Astronaut', price: 200 },
];
const releasedCostumes = new Set();
let maintenance = { active: false, endsAt: null };
setInterval(() => {
  if (maintenance.active && Date.now() >= maintenance.endsAt) {
    maintenance = { active: false, endsAt: null };
    io.emit('maintenance_state', { active: false, endsAt: null });
  }
}, 5000);
function isMaintenanceActive() { return maintenance.active && Date.now() < maintenance.endsAt; }

app.set('trust proxy', true);
function getClientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}
const bannedIps = new Set();
async function loadBannedIps() {
  try {
    const { data, error } = await supabase.from('banned_ips').select('ip');
    if (error) { console.error('Could not load banned_ips (table may not exist yet):', error.message); return; }
    (data || []).forEach(row => bannedIps.add(row.ip));
  } catch (e) { console.error('loadBannedIps failed', e.message); }
}
loadBannedIps();
let tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);
  if (bannedIps.has(clientIp)) {
    socket.emit('kick', 'You are banned from this server.');
    socket.disconnect(true);
    return;
  }

  socket.on('token_login', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!username || !user) return socket.emit('token_invalid');
    if (user.banned) return socket.emit('token_invalid');
    socket.emit('auth_ok', { token, username, color: user.color, admin: user.admin, mod: !!user.mod, displayName: user.display_name || username });
  });

  socket.on('register', async ({ username, password, ref }) => {
    username = username.trim().toLowerCase();
    if (!username || !password) return socket.emit('auth_error', 'Fill all fields');
    if (username.length < 3) return socket.emit('auth_error', 'Username too short');
    const { data: existing } = await supabase.from('players').select('username').eq('username', username).maybeSingle();
    if (existing) return socket.emit('auth_error', 'Username taken');
    const colors = ['#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa','#facc15','#38bdf8','#f87171','#4ade80','#e879f9'];
    const color = colors[Math.floor(Math.random()*colors.length)];
    let referrer = null;
    ref = (ref || '').trim().toLowerCase();
    if (ref && ref !== username) referrer = await loadUser(ref);
    const { data, error } = await supabase.from('players').insert({
      username, password_hash: hash(password), color, coins: referrer ? 25 : 0,
    }).select('*').maybeSingle();
    if (error) return socket.emit('auth_error', 'Could not create account');
    data.friends = []; data.friendRequests = [];
    userCache[username] = data;
    const token = genToken(); sessions[token] = username;
    socket.emit('auth_ok', { token, username, color: data.color, admin: false, mod: false });
    if (referrer) {
      const refCoins = (referrer.coins || 0) + 25;
      await saveUser(ref, { coins: refCoins });
      const refSid = getSocketIdByUsername(ref);
      if (refSid) { io.to(refSid).emit('coins', { coins: refCoins }); io.to(refSid).emit('admin_success', username + ' joined using your referral link! +25 coins'); }
    }
  });

  socket.on('login', async ({ username, password }) => {
    username = username.trim().toLowerCase();
    const user = await loadUser(username);
    if (!user) return socket.emit('auth_error', 'User not found');
    if (user.password_hash !== hash(password)) return socket.emit('auth_error', 'Wrong password');
    if (user.banned) return socket.emit('auth_error', 'You are banned');
    const token = genToken(); sessions[token] = username;
    socket.emit('auth_ok', { token, username, color: user.color, admin: user.admin, mod: !!user.mod, displayName: user.display_name || username });
  });

  socket.on('join_world', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!username || !user) return socket.emit('kick', 'Not authenticated');
    if (user.banned) return socket.emit('kick', 'You are banned');
    if (isMaintenanceActive() && username !== 'zlati') {
      return socket.emit('maintenance_block', { endsAt: maintenance.endsAt });
    }
    socket.data.username = username;
    const ip = getClientIp(socket);
    players[socket.id] = { username, x: (Math.random()-0.5)*30, y: 0, z: (Math.random()-0.5)*30, rotY: 0, color: user.color, room: 'public', displayName: user.display_name || username, ip, costume: user.equipped_costume || null };
    saveUser(username, { last_ip: ip }).catch(() => {}); // best-effort; ignored if the column doesn't exist yet
    socket.join('public');
    socket.emit('world_state', { players: Object.entries(players).filter(([id, p]) => id !== socket.id && p.room === 'public').map(([id, p]) => ({ id, ...p })) });
    socket.to('public').emit('player_joined', { id: socket.id, ...players[socket.id] });
    socket.emit('friend_data', { friends: user.friends, requests: user.friendRequests });
    socket.emit('account_status', { mod: !!user.mod, muted: !!user.muted, admin: !!user.admin });
    socket.emit('tag_state', tagState);
    socket.emit('coins', { coins: user.coins || 0 });
    socket.emit('chat_lock', { locked: chatLocked });
    if (nowPlaying) socket.emit('youtube_play', nowPlaying);
    socket.emit('jumbotron_state', { spawned: jumbotronSpawned });
    socket.emit('weather_state', { weather: weatherState });
    socket.emit('link_button_state', { button: globalLinkButton });
    socket.emit('dj_state', { spawned: djBoothSpawned });
    socket.emit('costumes_catalog', { catalog: costumeCatalog, released: Array.from(releasedCostumes) });
    socket.emit('my_costumes', { owned: user.costumes || [], equipped: user.equipped_costume || null });
    socket.emit('maintenance_state', { active: maintenance.active, endsAt: maintenance.endsAt });
  });

  socket.on('move', ({ x, y, z, rotY, anim }) => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id], { x, y, z, rotY, anim });
    socket.to(players[socket.id].room).emit('player_moved', { id: socket.id, x, y, z, rotY, anim });
  });

  socket.on('voice_offer', ({ to, sdp }) => { if (players[to]) io.to(to).emit('voice_offer', { from: socket.id, sdp }); });
  socket.on('voice_answer', ({ to, sdp }) => { if (players[to]) io.to(to).emit('voice_answer', { from: socket.id, sdp }); });
  socket.on('voice_ice', ({ to, candidate }) => { if (players[to]) io.to(to).emit('voice_ice', { from: socket.id, candidate }); });

  socket.on('chat', async ({ token, message }) => {
    const username = getUsername(token);
    if (!username || !message || message.length > 200) return;
    const user = await loadUser(username);
    if (!user) return;
    if (user.muted) return socket.emit('chat_blocked', 'You are muted and cannot send messages.');
    if (chatLocked && !user.admin && !user.mod) return socket.emit('chat_blocked', 'Chat is currently locked by an admin.');
    const chatRoom = players[socket.id] ? players[socket.id].room : 'public';
    const dispName = players[socket.id] ? players[socket.id].displayName : username;
    io.to(chatRoom).emit('chat_msg', { username, displayName: dispName, message, color: user.color, admin: user.admin, mod: !!user.mod, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  });

  socket.on('set_display_name', async ({ token, name }) => {
    const username = getUsername(token); if (!username) return;
    name = (name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 20) return socket.emit('name_error', 'Name must be 2-20 characters');
    if (!/^[a-zA-Z0-9 _\-]+$/.test(name)) return socket.emit('name_error', 'Only letters, numbers, spaces, - and _ allowed');
    try {
      const { error } = await supabase.from('players').update({ display_name: name }).eq('username', username);
      if (error) return socket.emit('name_error', 'DB error: ' + error.message + ' — run: ALTER TABLE players ADD COLUMN IF NOT EXISTS display_name TEXT;');
    } catch (e) { return socket.emit('name_error', 'Could not save name'); }
    if (userCache[username]) userCache[username].display_name = name;
    if (players[socket.id]) {
      players[socket.id].displayName = name;
      socket.to(players[socket.id].room).emit('player_display_name', { id: socket.id, username, displayName: name });
    }
    socket.emit('name_saved', { displayName: name });
  });

  socket.on('friend_request', async ({ token, toUsername }) => {
    const from = getUsername(token); toUsername = toUsername.trim().toLowerCase();
    if (!from) return;
    const target = await loadUser(toUsername);
    if (!target) return socket.emit('friend_error', 'User not found');
    if (toUsername === from) return socket.emit('friend_error', "Can't add yourself");
    if ((target.friends || []).includes(from)) return socket.emit('friend_error', 'Already friends');
    if ((target.friendRequests || []).includes(from)) return socket.emit('friend_error', 'Request already sent');
    target.friendRequests = [...(target.friendRequests || []), from];
    await saveUser(toUsername, { friend_requests: target.friendRequests });
    socket.emit('friend_sent', toUsername);
    const sid = getSocketIdByUsername(toUsername); if (sid) io.to(sid).emit('friend_request_received', { from });
  });

  socket.on('friend_accept', async ({ token, fromUsername }) => {
    const username = getUsername(token); fromUsername = fromUsername.trim().toLowerCase();
    const user = await loadUser(username);
    if (!user || !(user.friendRequests || []).includes(fromUsername)) return;
    user.friendRequests = (user.friendRequests || []).filter(u => u !== fromUsername);
    if (!user.friends.includes(fromUsername)) user.friends.push(fromUsername);
    await saveUser(username, { friends: user.friends, friend_requests: user.friendRequests });
    const friend = await loadUser(fromUsername);
    if (friend && !(friend.friends || []).includes(username)) {
      friend.friends = [...(friend.friends || []), username];
      await saveUser(fromUsername, { friends: friend.friends });
    }
    socket.emit('friend_data', { friends: user.friends, requests: user.friendRequests });
    const sid = getSocketIdByUsername(fromUsername); if (sid) io.to(sid).emit('friend_accepted', { by: username });
  });

  socket.on('friend_decline', async ({ token, fromUsername }) => {
    const username = getUsername(token); const user = await loadUser(username);
    if (!user) return;
    user.friendRequests = (user.friendRequests || []).filter(u => u !== fromUsername);
    await saveUser(username, { friend_requests: user.friendRequests });
    socket.emit('friend_data', { friends: user.friends, requests: user.friendRequests });
  });

  socket.on('friend_remove', async ({ token, friendUsername }) => {
    const username = getUsername(token); if (!username) return;
    const user = await loadUser(username);
    if (!user) return;
    user.friends = (user.friends || []).filter(u => u !== friendUsername);
    await saveUser(username, { friends: user.friends });
    const friend = await loadUser(friendUsername);
    if (friend) {
      friend.friends = (friend.friends || []).filter(u => u !== username);
      await saveUser(friendUsername, { friends: friend.friends });
    }
    socket.emit('friend_data', { friends: user.friends, requests: user.friendRequests });
  });

  socket.on('visit_request', async ({ token, toUsername }) => {
    const from = getUsername(token); toUsername = toUsername.trim().toLowerCase();
    if (!from) return;
    const target = await loadUser(toUsername);
    if (!target) return socket.emit('visit_error', 'User not found');
    const targetSid = getSocketIdByUsername(toUsername);
    if (!targetSid) return socket.emit('visit_error', 'Player is not online');
    io.to(targetSid).emit('visit_request_received', { fromUsername: from });
    io.to(targetSid).emit('visit_guest_arriving', { fromUsername: from });
    socket.emit('visit_sent', toUsername);
  });

  socket.on('visit_accept', async ({ token, fromUsername }) => {
    const username = getUsername(token); fromUsername = fromUsername.trim().toLowerCase();
    const host = players[socket.id];
    if (!host) return;
    const guestSid = getSocketIdByUsername(fromUsername);
    if (!guestSid) return socket.emit('visit_error', 'Player is no longer online');
    io.to(guestSid).emit('visit_teleport', { x: host.x, y: host.y, z: host.z, toUsername: username });
  });

  socket.on('visit_decline', ({ token, fromUsername }) => {
    const username = getUsername(token); fromUsername = fromUsername.trim().toLowerCase();
    const guestSid = getSocketIdByUsername(fromUsername);
    if (guestSid) io.to(guestSid).emit('visit_declined', { by: username });
  });

  socket.on('admin_action', async ({ token, action, targetUsername, reason, label, url }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || (!user.admin && !user.mod)) return socket.emit('admin_error', 'Not authorized');

    // ---- Global actions (no targetUsername needed) ----
    if (action === 'broadcast') {
      if (!user.admin && !user.mod) return socket.emit('admin_error', 'Not authorized');
      io.emit('broadcast', { by: username, message: reason });
      io.emit('chat_msg', { username: '[BROADCAST]', color: '#f87171', admin: true, mod: false, message: reason });
      return socket.emit('admin_success', 'Broadcast sent');
    }
    if (action === 'kickall') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      for (const [sid, p] of Object.entries(players)) {
        if (p.username !== username) io.to(sid).emit('kick', 'Kicked by admin.');
      }
      return socket.emit('admin_success', 'All players kicked');
    }
    if (action === 'muteall') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      for (const [sid, p] of Object.entries(players)) {
        if (p.username !== username) { await saveUser(p.username, { muted: true }); io.to(sid).emit('you_muted', true); }
      }
      return socket.emit('admin_success', 'All players muted');
    }
    if (action === 'unmuteall') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      for (const [sid, p] of Object.entries(players)) {
        await saveUser(p.username, { muted: false }); io.to(sid).emit('you_muted', false);
      }
      return socket.emit('admin_success', 'All players unmuted');
    }
    if (action === 'nightmode') {
      io.emit('force_time', { t: 0.75 }); return socket.emit('admin_success', 'Night mode set');
    }
    if (action === 'daymode') {
      io.emit('force_time', { t: 0.25 }); return socket.emit('admin_success', 'Day mode set');
    }
    if (action === 'jumbotron_toggle') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      jumbotronSpawned = !jumbotronSpawned;
      io.emit('jumbotron_state', { spawned: jumbotronSpawned });
      return socket.emit('admin_success', jumbotronSpawned ? 'Jumbotron spawned at the Public Park' : 'Jumbotron removed');
    }
    if (action === 'set_maintenance') {
      if (username !== 'zlati') return socket.emit('admin_error', 'Only the park owner can set maintenance mode');
      const minutes = parseFloat(reason);
      if (!Number.isFinite(minutes) || minutes <= 0) return socket.emit('admin_error', 'Enter a valid number of minutes');
      maintenance = { active: true, endsAt: Date.now() + minutes * 60000 };
      io.emit('maintenance_state', { active: true, endsAt: maintenance.endsAt });
      return socket.emit('admin_success', 'Maintenance mode on for ' + minutes + ' minutes. Only you can play.');
    }
    if (action === 'clear_maintenance') {
      if (username !== 'zlati') return socket.emit('admin_error', 'Only the park owner can clear maintenance mode');
      maintenance = { active: false, endsAt: null };
      io.emit('maintenance_state', { active: false, endsAt: null });
      return socket.emit('admin_success', 'Maintenance mode cleared');
    }
    if (action === 'clear_chat') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      io.emit('chat_clear');
      return socket.emit('admin_success', 'Chat cleared for everyone');
    }
    if (action === 'weather_rain' || action === 'weather_snow' || action === 'weather_clear') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      weatherState = action === 'weather_rain' ? 'rain' : action === 'weather_snow' ? 'snow' : 'clear';
      io.emit('weather_state', { weather: weatherState });
      return socket.emit('admin_success', 'Weather set to ' + weatherState);
    }
    if (action === 'reset_world') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };
      nowPlaying = null;
      jumbotronSpawned = false;
      weatherState = 'clear';
      chatLocked = false;
      io.emit('tag_ended', { reason: 'World reset by admin', lastIt: null });
      io.emit('youtube_stop');
      io.emit('jumbotron_state', { spawned: false });
      io.emit('weather_state', { weather: 'clear' });
      io.emit('chat_lock', { locked: false });
      io.emit('chat_clear');
      io.emit('force_time', { t: 0.25 });
      return socket.emit('admin_success', 'World reset: chat cleared, music/jumbotron stopped, weather cleared, day set');
    }
    if (action === 'set_link_button') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      const lbl = (label || '').trim().slice(0, 24);
      const u = (url || '').trim();
      if (!lbl || !/^https?:\/\//i.test(u)) return socket.emit('admin_error', 'Need a label and a valid http(s) URL');
      globalLinkButton = { label: lbl, url: u };
      io.emit('link_button_state', { button: globalLinkButton });
      return socket.emit('admin_success', 'Link button set: "' + lbl + '"');
    }
    if (action === 'remove_link_button') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      globalLinkButton = null;
      io.emit('link_button_state', { button: null });
      return socket.emit('admin_success', 'Link button removed');
    }
    if (action === 'release_costume' || action === 'unrelease_costume') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      const cid = label;
      if (!costumeCatalog.find(c => c.id === cid)) return socket.emit('admin_error', 'Unknown costume');
      if (action === 'release_costume') releasedCostumes.add(cid); else releasedCostumes.delete(cid);
      io.emit('costumes_catalog', { catalog: costumeCatalog, released: Array.from(releasedCostumes) });
      return socket.emit('admin_success', (action === 'release_costume' ? 'Released ' : 'Unreleased ') + cid);
    }
    if (action === 'lockchat') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      chatLocked = true; io.emit('chat_lock', { locked: true });
      return socket.emit('admin_success', 'Chat locked');
    }
    if (action === 'unlockchat') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      chatLocked = false; io.emit('chat_lock', { locked: false });
      return socket.emit('admin_success', 'Chat unlocked');
    }
    if (action === 'teleportall') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      io.emit('admin_teleport_all', { to: username });
      return socket.emit('admin_success', 'Teleported everyone to you');
    }
    if (action === 'set_coins') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      if (!targetUsername) return socket.emit('admin_error', 'No target specified');
      const amount = parseInt(reason, 10);
      if (!Number.isFinite(amount) || amount < 0) return socket.emit('admin_error', 'Enter a valid coin amount');
      const targetUser = await loadUser(targetUsername);
      if (!targetUser) return socket.emit('admin_error', 'User not found');
      await saveUser(targetUsername, { coins: amount });
      const sid = getSocketIdByUsername(targetUsername);
      if (sid) { io.to(sid).emit('coins', { coins: amount }); io.to(sid).emit('admin_success', 'Your coins were set to ' + amount); }
      return socket.emit('admin_success', 'Set ' + targetUsername + "'s coins to " + amount);
    }
    if (action === 'give_coins') {
      if (!user.admin && !user.mod) return socket.emit('admin_error', 'Not authorized');
      if (!targetUsername) return socket.emit('admin_error', 'No target specified');
      const amount = parseInt(reason, 10);
      if (!Number.isFinite(amount) || amount === 0) return socket.emit('admin_error', 'Enter a valid coin amount');
      const targetUser = await loadUser(targetUsername);
      if (!targetUser) return socket.emit('admin_error', 'User not found');
      const coins = Math.max(0, (targetUser.coins || 0) + amount);
      await saveUser(targetUsername, { coins });
      const sid = getSocketIdByUsername(targetUsername);
      if (sid) { io.to(sid).emit('coins', { coins }); io.to(sid).emit('admin_success', (amount > 0 ? 'You received ' : 'You lost ') + Math.abs(amount) + ' coins'); }
      return socket.emit('admin_success', 'Gave ' + amount + ' coins to ' + targetUsername);
    }

    // ---- Target-based actions ----
    if (!targetUsername) return socket.emit('admin_error', 'No target specified');
    targetUsername = targetUsername.trim().toLowerCase();
    if (targetUsername === 'zlati') return socket.emit('admin_error', "Can't target owner");
    const target = await loadUser(targetUsername);
    if (!target) return socket.emit('admin_error', 'User not found');

    if (action === 'ban') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can ban');
      await saveUser(targetUsername, { banned: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('kick', 'Banned by admin.');
    } else if (action === 'unban') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can unban');
      await saveUser(targetUsername, { banned: false });
    } else if (action === 'ip_ban') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can IP-ban');
      const sid = getSocketIdByUsername(targetUsername);
      const ip = (sid && players[sid] && players[sid].ip) || target.last_ip;
      if (!ip) return socket.emit('admin_error', "Couldn't determine this user's IP (they may have never connected since IP tracking was added)");
      bannedIps.add(ip);
      try {
        const { error } = await supabase.from('banned_ips').insert({ ip, banned_by: username, reason: reason || null });
        if (error) console.error('Could not persist IP ban:', error.message);
      } catch (e) { console.error('ip_ban insert failed', e.message); }
      if (sid) io.to(sid).emit('kick', 'You have been IP-banned.');
      await supabase.from('players').delete().eq('username', targetUsername);
      delete userCache[targetUsername];
      return socket.emit('admin_success', targetUsername + ' was IP-banned and deleted. IP ' + ip + ' can no longer connect.');
    } else if (action === 'set_display_name') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can rename players');
      const newName = (reason || '').trim().replace(/\s+/g, ' ');
      if (newName.length < 2 || newName.length > 20) return socket.emit('admin_error', 'Name must be 2-20 characters');
      const { error: renameErr } = await supabase.from('players').update({ display_name: newName }).eq('username', targetUsername);
      if (renameErr) return socket.emit('admin_error', 'DB error: ' + renameErr.message + ' — run: ALTER TABLE players ADD COLUMN IF NOT EXISTS display_name TEXT;');
      if (userCache[targetUsername]) userCache[targetUsername].display_name = newName;
      const sid = getSocketIdByUsername(targetUsername);
      if (sid && players[sid]) {
        players[sid].displayName = newName;
        io.to(sid).emit('name_saved', { displayName: newName });
        socket.to(players[sid].room).emit('player_display_name', { id: sid, username: targetUsername, displayName: newName });
      }
      return socket.emit('admin_success', 'Renamed ' + targetUsername + ' to "' + newName + '"');
    } else if (action === 'kick') {
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('kick', 'Kicked by ' + username);
    } else if (action === 'mute') {
      await saveUser(targetUsername, { muted: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('you_muted', true);
    } else if (action === 'unmute') {
      await saveUser(targetUsername, { muted: false });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('you_muted', false);
    } else if (action === 'warn') {
      const warnCount = (target.warnings || 0) + 1;
      await saveUser(targetUsername, { warnings: warnCount });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('you_warned', { by: username, reason: reason || 'No reason given', count: warnCount });
    } else if (action === 'makemod') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can promote mods');
      await saveUser(targetUsername, { mod: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('account_status', { mod: true, admin: false, muted: target.muted || false });
    } else if (action === 'removemod') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      await saveUser(targetUsername, { mod: false });
    } else if (action === 'makeadmin') {
      if (!user.admin) return socket.emit('admin_error', 'Admin only');
      await saveUser(targetUsername, { admin: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('account_status', { admin: true, mod: true, muted: false });
    } else if (action === 'freeze') {
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('admin_freeze', { target: targetUsername });
    } else if (action === 'unfreeze') {
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('admin_unfreeze', { target: targetUsername });
    } else if (action === 'teleport') {
      // Teleport target to admin's position
      const adminPlayer = Object.values(players).find(p => p.username === username);
      const sid = getSocketIdByUsername(targetUsername);
      if (sid && adminPlayer) io.to(sid).emit('visit_teleport', { x: adminPlayer.x + 2, y: 0, z: adminPlayer.z });
    } else {
      return socket.emit('admin_error', 'Unknown action');
    }
    socket.emit('admin_success', action + ' applied to ' + targetUsername)
  });

  socket.on('admin_list', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || (!user.admin && !user.mod)) return;
    const { data, error } = await supabase.from('players').select('username, admin, mod, banned, muted, warnings');
    if (error || !data) return;
    socket.emit('admin_list', data.map(d => ({
      username: d.username, admin: d.admin, mod: !!d.mod, banned: d.banned, muted: !!d.muted, warnings: d.warnings || 0,
      online: Object.values(players).some(p => p.username === d.username)
    })));
  });

  socket.on('tag_start', async ({ token }) => {
    const username = getUsername(token); if (!username || !players[socket.id]) return;
    const user = await loadUser(username);
    if (!user || !user.admin) return socket.emit('tag_error', 'Only admins can start this game');
    if (players[socket.id].room !== 'public') return socket.emit('tag_error', 'Tag only runs in the Public Park');
    if (tagState.active) return socket.emit('tag_error', 'A game is already running');
    const online = Object.values(players).filter(p => p.room === 'public');
    if (online.length < 2) return socket.emit('tag_error', 'Need at least 2 players to start');
    tagState = { active: true, itUsername: username, participants: [username], msLeft: 120000, lastIt: null };
    io.to('public').emit('tag_state', tagState);
    io.to('public').emit('tag_announce', 'Tag started! ' + username + ' is IT! Run!');
  });

  socket.on('tag_join', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active) return socket.emit('tag_error', 'No game running');
    if (!tagState.participants.includes(username)) tagState.participants.push(username);
    io.to('public').emit('tag_state', tagState);
  });

  socket.on('tag_tag', ({ token, targetUsername }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active || tagState.itUsername !== username) return;
    targetUsername = targetUsername.trim().toLowerCase();
    if (!tagState.participants.includes(targetUsername)) return;
    tagState.lastIt = tagState.itUsername;
    tagState.itUsername = targetUsername;
    tagState.msLeft = Math.max(tagState.msLeft, 30000);
    io.to('public').emit('tag_state', tagState);
    io.to('public').emit('tag_announce', targetUsername + ' is now IT!');
  });

  socket.on('tag_stop', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active) return;
    io.to('public').emit('tag_ended', { reason: 'Game stopped by ' + username, lastIt: tagState.itUsername });
    tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };
  });

  socket.on('dj_toggle', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (username !== 'zlati') return socket.emit('youtube_error', 'Only the park owner can spawn the DJ booth');
    djBoothSpawned = !djBoothSpawned;
    io.emit('dj_state', { spawned: djBoothSpawned });
  });

  socket.on('buy_costume', async ({ token, costumeId }) => {
    const username = getUsername(token); if (!username) return;
    if (!releasedCostumes.has(costumeId)) return socket.emit('costume_error', 'This costume is not available yet');
    const item = costumeCatalog.find(c => c.id === costumeId);
    if (!item) return socket.emit('costume_error', 'Unknown costume');
    const user = await loadUser(username);
    if (!user) return;
    const owned = user.costumes || [];
    if (owned.includes(costumeId)) return socket.emit('costume_error', 'You already own this');
    if ((user.coins || 0) < item.price) return socket.emit('costume_error', "You don't have enough coins");
    const newOwned = owned.concat([costumeId]);
    const newCoins = (user.coins || 0) - item.price;
    const { error } = await supabase.from('players').update({ costumes: newOwned, coins: newCoins }).eq('username', username);
    if (error) return socket.emit('costume_error', 'Could not save — this server needs a costumes column on the players table.');
    if (userCache[username]) { userCache[username].costumes = newOwned; userCache[username].coins = newCoins; }
    socket.emit('coins', { coins: newCoins });
    socket.emit('my_costumes', { owned: newOwned, equipped: user.equipped_costume || null });
    socket.emit('costume_bought', { costumeId });
  });

  socket.on('equip_costume', async ({ token, costumeId }) => {
    const username = getUsername(token); if (!username) return;
    const user = await loadUser(username);
    if (!user) return;
    const owned = user.costumes || [];
    if (costumeId && !owned.includes(costumeId)) return socket.emit('costume_error', "You don't own this costume");
    const { error } = await supabase.from('players').update({ equipped_costume: costumeId || null }).eq('username', username);
    if (error) return socket.emit('costume_error', 'Could not save equip state');
    if (userCache[username]) userCache[username].equipped_costume = costumeId || null;
    if (players[socket.id]) {
      players[socket.id].costume = costumeId || null;
      socket.to(players[socket.id].room).emit('player_costume', { id: socket.id, costume: costumeId || null });
    }
    socket.emit('my_costumes', { owned, equipped: costumeId || null });
  });

  socket.on('play_youtube', async ({ token, url }) => {
    const username = getUsername(token); if (!username) return;
    if (username !== 'zlati') return socket.emit('youtube_error', 'Only the park owner can start music for everyone');
    const m = (url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|v=)([a-zA-Z0-9_-]{11})/);
    if (!m) return socket.emit('youtube_error', "Couldn't find a valid YouTube link");
    nowPlaying = { videoId: m[1], url, startedAt: Date.now(), startedBy: username };
    io.emit('youtube_play', nowPlaying);
    io.emit('chat_msg', { username: '[Music]', displayName: '[Music]', color: '#f472b6', admin: false, mod: false, message: username + ' started a video for everyone', time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  });

  socket.on('stop_youtube', async ({ token }) => {
    const username = getUsername(token); if (!username || !nowPlaying) return;
    if (username !== 'zlati') return socket.emit('youtube_error', 'Only the park owner can control music');
    nowPlaying = null;
    io.emit('youtube_stop');
  });

  socket.on('emote', ({ token, emote }) => {
    const username = getUsername(token); if (!username || !players[socket.id]) return;
    socket.to(players[socket.id].room).emit('emote', { username, emote });
  });

  socket.on('collect', async ({ token, orbId }) => {
    const username = getUsername(token); if (!username) return;
    const user = await loadUser(username);
    if (!user) return;
    const coins = (user.coins || 0) + 1;
    await saveUser(username, { coins });
    const room = players[socket.id] ? players[socket.id].room : 'public';
    io.to(room).emit('collected', { orbId, username });
    socket.emit('coins', { coins });
  });

  socket.on('leaderboard', async () => {
    const { data, error } = await supabase.from('players').select('username, coins').order('coins', { ascending: false }).limit(10);
    if (error || !data) return;
    socket.emit('leaderboard', data.map(d => ({ username: d.username, coins: d.coins || 0 })));
  });

  socket.on('set_color', async ({ token, color }) => {
    const username = getUsername(token); if (!username) return;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return;
    await saveUser(username, { color });
    if (players[socket.id]) players[socket.id].color = color;
    const room = players[socket.id] ? players[socket.id].room : 'public';
    io.to(room).emit('player_color', { username, color });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const username = players[socket.id].username;
      socket.to(players[socket.id].room).emit('player_left', { id: socket.id });
      if (tagState.active) {
        tagState.participants = tagState.participants.filter(u => u !== username);
        if (tagState.itUsername === username) {
          if (tagState.participants.length > 0) {
            tagState.itUsername = tagState.participants[0];
            io.emit('tag_state', tagState);
            io.emit('tag_announce', username + ' left. ' + tagState.itUsername + ' is now IT!');
          } else {
            io.emit('tag_ended', { reason: 'All players left', lastIt: tagState.itUsername });
            tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };
          }
        }
      }
      delete players[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Red Park running on port ${PORT}`));
