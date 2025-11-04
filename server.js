import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 8080;

// ----- CORS (whitelist) -----
const origins = (process.env.CORS_ORIGINS || 'https://vantaprotocol.app')
  .split(',')
  .map(o => o.trim().replace(/\/$/, '')); // normalize trailing slash
const corsOpt = {
  origin: function (origin, cb) {
    // allow same-origin/no-origin (mobile apps, curl)
    if (!origin) return cb(null, true);
    const ok = origins.includes(origin.replace(/\/$/, ''));
    return cb(ok ? null : new Error('CORS blocked'), ok);
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// ----- Middleware -----
app.use(cors(corsOpt));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const limiter = rateLimit({
  windowMs: 60_000, // 1 minute
  limit: 60,        // 60 req/min/IP
});
app.use('/api/', limiter);

// ----- OpenAI client -----
if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment');
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----- In-memory task store (simple) -----
const tasks = new Map(); // id -> { id, status, kind, createdAt, result?, error? }
const newId = () => Math.random().toString(36).slice(2, 10);

// ----- Health -----
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vanta-protocol-backend', time: new Date().toISOString() });
});

// ----- Upload (optional reference files) -----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Store to S3/GCS if needed; here we just echo metadata
  const meta = {
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  };
  return res.json({ ok: true, meta });
});

// ----- Generic Agent (text) -----
app.post('/api/agent/generic', async (req, res, next) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });

    const id = newId();
    tasks.set(id, { id, status: 'running', kind: 'generic', createdAt: Date.now() });

    // Simple synchronous run; for heavy jobs push to queue
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'You are Vanta Protocol AI Agent. Be concise and actionable.' },
        { role: 'user', content: prompt }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim() || '';
    const result = { answer };

    tasks.set(id, { id, status: 'done', kind: 'generic', createdAt: Date.now(), result });
    return res.json({ id, status: 'done', result });
  } catch (err) { next(err); }
});

// ----- Sheets Agent (produce schema + sample CSV) -----
app.post('/api/agent/sheets', async (req, res, next) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });

    const id = newId();
    tasks.set(id, { id, status: 'running', kind: 'sheets', createdAt: Date.now() });

    // Ask model to output strict JSON
    const system = [
      'You are a data modelling agent for spreadsheets.',
      'Return STRICT JSON only with keys: "title", "columns", "sample_csv".',
      '"columns" is an array of { "name": string, "type": "string|number|date|boolean", "description": string }.',
      '"sample_csv" must be a valid CSV with header row matching columns and 5 sample rows.',
      'Do not include markdown. No commentary. JSON only.'
    ].join(' ');

    const user = `Create a spreadsheet for the following request. Keep it practical for an analyst.\nRequest: ${prompt}`;

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' }, // enforce JSON in modern SDKs
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });

    let jsonText = resp.choices[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch { parsed = { title: 'Sheet', columns: [], sample_csv: '' }; }

    const result = {
      title: parsed.title || 'Generated Sheet',
      columns: Array.isArray(parsed.columns) ? parsed.columns : [],
      sample_csv: parsed.sample_csv || ''
    };

    tasks.set(id, { id, status: 'done', kind: 'sheets', createdAt: Date.now(), result });
    return res.json({ id, status: 'done', result });
  } catch (err) { next(err); }
});

// ----- Task status -----
app.get('/api/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  return res.json(t);
});

// ----- Error handler -----
app.use((err, req, res, next) => {
  const status = err.message === 'CORS blocked' ? 403 : 500;
  console.error('[ERROR]', err);
  res.status(status).json({ error: err.message || 'Server error' });
});

// ----- Start -----
app.listen(PORT, () => {
  console.log(`Vanta backend listening on http://localhost:${PORT}`);
  console.log('Allowed origins:', origins);
});
