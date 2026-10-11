const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Sequelize, DataTypes } = require('sequelize');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST", "PUT", "DELETE"], credentials: true } 
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public')); // Serve static files from 'public' folder

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

const Assembly = sequelize.define('Assembly', {
  partNumber: { type: DataTypes.STRING, primaryKey: true },
  description: DataTypes.STRING,
  qtyRequired: DataTypes.INTEGER,
  percentComplete: DataTypes.FLOAT,
  status: DataTypes.STRING
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

// Routes to serve HTML files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
    
    // Find header row (looking for 'Drawing Number' in column E/index 4)
    let headerRowIndex = -1;
    for(let i=0; i<Math.min(sheetData.length, 10); i++) {
      if(sheetData[i] && sheetData[i][4] === 'Drawing Number') {
        headerRowIndex = i;
        break;
      }
    }
    
    if(headerRowIndex === -1) return res.status(400).json({ error: "Could not find 'Drawing Number' header. Ensure Excel format matches." });
    
    const dataRows = sheetData.slice(headerRowIndex + 1);
    const assembliesToSave = [];
    
    dataRows.forEach(row => {
      // Map columns: E=4(Drawing), F=5(Name), G=6(Qty), K=10(%), L=11(Status)
      const drawingNum = row[4];
      const name = row[5];
      const qty = row[6];
      const pct = row[10];
      const stat = row[11];
      
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

