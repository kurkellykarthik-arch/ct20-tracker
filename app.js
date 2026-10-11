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

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

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

const Assembly = sequelize.define('Assembly', {
  partNumber: { type: DataTypes.STRING, primaryKey: true },
  description: DataTypes.STRING,
  qtyRequired: DataTypes.INTEGER,
  percentComplete: DataTypes.FLOAT,
  status: DataTypes.STRING
});

const JWT_SECRET = 'super-secret-key-change-in-production';

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
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CT20 Login</title><style>body{font-family:sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:100%;max-width:350px;text-align:center}h1{color:#6d4aff}input{width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:6px;box-sizing:border-box}button{width:100%;padding:12px;background:#6d4aff;color:white;border:none;border-radius:6px;font-size:16px;font-weight:bold;cursor:pointer}.error{color:red;margin-top:10px;display:none}</style></head><body><div class="card"><h1>🏭 CT20 Tracker</h1><input type="text" id="u" placeholder="Username"><input type="password" id="p" placeholder="Password"><button onclick="login()">Login</button><div id="e" class="error"></div></div><script>async function login(){var u=document.getElementById("u").value;var p=document.getElementById("p").value;var e=document.getElementById("e");if(!u||!p){e.innerText="Fill all fields";e.style.display="block";return;}fetch("/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})}).then(r=>r.json()).then(d=>{if(d.token){localStorage.setItem("ct20_token",d.token);localStorage.setItem("ct20_role",d.user.role);window.location.href="/dashboard";}else{e.innerText=d.error;e.style.display="block";}}).catch(x=>{e.innerText="Error";e.style.display="block";});}<\/script></body></html>');
});

// --- DASHBOARD PAGE ---
app.get('/dashboard', (req, res) => {
  var html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>CT20 Dashboard</title>';
  html += '<script src="/socket.io/socket.io.js"><\/script>';
  html += '<style>';
  html += 'body{font-family:sans-serif;background:#f8f9fa;margin:0;padding:20px}.container{max-width:1200px;margin:0 auto}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;margin-left:5px}.btn-logout{background:#d32f2f;color:white}.btn-upload{background:#4caf50;color:white}.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:20px}.stat-card{background:white;padding:15px;border-radius:8px;border-left:4px solid #6d4aff;box-shadow:0 2px 4px rgba(0,0,0,0.05)}.stat-val{font-size:1.5rem;font-weight:bold}.stat-label{font-size:0.85rem;color:#666}.card{background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.05);padding:20px;margin-bottom:20px;overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:800px}th,td{padding:12px;text-align:left;border-bottom:1px solid #eee}th{background:#6d4aff;color:white;font-weight:600}.status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:bold}.status-ok{background:#e8f5e9;color:#2e7d32}.status-warn{background:#fff3e0;color:#ef6c00}.status-bad{background:#ffebee;color:#c62828}.progress-bar{width:80px;height:8px;background:#eee;border-radius:4px;overflow:hidden;display:inline-block;vertical-align:middle;margin-right:5px}.progress-fill{height:100%;background:#6d4aff}.loading{text-align:center;padding:40px;color:#666}.editable-cell{padding:4px}.editable-cell input,.editable-cell select{width:100%;padding:4px;border:1px solid #ddd;border-radius:4px}#toast{visibility:hidden;min-width:250px;background:#333;color:#fff;text-align:center;border-radius:8px;padding:16px;position:fixed;z-index:1;left:50%;bottom:30px;font-size:17px}#toast.show{visibility:visible;animation:fadein 0.5s,fadeout 0.5s 2.5s}@keyframes fadein{from{bottom:0;opacity:0}to{bottom:30px;opacity:1}}@keyframes fadeout{from{bottom:30px;opacity:1}to{bottom:0;opacity:0}}.save-msg{font-size:12px;color:#666;margin-left:10px;display:none}';
  html += '</style></head><body>';
  html += '<div class="container">';
  html += '<div class="header"><h1>🏭 CT20 Assembly Tracker</h1><div>';
  html += '<label for="excel-upload" class="btn btn-upload" id="upload-btn" style="display:none;cursor:pointer">📤 Upload Excel</label>';
  html += '<input type="file" id="excel-upload" accept=".xlsx,.xls" style="display:none" onchange="handleFileUpload(this)">';
  html += '<span id="save-msg" class="save-msg">Saving...</span>';
  html += '<button class="btn btn-logout" onclick="logout()">Logout</button>';
  html += '</div></div>';
  html += '<div class="stat-grid">';
  html += '<div class="stat-card"><div class="stat-val" id="total">-</div><div class="stat-label">Total Parts</div></div>';
  html += '<div class="stat-card"><div class="stat-val" id="completed">-</div><div class="stat-label">Completed (%)</div></div>';
  html += '<div class="stat-card"><div class="stat-val" id="in-progress">-</div><div class="stat-label">In Progress</div></div>';
  html += '</div>';
  html += '<div class="card"><h3>Assembly List</h3><div id="content"><div class="loading">Loading data...</div></div></div>';
  html += '</div>';
  html += '<div id="toast"></div>';
  html += '<script>';
  html += 'var token=localStorage.getItem("ct20_token");var role=localStorage.getItem("ct20_role");if(!token){window.location.href="/";}';
  html += 'if(role==="admin"){document.getElementById("upload-btn").style.display="inline-block";}';
  html += 'var socket=io();socket.on("data_updated",function(d){showToast("Data Updated!");loadData();});';
  html += 'function showToast(m){var x=document.getElementById("toast");x.innerText=m;x.className="show";setTimeout(function(){x.className=x.className.replace("show","");},3000);}';
  html += 'function handleFileUpload(input){var f=input.files[0];if(!f)return;var fd=new FormData();fd.append("file",f);var btn=document.getElementById("upload-btn");btn.innerText="Uploading...";btn.disabled=true;fetch("/api/import",{method:"POST",headers:{"Authorization":"Bearer "+token},body:fd}).then(r=>r.json()).then(d=>{if(d.success){alert("Success! Imported "+d.count+" parts.");location.reload();}else{alert("Error: "+d.error);}}).catch(e=>{alert("Error");}).finally(function(){btn.innerText="📤 Upload Excel";btn.disabled=false;input.value="";});}';
  html += 'function updatePart(pn, fld, val){document.getElementById("save-msg").style.display="inline";fetch("/api/update-part",{method:"POST",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({partNumber:pn,field:fld,value:val})}).then(r=>r.json()).then(d=>{if(d.success){showToast("Saved!");loadData();}else{alert("Error: "+d.error);loadData();}}).catch(e=>{alert("Error");loadData();}).finally(function(){document.getElementById("save-msg").style.display="none";});}';
  html += 'function loadData(){fetch("/api/assemblies",{headers:{"Authorization":"Bearer "+token}}).then(r=>r.json()).then(data=>{document.getElementById("total").innerText=data.length;var c=data.filter(a=>a.percentComplete>=100).length;var p=data.filter(a=>a.percentComplete>0&&a.percentComplete<100).length;document.getElementById("completed").innerText=c;document.getElementById("in-progress").innerText=p;if(data.length===0){document.getElementById("content").innerHTML="<p style=\'text-align:center;color:#666\'>No parts found. Upload Excel.</p>";return;}var h="<table><thead><tr><th>Part No</th><th>Description</th><th>Qty Req</th><th>Qty Comp</th><th>% Complete</th><th>Status</th></tr></thead><tbody>";data.forEach(a=>{var qc=Math.round(a.qtyRequired*(a.percentComplete/100));h+="<tr><td style=\'font-family:monospace;font-size:12px\'>"+a.partNumber+"</td><td>"+a.description+"</td><td>"+a.qtyRequired+"</td><td><strong>"+qc+"</strong></td><td class=\'editable-cell\'><input type=\'number\' min=\'0\' max=\'100\' value=\'"+a.percentComplete+"\' onchange=\'updatePart("+JSON.stringify(a.partNumber)+",\\'percentComplete\\',this.value)\'></td><td class=\'editable-cell\'><select onchange=\'updatePart("+JSON.stringify(a.partNumber)+",\\'status\\',this.value)\'><option value=\'Pending\' "+(a.status==="Pending"?"selected":"")+">Pending</option><option value=\'In Progress\' "+(a.status==="In Progress"?"selected":"")+">In Progress</option><option value=\'Complete\' "+(a.status==="Complete"?"selected":"")+">Complete</option><option value=\'On Hold\' "+(a.status==="On Hold"?"selected":"")+">On Hold</option></select></td></tr>";});h+="</tbody></table>";document.getElementById("content").innerHTML=h;}).catch(e=>{document.getElementById("content").innerHTML="<p style=\'color:red;text-align:center\'>Error loading data.</p>";});}';
  html += 'function logout(){localStorage.clear();window.location.href="/";}';
  html += 'loadData();';
  html += '<\/script></body></html>';
  res.send(html);
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

// API: Update Part
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

// API: Import Excel
app.post('/api/import', authenticate, upload.single('file'), requireAdmin, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
    let headerRowIndex = -1;
    for(let i=0; i<Math.min(sheetData.length, 10); i++) {
      if(sheetData[i] && sheetData[i][4] === 'Drawing Number') {
        headerRowIndex = i;
        break;
      }
    }
    if(headerRowIndex === -1) return res.status(400).json({ error: "Could not find 'Drawing Number' header." });
    const dataRows = sheetData.slice(headerRowIndex + 1);
    const assembliesToSave = [];
    dataRows.forEach(row => {
      const drawingNum = row[4];
      const name = row[5];
      const qty = row[6];
      const pct = row[10];
      const stat = row[11];
      if (!drawingNum || !name) return;
      assembliesToSave.push({
        partNumber: String(drawingNum).trim(),
        description: String(name).trim(),
        qtyRequired: parseInt(qty) || 0,
        percentComplete: parseFloat(pct) || 0,
        status: String(stat || 'Pending').trim()
      });
    });
    let count = 0;
    for (const asm of assembliesToSave) { await Assembly.upsert(asm); count++; }
    io.emit('data_updated', { count });
    res.json({ success: true, count, message: "Imported " + count + " parts." });
  } catch (err) {
    console.error('Import Error:', err);
    res.status(500).json({ error: "Failed to parse file." });
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

