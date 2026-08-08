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

let tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };

io.on('connection', (socket) => {
  socket.on('token_login', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!username || !user) return socket.emit('token_invalid');
    if (user.banned) return socket.emit('token_invalid');
    socket.emit('auth_ok', { token, username, color: user.color, admin: user.admin, mod: !!user.mod });
  });

  socket.on('register', async ({ username, password }) => {
    username = username.trim().toLowerCase();
    if (!username || !password) return socket.emit('auth_error', 'Fill all fields');
    if (username.length < 3) return socket.emit('auth_error', 'Username too short');
    const { data: existing } = await supabase.from('players').select('username').eq('username', username).maybeSingle();
    if (existing) return socket.emit('auth_error', 'Username taken');
    const colors = ['#60a5fa','#34d399','#f472b6','#fb923c','#a78bfa','#facc15','#38bdf8','#f87171','#4ade80','#e879f9'];
    const color = colors[Math.floor(Math.random()*colors.length)];
    const { data, error } = await supabase.from('players').insert({
      username, password_hash: hash(password), color,
    }).select('*').maybeSingle();
    if (error) return socket.emit('auth_error', 'Could not create account');
    data.friends = []; data.friendRequests = [];
    userCache[username] = data;
    const token = genToken(); sessions[token] = username;
    socket.emit('auth_ok', { token, username, color: data.color, admin: false, mod: false });
  });

  socket.on('login', async ({ username, password }) => {
    username = username.trim().toLowerCase();
    const user = await loadUser(username);
    if (!user) return socket.emit('auth_error', 'User not found');
    if (user.password_hash !== hash(password)) return socket.emit('auth_error', 'Wrong password');
    if (user.banned) return socket.emit('auth_error', 'You are banned');
    const token = genToken(); sessions[token] = username;
    socket.emit('auth_ok', { token, username, color: user.color, admin: user.admin, mod: !!user.mod });
  });

  socket.on('join_world', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!username || !user) return socket.emit('kick', 'Not authenticated');
    if (user.banned) return socket.emit('kick', 'You are banned');
    socket.data.username = username;
    players[socket.id] = { username, x: (Math.random()-0.5)*30, y: 0, z: (Math.random()-0.5)*30, rotY: 0, color: user.color };
    socket.emit('world_state', { players: Object.entries(players).filter(([id]) => id !== socket.id).map(([id, p]) => ({ id, ...p })) });
    socket.broadcast.emit('player_joined', { id: socket.id, ...players[socket.id] });
    socket.emit('friend_data', { friends: user.friends, requests: user.friendRequests });
    socket.emit('account_status', { mod: !!user.mod, muted: !!user.muted, admin: !!user.admin });
    socket.emit('tag_state', tagState);
    socket.emit('coins', { coins: user.coins || 0 });
  });

  socket.on('move', ({ x, y, z, rotY, anim }) => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id], { x, y, z, rotY, anim });
    socket.broadcast.emit('player_moved', { id: socket.id, x, y, z, rotY, anim });
  });

  socket.on('chat', async ({ token, message }) => {
    const username = getUsername(token);
    if (!username || !message || message.length > 200) return;
    const user = await loadUser(username);
    if (!user) return;
    if (user.muted) return socket.emit('chat_blocked', 'You are muted and cannot send messages.');
    io.emit('chat_msg', { username, message, color: user.color, admin: user.admin, mod: !!user.mod, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
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

  socket.on('admin_action', async ({ token, action, targetUsername, reason }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || (!user.admin && !user.mod)) return socket.emit('admin_error', 'Not authorized');
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
    } else if (action === 'kick') {
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('kick', 'Kicked by admin.');
    } else if (action === 'mute') {
      await saveUser(targetUsername, { muted: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) { io.to(sid).emit('you_muted', true); io.to(sid).emit('account_status', { mod: !!target.mod, muted: true, admin: !!target.admin }); }
    } else if (action === 'unmute') {
      await saveUser(targetUsername, { muted: false });
      const sid = getSocketIdByUsername(targetUsername); if (sid) { io.to(sid).emit('you_muted', false); io.to(sid).emit('account_status', { mod: !!target.mod, muted: false, admin: !!target.admin }); }
    } else if (action === 'warn') {
      const warnings = (target.warnings || 0) + 1;
      await saveUser(targetUsername, { warnings });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('you_warned', { by: username, reason: reason || 'No reason given', count: warnings });
    } else if (action === 'makemod') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can assign mods');
      await saveUser(targetUsername, { mod: true });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('account_status', { mod: true, muted: !!target.muted, admin: !!target.admin });
    } else if (action === 'removemod') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can remove mods');
      await saveUser(targetUsername, { mod: false });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('account_status', { mod: false, muted: !!target.muted, admin: !!target.admin });
    } else if (action === 'makeadmin') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can assign admins');
      await saveUser(targetUsername, { admin: true });
    } else if (action === 'removeadmin') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can remove admins');
      await saveUser(targetUsername, { admin: false });
    } else if (action === 'setcoins') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can set coins');
      const amount = parseInt(reason, 10);
      if (isNaN(amount) || amount < 0) return socket.emit('admin_error', 'Invalid coin amount');
      await saveUser(targetUsername, { coins: amount });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('coins', { coins: amount });
    } else if (action === 'addcoins') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can add coins');
      const amount = parseInt(reason, 10);
      if (isNaN(amount)) return socket.emit('admin_error', 'Invalid coin amount');
      const newCoins = (target.coins || 0) + amount;
      await saveUser(targetUsername, { coins: Math.max(0, newCoins) });
      const sid = getSocketIdByUsername(targetUsername); if (sid) io.to(sid).emit('coins', { coins: Math.max(0, newCoins) });
    } else if (action === 'resetwarnings') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can reset warnings');
      await saveUser(targetUsername, { warnings: 0 });
    } else if (action === 'teleportto') {
      const sid = getSocketIdByUsername(targetUsername);
      if (!sid) return socket.emit('admin_error', 'Player is not online');
      const tp = players[sid];
      if (tp) socket.emit('admin_teleport', { x: tp.x, y: tp.y, z: tp.z, toUsername: targetUsername });
    } else if (action === 'bring') {
      const sid = getSocketIdByUsername(targetUsername);
      if (!sid) return socket.emit('admin_error', 'Player is not online');
      const me = players[socket.id];
      if (!me) return socket.emit('admin_error', 'You are not in the world');
      io.to(sid).emit('visit_teleport', { x: me.x, y: me.y, z: me.z, toUsername: username });
    } else if (action === 'deleteaccount') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can delete accounts');
      if (targetUsername === 'zlati') return socket.emit('admin_error', "Can't delete owner");
      const { error: delErr } = await supabase.from('players').delete().eq('username', targetUsername);
      if (delErr) return socket.emit('admin_error', 'Could not delete account');
      const sid = getSocketIdByUsername(targetUsername);
      if (sid) io.to(sid).emit('kick', 'Your account has been deleted by an admin.');
      delete userCache[targetUsername];
    } else if (action === 'resetcolor') {
      if (!user.admin) return socket.emit('admin_error', 'Only admins can reset colors');
      await saveUser(targetUsername, { color: '#4ade80' });
      if (players[socket.id]) {
        const sid = getSocketIdByUsername(targetUsername);
        if (sid && players[sid]) players[sid].color = '#4ade80';
      }
      io.emit('player_color', { username: targetUsername, color: '#4ade80' });
    }
    socket.emit('admin_success', `Done: ${action} on ${targetUsername}`);
  });

  socket.on('admin_list', async ({ token }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || (!user.admin && !user.mod)) return;
    const { data, error } = await supabase.from('players').select('username, admin, mod, banned, muted, warnings, coins, created_at');
    if (error || !data) return;
    socket.emit('admin_list', data.map(d => ({
      username: d.username, admin: d.admin, mod: !!d.mod, banned: d.banned, muted: !!d.muted, warnings: d.warnings || 0,
      coins: d.coins || 0, created_at: d.created_at,
      online: Object.values(players).some(p => p.username === d.username)
    })));
  });

  socket.on('admin_broadcast', async ({ token, message }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || !user.admin) return socket.emit('admin_error', 'Only admins can broadcast');
    if (!message || message.length > 500) return socket.emit('admin_error', 'Invalid message');
    io.emit('admin_announcement', { from: username, message });
    socket.emit('admin_success', 'Broadcast sent');
  });

  socket.on('admin_search', async ({ token, query }) => {
    const username = getUsername(token);
    const user = await loadUser(username);
    if (!user || (!user.admin && !user.mod)) return;
    if (!query || query.length < 1) return;
    const { data, error } = await supabase.from('players')
      .select('username, admin, mod, banned, muted, warnings, coins, created_at')
      .ilike('username', '%' + query + '%')
      .limit(20);
    if (error || !data) return;
    socket.emit('admin_list', data.map(d => ({
      username: d.username, admin: d.admin, mod: !!d.mod, banned: d.banned, muted: !!d.muted, warnings: d.warnings || 0,
      coins: d.coins || 0, created_at: d.created_at,
      online: Object.values(players).some(p => p.username === d.username)
    })));
  });

  socket.on('tag_start', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (tagState.active) return socket.emit('tag_error', 'A game is already running');
    const online = Object.values(players);
    if (online.length < 2) return socket.emit('tag_error', 'Need at least 2 players to start');
    tagState = { active: true, itUsername: username, participants: [username], msLeft: 120000, lastIt: null };
    io.emit('tag_state', tagState);
    io.emit('tag_announce', 'Tag started! ' + username + ' is IT! Run!');
  });

  socket.on('tag_join', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active) return socket.emit('tag_error', 'No game running');
    if (!tagState.participants.includes(username)) tagState.participants.push(username);
    io.emit('tag_state', tagState);
  });

  socket.on('tag_tag', ({ token, targetUsername }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active || tagState.itUsername !== username) return;
    targetUsername = targetUsername.trim().toLowerCase();
    if (!tagState.participants.includes(targetUsername)) return;
    tagState.lastIt = tagState.itUsername;
    tagState.itUsername = targetUsername;
    tagState.msLeft = Math.max(tagState.msLeft, 30000);
    io.emit('tag_state', tagState);
    io.emit('tag_announce', targetUsername + ' is now IT!');
  });

  socket.on('tag_stop', ({ token }) => {
    const username = getUsername(token); if (!username) return;
    if (!tagState.active) return;
    io.emit('tag_ended', { reason: 'Game stopped by ' + username, lastIt: tagState.itUsername });
    tagState = { active: false, itUsername: null, participants: [], msLeft: 0, lastIt: null };
  });

  socket.on('emote', ({ token, emote }) => {
    const username = getUsername(token); if (!username) return;
    socket.broadcast.emit('emote', { username, emote });
  });

  socket.on('collect', async ({ token, orbId }) => {
    const username = getUsername(token); if (!username) return;
    const user = await loadUser(username);
    if (!user) return;
    const coins = (user.coins || 0) + 1;
    await saveUser(username, { coins });
    io.emit('collected', { orbId, username });
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
    io.emit('player_color', { username, color });
  });

  socket.on('disconnect', () => {
    if (players[socket.id]) {
      const username = players[socket.id].username;
      socket.broadcast.emit('player_left', { id: socket.id });
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
