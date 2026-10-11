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

// Multer Setup (Memory Storage for Excel)
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

// Auth Secret
const JWT_SECRET = 'super-secret-key-change-in-production';

// Initialize DB & Create Admin
async function initDB() {
  await sequelize.sync();
  const count = await User.count();
  if (count === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await User.create({ username: 'admin', passwordHash: hash, role: 'admin' });
    console.log('✅ Default Admin created: admin / admin123 (Role: admin)');
  }
}

// --- MIDDLEWARE ---

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
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
            const res = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: u, password: p })
            });
            const data = await res.json();
            
            if (data.token) {
              localStorage.setItem('ct20_token', data.token);
              localStorage.setItem('ct20_role', data.user.role);
              window.location.href = '/dashboard';
            } else {
              err.innerText = data.error || "Login failed";
              err.style.display = 'block';
            }
          } catch (e) {
            err.innerText = "Network error. Check connection.";
            err.style.display = 'block';
          } finally {
            loader.style.display = 'none';
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 2. Dashboard Page
app.get('/dashboard', (req, res) => {
  const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : null;
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CT20 Dashboard</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8f9fa; margin: 0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
        h1 { color: #333; margin: 0; font-size: 1.5rem; }
        .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; }
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
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div>
            <h1>🏭 CT20 Assembly Tracker</h1>
            <span id="user-role" class="role-badge"></span>
          </div>
          <div>
            <!-- Upload Button (Only visible to admins via JS check) -->
            <label for="excel-upload" class="btn btn-upload" id="upload-btn" style="display:none; cursor: pointer;">
              📤 Upload Excel
            </label>
            <input type="file" id="excel-upload" accept=".xlsx, .xls" style="display: none;" onchange="handleFileUpload(this)">
            
            <button class="btn btn-logout" onclick="logout()">Logout</button>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-card"><div class="stat-val" id="total">-</div><div class="stat-label">Total</div></div>
          <div class="stat-card"><div class="stat-val" id="done" style="color: green;">-</div><div class="stat-label">Completed</div></div>
          <div class="stat-card"><div class="stat-val" id="prog" style="color: orange;">-</div><div class="stat-label">In Progress</div></div>
        </div>

        <div class="card">
          <h3>Assembly List</h3>
          <div id="content">
            <div class="loading">Loading data...</div>
          </div>
        </div>
      </div>

      <script>
        const token = localStorage.getItem('ct20_token');
        const role = localStorage.getItem('ct20_role');
        
        if (!token) { window.location.href = '/'; }

        // Show upload button only for admins
        if (role === 'admin') {
          document.getElementById('upload-btn').style.display = 'inline-block';
          document.getElementById('user-role').innerText = 'Admin';
        } else {
          document.getElementById('user-role').innerText = 'Viewer';
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
            const res = await fetch('/api/import', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + token },
              body: formData
            });

            const data = await res.json();
            if (data.success) {
              alert(\`✅ Success! Imported \${data.count} assemblies.\`);
              location.reload();
            } else {
              alert(\`❌ Error: \${data.error}\`);
            }
          } catch (e) {
            alert("❌ Network error during upload.");
          } finally {
            btn.innerText = '📤 Upload Excel';
            btn.disabled = false;
            inputElement.value = '';
          }
        }

        async function loadData() {
          try {
            const res = await fetch('/api/assemblies', {
              headers: { 'Authorization': 'Bearer ' + token }
            });
            
            if (res.status === 401) {
              localStorage.removeItem('ct20_token');
              localStorage.removeItem('ct20_role');
              window.location.href = '/';
              return;
            }

            const data = await res.json();
            document.getElementById('content').innerHTML = '';
            
            // Stats
            document.getElementById('total').innerText = data.length;
            document.getElementById('done').innerText = data.filter(a => a.percentComplete >= 100).length;
            document.getElementById('prog').innerText = data.filter(a => a.percentComplete > 0 && a.percentComplete < 100).length;

            if (data.length === 0) {
              document.getElementById('content').innerHTML = '<p style="text-align:center; color:#666;">No assemblies found. Admins can upload an Excel file.</p>';
              return;
            }

            let html = '<table><thead><tr><th>Assembly #</th><th>Name</th><th>Qty</th><th>%</th><th>Status</th></tr></thead><tbody>';
            data.forEach(a => {
              let badgeClass = a.percentComplete >= 100 ? 'status-ok' : (a.percentComplete > 0 ? 'status-warn' : 'status-bad');
              let badgeText = a.percentComplete >= 100 ? '✅ Done' : (a.percentComplete > 0 ? '🔄 Working' : '⏳ Pending');
              
              html += \`
                <tr>
                  <td style="font-family: monospace; font-size: 12px;">\${a.assemblyNumber}</td>
                  <td>\${a.assemblyName}</td>
                  <td>\${a.qtyRequired}</td>
                  <td>
                    <div class="progress-bar"><div class="progress-fill" style="width: \${Math.min(a.percentComplete, 100)}%"></div></div>
                    <small>\${a.percentComplete}%</small>
                  </td>
                  <td><span class="status-badge \${badgeClass}">\${badgeText}</span></td>
                </tr>
              \`;
            });
            html += '</tbody></table>';
            document.getElementById('content').innerHTML = html;
          } catch (err) {
            document.getElementById('content').innerHTML = '<p style="color:red; text-align:center;">Error loading data. Please check connection.</p>';
          }
        }

        function logout() {
          localStorage.removeItem('ct20_token');
          localStorage.removeItem('ct20_role');
          window.location.href = '/';
        }

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
  
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  
  const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// API: Get Assemblies
app.get('/api/assemblies', authenticate, (req, res) => {
  Assembly.findAll().then(assemblies => res.json(assemblies));
});

// API: Import Excel (Admin Only)
app.post('/api/import', authenticate, upload.single('file'), requireAdmin, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!sheetData.length) {
      return res.status(400).json({ error: "Excel file is empty" });
    }

    // Map Excel columns to Database fields
    // Expected Excel Headers: "Assembly Number", "Assembly Name", "Quantity", "Percent", "Status"
    const assembliesToSave = sheetData.map((row, index) => {
      return {
        assemblyNumber: row['Assembly Number'] || row['assemblyNumber'] || `AUTO-${Date.now()}-${index}`,
        assemblyName: row['Assembly Name'] || row['assemblyName'] || 'Unknown Assembly',
        qtyRequired: parseInt(row['Quantity'] || row['qtyRequired'] || 1),
        percentComplete: parseFloat(row['Percent'] || row['percentComplete'] || 0),
        status: row['Status'] || row['status'] || 'Pending'
      };
    });

    // Upsert (Update or Insert) each assembly
    let count = 0;
    for (const asm of assembliesToSave) {
      await Assembly.upsert(asm);
      count++;
    }

    io.emit('data_updated', { count }); // Notify all connected clients
    res.json({ success: true, count, message: \`Successfully imported \${count} assemblies.\` });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to parse Excel file. Check column headers." });
  }
});

// Start Server
async function start() {
  await initDB();
  const PORT = process.env.PORT || 3001; // Use Railway's port or fallback to 3001

async function start() {
  await initDB();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`  🚀 CT20 Assembly Tracker - LIVE!`);
    console.log(`  🌐 Listening on port ${PORT}`);
    console.log(`  👤 User: admin | Pass: admin123`);
    console.log(`========================================\n`);
  });
}

start();

