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
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] } });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });
const sequelize = new Sequelize({ dialect: 'sqlite', storage: './ct20_data.db', logging: false });

const User = sequelize.define('User', {
  username: { type: DataTypes.STRING, unique: true },
  passwordHash: DataTypes.STRING,
  role: { type: DataTypes.STRING, defaultValue: 'viewer' }
});

const Assembly = sequelize.define('Assembly', {
  partNumber: { type: DataTypes.STRING, primaryKey: true },
  description: DataTypes.STRING,
  qtyRequired: DataTypes.INTEGER,
  percentComplete: DataTypes.FLOAT,
  status: DataTypes.STRING
});

const JWT_SECRET = 'super-secret-key';

async function initDB() {
  await sequelize.sync({ force: true });
  const count = await User.count();
  if (count === 0) {
    const hash = await bcrypt.hash('admin123', 10);
    await User.create({ username: 'admin', passwordHash: hash, role: 'admin' });
    console.log('Admin created');
  }
}

function auth(req, res, next) {
  const tok = req.headers.authorization;
  if (!tok || !tok.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(tok.split(' ')[1], JWT_SECRET);
    next();
  } catch { return res.status(401).json({ error: 'Invalid' }); }
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await User.findOne({ where: { username } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Invalid' });
  res.json({ token: jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET), user });
});

app.get('/api/assemblies', auth, (req, res) => Assembly.findAll().then(d => res.json(d)));

app.post('/api/update-part', auth, async (req, res) => {
  const { partNumber, field, value } = req.body;
  const item = await Assembly.findByPk(partNumber);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (field === 'percentComplete') {
    item.percentComplete = parseFloat(value);
    item.status = item.percentComplete >= 100 ? 'Complete' : (item.percentComplete > 0 ? 'In Progress' : 'Pending');
  } else if (field === 'status') {
    item.status = value;
  }
  await item.save();
  io.emit('data_updated');
  res.json({ success: true });
});

app.post('/api/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  let hdr = -1;
  for (let i = 0; i < 10; i++) if (rows[i] && rows[i][4] === 'Drawing Number') { hdr = i; break; }
  if (hdr === -1) return res.status(400).json({ error: 'Header not found' });
  const list = [];
  for (let i = hdr + 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[4]) list.push({
      partNumber: String(r[4]).trim(),
      description: String(r[5] || '').trim(),
      qtyRequired: parseInt(r[6]) || 0,
      percentComplete: parseFloat(r[10]) || 0,
      status: String(r[11] || 'Pending').trim()
    });
  }
  let cnt = 0;
  for (const a of list) { await Assembly.upsert(a); cnt++; }
  io.emit('data_updated');
  res.json({ success: true, count: cnt });
});

app.get('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(await User.findAll({ attributes: ['username', 'role'] }));
});

app.post('/api/users/create', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username, password, role } = req.body;
  if (await User.findOne({ where: { username } })) return res.status(400).json({ error: 'Exists' });
  await User.create({ username, passwordHash: await bcrypt.hash(password, 10), role: role || 'viewer' });
  res.json({ success: true });
});

app.post('/api/users/delete', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { username } = req.body;
  if (username === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  const u = await User.findOne({ where: { username } });
  if (u) { await u.destroy(); res.json({ success: true }); }
  else res.status(404).json({ error: 'Not found' });
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log('LIVE on ' + PORT));
}).catch(e => { console.error(e); process.exit(1); });