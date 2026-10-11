const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Sequelize, DataTypes } = require('sequelize');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Multer Setup
const upload = multer({ storage: multer.memoryStorage() });

// Database Setup
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './ct20_data.db',
  logging: false
});

// Models
const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true },
  passwordHash: DataTypes.STRING,
  role: { type: DataTypes.STRING, defaultValue: 'viewer' } // 'admin' or 'viewer'
});

const Assembly = sequelize.define('Assembly', {
  assemblyNumber: { type: DataTypes.STRING, primaryKey: true },
  assemblyName: DataTypes.STRING,
  qtyRequired: DataTypes.INTEGER,
  percentComplete: DataTypes.FLOAT,
  status: DataTypes.STRING
});

const JWT_SECRET = 'super-secret-key-change-in-production';

// Initialize DB
async function initDB() {
  await sequelize.sync();
  const count = await User.count();
  if (count === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await User.create({ username: 'admin', passwordHash: hash, role: 'admin' });
    console.log('Default Admin created: admin / admin123');
  }
}

// Middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch { return res.status(401).json({ error: 'Invalid token' }); }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// --- ROUTES ---

// 1. Login Page
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CT20 Login</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f0f2f5; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 350px; text-align: center; }
        h1 { color: #6d4aff; margin-bottom: 1.5rem; font-size: 1.5rem; }
        input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 16px; }
        button { width: 100%; padding: 12px; background: #6d4aff; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; transition: background 0.2s; }
        button:hover { background: #5a42d6; }
        .error { color: #d32f2f; margin-top: 10px; font-size: 14px; display: none; }
        .loader { display: none; color: #666; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🏭 CT20 Tracker</h1>
        <input type="text" id="username" placeholder="Username" autocomplete="off">
        <input type="password" id="password" placeholder="Password">
        <button onclick="handleLogin()">Login</button>
        <div id="error" class="error"></div>
        <div id="loader" class="loader">Logging in...</div>
      </div>
      <script>
        async function handleLogin() {
          const u = document.getElementById('username').value;
          const p = document.getElementById('password').value;
          const err = document.getElementById('error');
          const loader = document.getElementById('loader');
          if(!u || !p) { err.innerText = "Please fill all fields"; err.style.display = 'block'; return; }
          err.style.display = 'none';
          loader.style.display = 'block';
          try {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
            const data = await res.json();
            if (data.token) {
              localStorage.setItem('ct20_token', data.token);
              localStorage.setItem('ct20_role', data.user.role);
              localStorage.setItem('ct20_user', data.user.username);
              window.location.href = '/dashboard';
            } else {
              err.innerText = data.error || "Login failed";
              err.style.display = 'block';
            }
          } catch (e) {
            err.innerText = "Network error.";
            err.style.display = 'block';
          } finally { loader.style.display = 'none'; }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. Main Dashboard (Includes Users Tab for Admins)
app.get('/dashboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CT20 Dashboard</title>
      <script src="/socket.io/socket.io.js"><\/script>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
        h1 { color: #333; margin: 0; font-size: 1.5rem; }
        .nav-btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; background: #eee; color: #333; margin-right: 5px; }
        .nav-btn.active { background: #6d4aff; color: white; }
        .btn-logout { background: #d32f2f; color: white; }
        .btn-upload { background: #4caf50; color: white; }
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #6d4aff; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-val { font-size: 1.5rem; font-weight: bold; color: #333; }
        .stat-label { font-size: 0.85rem; color: #666; }
        .card { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); padding: 20px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #6d4aff; color: white; font-weight: 600; }
        tr:last-child td { border-bottom: none; }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .status-ok { background: #e8f5e9; color: #2e7d32; }
        .status-warn { background: #fff3e0; color: #ef6c00; }
        .status-bad { background: #ffebee; color: #c62828; }
        .progress-bar { width: 100px; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; }
        .progress-fill { height: 100%; background: #6d4aff; }
        .loading { text-align: center; padding: 40px; color: #666; }
        .role-badge { font-size: 12px; background: #eee; padding: 2px 6px; border-radius: 4px; margin-left: 10px; }
        #toast { visibility: hidden; min-width: 250px; margin-left: -125px; background-color: #333; color: #fff; text-align: center; border-radius: 8px; padding: 16px; position: fixed; z-index: 1; left: 50%; bottom: 30px; font-size: 17px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        #toast.show { visibility: visible; animation: fadein 0.5s, fadeout 0.5s 2.5s; }
        @keyframes fadein { from {bottom: 0; opacity: 0;} to {bottom: 30px; opacity: 1;} }
        @keyframes fadeout { from {bottom: 30px; opacity: 1;} to {bottom: 0; opacity: 0;} }
        
        /* User Table Styles */
        .user-row { display: flex; justify-content: space-between; align-items: center; padding: 10px; border-bottom: 1px solid #eee; }
        .user-info { display: flex; flex-direction: column; }
        .user-role { font-size: 12px; color: #666; }
        .delete-btn { background: #ff5252; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>🏭 CT20 Assembly Tracker</h1>
            <span id="user-display" style="font-size: 14px; color: #666;"></span>
            <span id="user-role" class="role-badge"></span>
          </div>
          <div>
            <button class="nav-btn active" onclick="showTab('dashboard')">Dashboard</button>
            <button class="nav-btn" id="users-tab-btn" style="display:none;" onclick="showTab('users')">Users</button>
            <button class="btn btn-logout" onclick="logout()">Logout</button>
          </div>
        </div>

        <!-- DASHBOARD TAB -->
        <div id="dashboard-tab">
          <div class="stat-grid">
            <div class="stat-card"><div class="stat-val" id="total">-</div><div class="stat-label">Total</div></div>
            <div class="stat-card"><div class="stat-val" id="done" style="color: green;">-</div><div class="stat-label">Completed</div></div>
            <div class="stat-card"><div class="stat-val" id="prog" style="color: orange;">-</div><div class="stat-label">In Progress</div></div>
          </div>

          <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
              <h3>Assembly List</h3>
              <label for="excel-upload" class="btn btn-upload" id="upload-btn" style="display:none; cursor: pointer; padding: 8px 16px;">📤 Upload Excel</label>
              <input type="file" id="excel-upload" accept=".xlsx, .xls" style="display: none;" onchange="handleFileUpload(this)">
            </div>
            <div id="content"><div class="loading">Loading data...</div></div>
          </div>
        </div>

        <!-- USERS TAB (Admin Only) -->
        <div id="users-tab" style="display:none;">
          <div class="card">
            <h3>Create New User</h3>
            <div style="display:flex; gap:10px; margin-bottom:20px;">
              <input type="text" id="new-user" placeholder="Username" style="flex:1; padding:10px; border:1px solid #ddd; border-radius:6px;">
              <input type="text" id="new-pass" placeholder="Password" style="flex:1; padding:10px; border:1px solid #ddd; border-radius:6px;">
              <select id="new-role" style="padding:10px; border:1px solid #ddd; border-radius:6px;">
                <option value="viewer">Viewer</option>
                <option value="admin">Admin</option>
              </select>
              <button class="btn" style="background:#6d4aff; color:white;" onclick="createUser()">Add</button>
            </div>
            <h3>Existing Users</h3>
            <div id="user-list">Loading...</div>
          </div>
        </div>
      </div>

      <div id="toast">✨ New data uploaded!</div>

      <script>
        const token = localStorage.getItem('ct20_token');
        const role = localStorage.getItem('ct20_role');
        const username = localStorage.getItem('ct20_user');
        
        if (!token) { window.location.href = '/'; }

        document.getElementById('user-display').innerText = 'Logged in as: ' + username;
        document.getElementById('user-role').innerText = role.toUpperCase();

        // Show Users tab only for Admins
        if (role === 'admin') {
          document.getElementById('users-tab-btn').style.display = 'inline-block';
          document.getElementById('upload-btn').style.display = 'inline-block';
          loadUsers();
        }

        function showTab(tabName) {
          document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
          event.target.classList.add('active');
          if (tabName === 'dashboard') {
            document.getElementById('dashboard-tab').style.display = 'block';
            document.getElementById('users-tab').style.display = 'none';
            loadData();
          } else {
            document.getElementById('dashboard-tab').style.display = 'none';
            document.getElementById('users-tab').style.display = 'block';
            loadUsers();
          }
        }

        // --- DASHBOARD FUNCTIONS ---
        const socket = io();
        socket.on('data_updated', (data) => {
          showToast('✨ New data received! (' + data.count + ' items)');
          loadData();
        });

        function showToast(message) {
          var x = document.getElementById("toast");
          x.innerText = message;
          x.className = "show";
          setTimeout(function(){ x.className = x.className.replace("show", ""); }, 3000);
        }

        async function handleFileUpload(inputElement) {
          const file = inputElement.files[0];
          if (!file) return;
          const formData = new FormData();
          formData.append('file', file);
          const btn = document.getElementById('upload-btn');
          btn.innerText = 'Uploading...';
          btn.disabled = true;
          try {
            const res = await fetch('/api/import', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: formData });
            const data = await res.json();
            if (data.success) {
              alert('Success! Imported ' + data.count + ' assemblies.');
              location.reload();
            } else {
              alert('Error: ' + data.error);
            }
          } catch (e) {
            alert("Network error.");
          } finally {
            btn.innerText = '📤 Upload Excel';
            btn.disabled = false;
            inputElement.value = '';
          }
        }

        async function loadData() {
          try {
            const res = await fetch('/api/assemblies', { headers: { 'Authorization': 'Bearer ' + token } });
            if (res.status === 401) { localStorage.clear(); window.location.href = '/'; return; }
            const data = await res.json();
            document.getElementById('content').innerHTML = '';
            document.getElementById('total').innerText = data.length;
            document.getElementById('done').innerText = data.filter(a => a.percentComplete >= 100).length;
            document.getElementById('prog').innerText = data.filter(a => a.percentComplete > 0 && a.percentComplete < 100).length;
            if (data.length === 0) {
              document.getElementById('content').innerHTML = '<p style="text-align:center; color:#666;">No assemblies found.</p>';
              return;
            }
            let html = '<table><thead><tr><th>Assembly #</th><th>Name</th><th>Qty</th><th>%</th><th>Status</th></tr></thead><tbody>';
            data.forEach(a => {
              let badgeClass = a.percentComplete >= 100 ? 'status-ok' : (a.percentComplete > 0 ? 'status-warn' : 'status-bad');
              let badgeText = a.percentComplete >= 100 ? '✅ Done' : (a.percentComplete > 0 ? '🔄 Working' : '⏳ Pending');
              html += '<tr><td style="font-family: monospace; font-size: 12px;">' + a.assemblyNumber + '</td><td>' + a.assemblyName + '</td><td>' + a.qtyRequired + '</td><td><div class="progress-bar"><div class="progress-fill" style="width: ' + Math.min(a.percentComplete, 100) + '%"></div></div><small>' + a.percentComplete + '%</small></td><td><span class="status-badge ' + badgeClass + '">' + badgeText + '</span></td></tr>';
            });
            html += '</tbody></table>';
            document.getElementById('content').innerHTML = html;
          } catch (err) {
            document.getElementById('content').innerHTML = '<p style="color:red; text-align:center;">Error loading data.</p>';
          }
        }

        // --- USER MANAGEMENT FUNCTIONS ---
        async function loadUsers() {
          try {
            const res = await fetch('/api/users', { headers: { 'Authorization': 'Bearer ' + token } });
            const users = await res.json();
            const list = document.getElementById('user-list');
            if (users.length === 0) {
              list.innerHTML = '<p>No users found.</p>';
              return;
            }
            let html = '';
            users.forEach(u => {
              html += '<div class="user-row"><div class="user-info"><strong>' + u.username + '</strong><span class="user-role">' + u.role + '</span></div>';
              if (u.username !== 'admin') {
                html += '<button class="delete-btn" onclick="deleteUser(\'' + u.username + '\')">Delete</button>';
              } else {
                html += '<span style="color:#aaa; font-size:12px;">(Super Admin)</span>';
              }
              html += '</div>';
            });
            list.innerHTML = html;
          } catch (err) {
            document.getElementById('user-list').innerHTML = '<p style="color:red;">Error loading users.</p>';
          }
        }

        async function createUser() {
          const u = document.getElementById('new-user').value;
          const p = document.getElementById('new-pass').value;
          const r = document.getElementById('new-role').value;
          if (!u || !p) { alert("Please fill username and password"); return; }
          
          try {
            const res = await fetch('/api/users/create', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: p, role: r })
            });
            const data = await res.json();
            if (data.success) {
              alert("User created!");
              document.getElementById('new-user').value = '';
              document.getElementById('new-pass').value = '';
              loadUsers();
            } else {
              alert("Error: " + data.error);
            }
          } catch (e) {
            alert("Network error.");
          }
        }

        async function deleteUser(username) {
          if(!confirm("Delete user " + username + "?")) return;
          try {
            const res = await fetch('/api/users/delete', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username })
            });
            const data = await res.json();
            if (data.success) {
              alert("User deleted!");
              loadUsers();
            } else {
              alert("Error: " + data.error);
            }
          } catch (e) {
            alert("Network error.");
          }
        }

        function logout() { localStorage.clear(); window.location.href = '/'; }
        
        // Load initial data
        loadData();
      </script>
    </body>
    </html>
  `);
});

// API: Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// API: Get Assemblies
app.get('/api/assemblies', authenticate, (req, res) => {
  Assembly.findAll().then(assemblies => res.json(assemblies));
});

// API: Import Excel (Admin Only)
app.post('/api/import', authenticate, upload.single('file'), requireAdmin, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!sheetData.length) return res.status(400).json({ error: "Excel file is empty" });
    
    const assembliesToSave = sheetData.map((row, index) => ({
      assemblyNumber: row['Assembly Number'] || row['assemblyNumber'] || 'AUTO-' + Date.now() + '-' + index,
      assemblyName: row['Assembly Name'] || row['assemblyName'] || 'Unknown',
      qtyRequired: parseInt(row['Quantity'] || row['qtyRequired'] || 1),
      percentComplete: parseFloat(row['Percent'] || row['percentComplete'] || 0),
      status: row['Status'] || row['status'] || 'Pending'
    }));

    let count = 0;
    for (const asm of assembliesToSave) { await Assembly.upsert(asm); count++; }
    
    io.emit('data_updated', { count }); 
    res.json({ success: true, count, message: "Imported " + count + " assemblies." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse file." });
  }
});

// --- NEW: USER MANAGEMENT API ---

// Get all users (Admin Only)
app.get('/api/users', authenticate, requireAdmin, async (req, res) => {
  const users = await User.findAll({ attributes: ['username', 'role'] });
  res.json(users);
});

// Create user (Admin Only)
app.post('/api/users/create', authenticate, requireAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  
  try {
    const existing = await User.findOne({ where: { username } });
    if (existing) return res.status(400).json({ error: "Username already exists" });
    
    const hash = await bcrypt.hash(password, 10);
    await User.create({ username, passwordHash: hash, role: role || 'viewer' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to create user" });
  }
});

// Delete user (Admin Only)
app.post('/api/users/delete', authenticate, requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (username === 'admin') return res.status(403).json({ error: "Cannot delete super admin" });
  
  try {
    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(404).json({ error: "User not found" });
    
    await user.destroy();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// Start Server
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await initDB();
    server.listen(PORT, '0.0.0.0', () => {
      console.log('========================================');
      console.log('  CT20 Assembly Tracker - LIVE!');
      console.log('  Listening on port ' + PORT);
      console.log('========================================');
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();

