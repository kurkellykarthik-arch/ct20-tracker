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
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"], credentials: true } 
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

// Database Setup
const sequelize = new Sequelize({ 
  dialect: 'sqlite', 
  storage: './ct20_data.db', 
  logging: false 
});

const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true, allowNull: false },
  passwordHash: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: 'viewer' }
});

// Assembly Model matching your Excel structure
const Assembly = sequelize.define('Assembly', {
  partNumber: { type: DataTypes.STRING, primaryKey: true }, // Drawing Number
  description: DataTypes.STRING,                           // Name of the Part
  qtyRequired: DataTypes.INTEGER,                          // Qty per CT-20
  percentComplete: DataTypes.FLOAT,                        // % Completed
  status: DataTypes.STRING                                 // Status
});

const JWT_SECRET = 'super-secret-key-change-in-production';

// Initialize DB & Create Admin
async function initDB() {
  try {
    await sequelize.sync({ force: false });
    const count = await User.count();
    if (count === 0) {
      const hash = await bcrypt.hash('admin123', 10);
      await User.create({ username: 'admin', passwordHash: hash, role: 'admin' });
      console.log('✅ Default Admin Created: admin / admin123');
    } else {
      console.log('ℹ️ Users already exist.');
    }
  } catch (err) {
    console.error('❌ DB Init Error:', err);
  }
}

function authenticate(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  const token = auth.split(' ')[1];
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

// --- LOGIN PAGE ---
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
        button { width: 100%; padding: 12px; background: #6d4aff; color: white; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 10px; }
        button:hover { background: #5a42d6; }
        .error { color: #d32f2f; margin-top: 10px; font-size: 14px; display: none; background: #ffebee; padding: 8px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🏭 CT20 Tracker</h1>
        <input type="text" id="username" placeholder="Username">
        <input type="password" id="password" placeholder="Password">
        <button onclick="handleLogin()">Login</button>
        <div id="errorMsg" class="error"></div>
      </div>
      <script>
        async function handleLogin() {
          const u = document.getElementById('username').value.trim();
          const p = document.getElementById('password').value;
          const err = document.getElementById('errorMsg');
          if(!u || !p) { err.innerText = "Fill all fields"; err.style.display = 'block'; return; }
          try {
            const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
            const data = await res.json();
            if (data.token) {
              localStorage.setItem('ct20_token', data.token);
              localStorage.setItem('ct20_role', data.user.role);
              window.location.href = '/dashboard';
            } else {
              err.innerText = data.error;
              err.style.display = 'block';
            }
          } catch (e) { err.innerText = "Network error"; err.style.display = 'block'; }
        }
      </script>
    </body>
    </html>
  `);
});

// --- DASHBOARD PAGE ---
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
        .container { max-width: 1200px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
        h1 { color: #333; margin: 0; font-size: 1.5rem; }
        .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; margin-left: 5px; }
        .btn-logout { background: #d32f2f; color: white; }
        .btn-upload { background: #4caf50; color: white; }
        .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 15px; border-radius: 8px; border-left: 4px solid #6d4aff; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-val { font-size: 1.5rem; font-weight: bold; color: #333; }
        .stat-label { font-size: 0.85rem; color: #666; }
        .card { background: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); padding: 20px; margin-bottom: 20px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; min-width: 800px; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        th { background: #6d4aff; color: white; font-weight: 600; white-space: nowrap; }
        tr:last-child td { border-bottom: none; }
        .status-badge { padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; }
        .status-ok { background: #e8f5e9; color: #2e7d32; }
        .status-warn { background: #fff3e0; color: #ef6c00; }
        .status-bad { background: #ffebee; color: #c62828; }
        .progress-bar { width: 80px; height: 8px; background: #eee; border-radius: 4px; overflow: hidden; display: inline-block; vertical-align: middle; margin-right: 5px; }
        .progress-fill { height: 100%; background: #6d4aff; }
        .loading { text-align: center; padding: 40px; color: #666; }
        .editable-cell { padding: 4px; }
        .editable-cell input, .editable-cell select { width: 100%; padding: 4px; border: 1px solid #ddd; border-radius: 4px; }
        #toast { visibility: hidden; min-width: 250px; background-color: #333; color: #fff; text-align: center; border-radius: 8px; padding: 16px; position: fixed; z-index: 1; left: 50%; bottom: 30px; font-size: 17px; }
        #toast.show { visibility: visible; animation: fadein 0.5s, fadeout 0.5s 2.5s; }
        @keyframes fadein { from {bottom: 0; opacity: 0;} to {bottom: 30px; opacity: 1;} }
        @keyframes fadeout { from {bottom: 30px; opacity: 1;} to {bottom: 0; opacity: 0;} }
        .save-indicator { font-size: 12px; color: #666; margin-left: 10px; display: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🏭 CT20 Assembly Tracker</h1>
          <div>
            <label for="excel-upload" class="btn btn-upload" id="upload-btn" style="display:none; cursor: pointer;">📤 Upload Excel</label>
            <input type="file" id="excel-upload" accept=".xlsx, .xls" style="display: none;" onchange="handleFileUpload(this)">
            <span id="save-msg" class="save-indicator">Saving...</span>
            <button class="btn btn-logout" onclick="logout()">Logout</button>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card"><div class="stat-val" id="total">-</div><div class="stat-label">Total Parts</div></div>
          <div class="stat-card"><div class="stat-val" id="completed">-</div><div class="stat-label">Completed (%)</div></div>
          <div class="stat-card"><div class="stat-val" id="in-progress">-</div><div class="stat-label">In Progress</div></div>
        </div>

        <div class="card">
          <h3>Assembly List</h3>
          <div id="content"><div class="loading">Loading data...</div></div>
        </div>
      </div>

      <div id="toast">✨ Data Updated!</div>

      <script>
        const token = localStorage.getItem('ct20_token');
        const role = localStorage.getItem('ct20_role');
        if (!token) { window.location.href = '/'; }

        if (role === 'admin') {
          document.getElementById('upload-btn').style.display = 'inline-block';
        }

        const socket = io();
        socket.on('data_updated', (data) => {
          showToast('✨ New data received!');
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
              alert('Success! Imported ' + data.count + ' parts.');
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

        async function updatePart(partNumber, field, value) {
          document.getElementById('save-msg').style.display = 'inline';
          try {
            const res = await fetch('/api/update-part', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
              body: JSON.stringify({ partNumber, field, value })
            });
            const data = await res.json();
            if (data.success) {
              showToast('Saved!');
              loadData(); // Refresh to recalculate stats
            } else {
              alert("Error saving: " + data.error);
              loadData();
            }
          } catch (e) {
            alert("Network error");
            loadData();
          } finally {
            document.getElementById('save-msg').style.display = 'none';
          }
        }

        async function loadData() {
          try {
            const res = await fetch('/api/assemblies', { headers: { 'Authorization': 'Bearer ' + token } });
            if (res.status === 401) { localStorage.clear(); window.location.href = '/'; return; }
            const data = await res.json();
            
            // Stats
            document.getElementById('total').innerText = data.length;
            const completedCount = data.filter(a => a.percentComplete >= 100).length;
            const inProgressCount = data.filter(a => a.percentComplete > 0 && a.percentComplete < 100).length;
            document.getElementById('completed').innerText = completedCount;
            document.getElementById('in-progress').innerText = inProgressCount;

            if (data.length === 0) {
              document.getElementById('content').innerHTML = '<p style="text-align:center; color:#666;">No parts found. Upload an Excel file to start.</p>';
              return;
            }

            let html = '<table><thead><tr>';
            html += '<th>Part No (Drawing #)</th>';
            html += '<th>Description</th>';
            html += '<th>Qty Req</th>';
            html += '<th>Qty Comp (Calc)</th>';
            html += '<th>% Complete</th>';
            html += '<th>Status</th>';
            html += '</tr></thead><tbody>';

            data.forEach(a => {
              const qtyComp = Math.round(a.qtyRequired * (a.percentComplete / 100));
              let badgeClass = a.percentComplete >= 100 ? 'status-ok' : (a.percentComplete > 0 ? 'status-warn' : 'status-bad');
              let badgeText = a.percentComplete >= 100 ? '✅ Done' : (a.percentComplete > 0 ? '🔄 Working' : '⏳ Pending');
              
              html += '<tr>';
              html += '<td style="font-family: monospace; font-size: 12px;">' + a.partNumber + '</td>';
              html += '<td>' + a.description + '</td>';
              html += '<td>' + a.qtyRequired + '</td>';
              html += '<td><strong>' + qtyComp + '</strong></td>';
              
              // Editable % Complete
              html += '<td class="editable-cell">';
              html += '<input type="number" min="0" max="100" value="' + a.percentComplete + '" ';
              html += 'onchange="updatePart(\'' + a.partNumber + '\', \'percentComplete\', this.value)" ';
              html += 'placeholder="%">';
              html += '</td>';

              // Editable Status
              html += '<td class="editable-cell">';
              html += '<select onchange="updatePart(\'' + a.partNumber + '\', \'status\', this.value)">';
              html += '<option value="Pending" ' + (a.status === 'Pending' ? 'selected' : '') + '>Pending</option>';
              html += '<option value="In Progress" ' + (a.status === 'In Progress' ? 'selected' : '') + '>In Progress</option>';
              html += '<option value="Complete" ' + (a.status === 'Complete' ? 'selected' : '') + '>Complete</option>';
              html += '<option value="On Hold" ' + (a.status === 'On Hold' ? 'selected' : '') + '>On Hold</option>';
              html += '</select>';
              html += '</td>';
              
              html += '</tr>';
            });
            html += '</tbody></table>';
            document.getElementById('content').innerHTML = html;
          } catch (err) {
            document.getElementById('content').innerHTML = '<p style="color:red; text-align:center;">Error loading data.</p>';
          }
        }

        function logout() { localStorage.clear(); window.location.href = '/'; }
        loadData();
      </script>
    </body>
    </html>
  `);
});

// API: Login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const user = await User.findOne({ where: { username } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// API: Get Assemblies
app.get('/api/assemblies', authenticate, (req, res) => {
  Assembly.findAll().then(assemblies => res.json(assemblies)).catch(err => {
    console.error('Fetch Error:', err);
    res.status(500).json({ error: 'Failed to fetch data' });
  });
});

// API: Update Part (Status or %)
app.post('/api/update-part', authenticate, requireAdmin, async (req, res) => {
  const { partNumber, field, value } = req.body;
  if (!partNumber || !field) return res.status(400).json({ error: 'Missing data' });
  
  try {
    const assembly = await Assembly.findByPk(partNumber);
    if (!assembly) return res.status(404).json({ error: 'Part not found' });
    
    if (field === 'percentComplete') {
      const numVal = parseFloat(value);
      if (isNaN(numVal) || numVal < 0 || numVal > 100) return res.status(400).json({ error: 'Invalid percentage' });
      assembly.percentComplete = numVal;
      
      // Auto-update status if needed
      if (numVal === 100) assembly.status = 'Complete';
      else if (numVal > 0) assembly.status = 'In Progress';
      else if (assembly.status === 'Complete') assembly.status = 'In Progress';
      
    } else if (field === 'status') {
      assembly.status = value;
    }
    
    await assembly.save();
    io.emit('data_updated', {});
    res.json({ success: true });
  } catch (err) {
    console.error('Update Error:', err);
    res.status(500).json({ error: 'Failed to update' });
  }
});

// API: Import Excel (Admin Only)
app.post('/api/import', authenticate, upload.single('file'), requireAdmin, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    
    // Find header row (usually row 3 in your file, index 2)
    // Expected headers: Main Assembly, SUB Assembly, Part, S.No, Drawing Number, Name of the Part, Qty per CT-20, ..., % Completed, Status
    let headerRowIndex = -1;
    for(let i=0; i<Math.min(sheetData.length, 10); i++) {
      if(sheetData[i] && sheetData[i][4] === 'Drawing Number') {
        headerRowIndex = i;
        break;
      }
    }
    
    if(headerRowIndex === -1) return res.status(400).json({ error: "Could not find 'Drawing Number' header. Ensure Excel format matches." });
    
    const headers = sheetData[headerRowIndex];
    const dataRows = sheetData.slice(headerRowIndex + 1);
    
    const assembliesToSave = [];
    
    dataRows.forEach(row => {
      // Map columns by index based on your Excel structure
      // A:0, B:1, C:2, D:3, E:4(Drawing), F:5(Name), G:6(Qty), K:10(%), L:11(Status)
      const drawingNum = row[4]; // Drawing Number
      const name = row[5];       // Name of the Part
      const qty = row[6];        // Qty per CT-20
      const pct = row[10];       // % Completed
      const stat = row[11];      // Status
      
      if (!drawingNum || !name) return; // Skip empty rows
      
      assembliesToSave.push({
        partNumber: String(drawingNum).trim(),
        description: String(name).trim(),
        qtyRequired: parseInt(qty) || 0,
        percentComplete: parseFloat(pct) || 0,
        status: String(stat || 'Pending').trim()
      });
    });
    
    let count = 0;
    for (const asm of assembliesToSave) { 
      await Assembly.upsert(asm); 
      count++; 
    }
    
    io.emit('data_updated', { count });
    res.json({ success: true, count, message: "Imported " + count + " parts." });
  } catch (err) {
    console.error('Import Error:', err);
    res.status(500).json({ error: "Failed to parse file. Check headers." });
  }
});

const PORT = process.env.PORT || 3001;
async function start() {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('  CT20 Assembly Tracker - LIVE!');
    console.log('  Listening on port ' + PORT);
    console.log('========================================');
  });
}
start();

