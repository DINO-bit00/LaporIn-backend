process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Supabase pooler SSL workaround
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL,
  ].filter(Boolean),
  credentials: true,
}));
app.use(express.json());

// ===== DATABASE SETUP =====
const connectionString = process.env.DATABASE_URL;
const pool = new pg.Pool({
  connectionString,
  ssl: process.env.DATABASE_URL?.includes('supabase')
    ? { rejectUnauthorized: false }
    : false,
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ===== AUTH CONFIG =====
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'laporin-secret-key-2026';

// ===== HUGGINGFACE CONFIG =====
const HF_API_URL = process.env.HUGGINGFACE_API_URL;
const HF_API_TOKEN = process.env.HUGGINGFACE_API_TOKEN;

// ===== HELPERS =====
function capitalize(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ===== KAMUS KATA KRITIS (rule-based urgensi) =====
const KATA_KRITIS = [
  'darurat', 'tolong', 'bahaya', 'gawat', 'segera', 'mati', 'parah',
  'bencana', 'kebakaran', 'banjir', 'longsor', 'gempa', 'roboh',
  'kecelakaan', 'korban', 'meninggal', 'luka', 'emergency', 'kritis',
  'ambruk', 'jebol', 'runtuh', 'urgent', 'hancur'
];

function hitungUrgensi(teks) {
  const lower = teks.toLowerCase();
  const matches = KATA_KRITIS.filter(kata => lower.includes(kata));
  if (matches.length >= 3) return 2;
  if (matches.length >= 1) return 1;
  return 0;
}

// ===== AUTH MIDDLEWARE =====
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau sudah expired' });
  }
}

// ===== HUGGINGFACE AI CALL WITH RETRY =====
async function callHuggingFaceAI(teks, retries = 3) {
  if (!HF_API_URL) {
    console.warn('HUGGINGFACE_API_URL belum di-set. Menggunakan fallback.');
    return null;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (HF_API_TOKEN) {
    headers['Authorization'] = `Bearer ${HF_API_TOKEN}`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        HF_API_URL,
        { teks },
        { headers, timeout: 120000 }
      );
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 503 && attempt < retries) {
        const wait = attempt * 10000;
        console.log(`HuggingFace model loading (attempt ${attempt}/${retries}). Retry in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.error(`HuggingFace AI call failed (attempt ${attempt}):`, err.message);
      if (attempt === retries) return null;
    }
  }
  return null;
}

// ===== WARM-UP PING =====
function startWarmUpPing() {
  if (!HF_API_URL) return;
  const INTERVAL = 10 * 60 * 1000;
  console.log(`Warm-up ping aktif: ping ke HuggingFace setiap 10 menit`);

  setInterval(async () => {
    try {
      await axios.post(
        HF_API_URL,
        { teks: 'ping warm-up' },
        {
          headers: HF_API_TOKEN ? { Authorization: `Bearer ${HF_API_TOKEN}` } : {},
          timeout: 30000,
        }
      );
      console.log('Warm-up ping: OK');
    } catch (err) {
      console.log('Warm-up ping: model mungkin sedang loading -', err.message);
    }
  }, INTERVAL);
}

// =============================================================
// ROUTES
// =============================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ai_configured: !!HF_API_URL,
    timestamp: new Date().toISOString(),
  });
});

// ===== AUTH ROUTES =====

// POST /api/auth/login — Admin login
app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password wajib diisi' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Password salah' });
  }
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ message: 'Login berhasil', token });
});

// GET /api/auth/verify — Verify token
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, role: req.admin.role });
});

// ===== LAPORAN ROUTES =====

// POST /api/laporan — Terima laporan baru
app.post('/api/laporan', async (req, res) => {
  try {
    const { teks, lokasi, nama } = req.body;

    if (!teks || teks.trim().length === 0) {
      return res.status(400).json({ error: 'Teks laporan tidak boleh kosong' });
    }

    // 1. Call HuggingFace AI
    let hasilAI = {
      kategori: 'Belum Terkategori',
      sentimen: 'Negatif',
      confidence: 0.0,
    };

    const aiResponse = await callHuggingFaceAI(teks);
    if (aiResponse) {
      hasilAI = {
        kategori: capitalize(aiResponse.kategori) || hasilAI.kategori,
        sentimen: capitalize(aiResponse.sentimen) || hasilAI.sentimen,
        confidence: aiResponse.confidence || hasilAI.confidence,
      };
    }

    // 2. Hitung skor urgensi (rule-based)
    const skor_urgensi = hitungUrgensi(teks);

    // 3. Simpan ke database
    const laporanBaru = await prisma.laporan.create({
      data: {
        teks_asli: teks,
        lokasi: lokasi || null,
        nama: nama || null,
        kategori: hasilAI.kategori,
        sentimen: hasilAI.sentimen,
        skor_urgensi: skor_urgensi,
        confidence: hasilAI.confidence,
        status: 'Baru',
      },
    });

    res.status(201).json({
      message: 'Laporan berhasil diproses dan dianalisis oleh AI!',
      data: laporanBaru,
      ai_processed: !!aiResponse,
    });
  } catch (error) {
    console.error('Error POST /api/laporan:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server.' });
  }
});

// GET /api/laporan — Daftar laporan (with pagination, search, filter, sort)
app.get('/api/laporan', async (req, res) => {
  try {
    const { kategori, sentimen, status, urgensi, search, page, limit, sortBy, order } = req.query;
    const where = {};

    if (kategori && kategori !== 'all') {
      where.kategori = { equals: kategori, mode: 'insensitive' };
    }
    if (sentimen && sentimen !== 'all') {
      where.sentimen = { equals: sentimen, mode: 'insensitive' };
    }
    if (status && status !== 'all') {
      where.status = { equals: status, mode: 'insensitive' };
    }
    if (urgensi !== undefined && urgensi !== '' && urgensi !== 'all') {
      where.skor_urgensi = parseInt(urgensi);
    }
    if (search) {
      const trimmed = search.trim();
      // Kalau angka -> cari berdasarkan ID, kalau teks -> cari di teks_asli
      if (/^\d+$/.test(trimmed)) {
        where.OR = [
          { id: parseInt(trimmed) },
          { teks_asli: { contains: trimmed, mode: 'insensitive' } },
        ];
      } else {
        where.teks_asli = { contains: trimmed, mode: 'insensitive' };
      }
    }

    // Pagination
    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 50;
    const skip = (pageNum - 1) * limitNum;

    // Sorting
    const validSortFields = ['id', 'tanggal', 'kategori', 'sentimen', 'skor_urgensi', 'status'];
    const sortField = validSortFields.includes(sortBy) ? sortBy : 'tanggal';
    const sortOrder = order === 'asc' ? 'asc' : 'desc';

    const [daftarLaporan, total] = await Promise.all([
      prisma.laporan.findMany({
        where,
        orderBy: { [sortField]: sortOrder },
        skip,
        take: limitNum,
      }),
      prisma.laporan.count({ where }),
    ]);

    res.status(200).json({
      data: daftarLaporan,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('Error GET /api/laporan:', error);
    res.status(500).json({ error: 'Gagal mengambil data laporan.' });
  }
});

// PATCH /api/laporan/:id — Update status & catatan (Admin only)
app.patch('/api/laporan/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, catatan_admin } = req.body;

    const updateData = {};
    if (status) updateData.status = status;
    if (catatan_admin !== undefined) updateData.catatan_admin = catatan_admin;

    const updated = await prisma.laporan.update({
      where: { id: parseInt(id) },
      data: updateData,
    });

    res.json({ message: 'Laporan berhasil diperbarui', data: updated });
  } catch (error) {
    console.error('Error PATCH /api/laporan/:id:', error);
    res.status(500).json({ error: 'Gagal memperbarui laporan.' });
  }
});

// DELETE /api/laporan/:id — Hapus laporan (Admin only)
app.delete('/api/laporan/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.laporan.delete({ where: { id: parseInt(id) } });
    res.json({ message: 'Laporan berhasil dihapus' });
  } catch (error) {
    console.error('Error DELETE /api/laporan/:id:', error);
    res.status(500).json({ error: 'Gagal menghapus laporan.' });
  }
});

// ===== STATS ROUTES =====

// GET /api/stats — Statistik agregat
app.get('/api/stats', async (req, res) => {
  try {
    const totalLaporan = await prisma.laporan.count();

    const kategoriRaw = await prisma.laporan.groupBy({
      by: ['kategori'],
      _count: { id: true },
    });
    const kategori_breakdown = {};
    kategoriRaw.forEach((r) => {
      if (r.kategori) kategori_breakdown[r.kategori] = r._count.id;
    });

    const sentimenRaw = await prisma.laporan.groupBy({
      by: ['sentimen'],
      _count: { id: true },
    });
    const sentimen_breakdown = {};
    sentimenRaw.forEach((r) => {
      if (r.sentimen) sentimen_breakdown[r.sentimen] = r._count.id;
    });

    const urgensiRaw = await prisma.laporan.groupBy({
      by: ['skor_urgensi'],
      _count: { id: true },
    });
    const urgensi_breakdown = {};
    urgensiRaw.forEach((r) => {
      if (r.skor_urgensi != null) urgensi_breakdown[r.skor_urgensi] = r._count.id;
    });

    // Status breakdown
    const statusRaw = await prisma.laporan.groupBy({
      by: ['status'],
      _count: { id: true },
    });
    const status_breakdown = {};
    statusRaw.forEach((r) => {
      if (r.status) status_breakdown[r.status] = r._count.id;
    });

    res.status(200).json({
      total_laporan: totalLaporan,
      kategori_breakdown,
      sentimen_breakdown,
      urgensi_breakdown,
      status_breakdown,
    });
  } catch (error) {
    console.error('Error GET /api/stats:', error);
    res.status(500).json({ error: 'Gagal mengambil data statistik.' });
  }
});

// GET /api/stats/trend — Trend laporan 7 hari terakhir
app.get('/api/stats/trend', async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const laporan = await prisma.laporan.findMany({
      where: { tanggal: { gte: sevenDaysAgo } },
      select: { tanggal: true },
    });

    // Group by date
    const trend = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().split('T')[0];
      trend[key] = 0;
    }
    laporan.forEach((l) => {
      const key = l.tanggal.toISOString().split('T')[0];
      if (trend[key] !== undefined) trend[key]++;
    });

    const result = Object.entries(trend).map(([date, count]) => ({
      date,
      label: new Date(date).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' }),
      count,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error GET /api/stats/trend:', error);
    res.status(500).json({ error: 'Gagal mengambil data trend.' });
  }
});

// GET /api/stats/keywords — Top kata kunci dari semua laporan
app.get('/api/stats/keywords', async (req, res) => {
  try {
    const laporan = await prisma.laporan.findMany({
      select: { teks_asli: true },
    });

    // Simple word frequency
    const stopWords = new Set([
      'yang', 'dan', 'di', 'ke', 'dari', 'ini', 'itu', 'untuk', 'dengan',
      'pada', 'tidak', 'ada', 'akan', 'juga', 'sudah', 'saya', 'kami',
      'mereka', 'bisa', 'atau', 'jika', 'oleh', 'karena', 'sangat',
      'telah', 'belum', 'masih', 'agar', 'atas', 'bagi', 'dalam',
      'apa', 'mohon', 'tolong', 'perlu', 'harus', 'lagi', 'lebih',
      'sering', 'sekali', 'pernah', 'seperti', 'melalui', 'tentang',
      'sebuah', 'tersebut', 'saat', 'sedang', 'semua', 'tapi',
    ]);

    const wordCount = {};
    laporan.forEach((l) => {
      const words = l.teks_asli.toLowerCase().replace(/[^a-zA-Z\s]/g, '').split(/\s+/);
      words.forEach((word) => {
        if (word.length > 3 && !stopWords.has(word)) {
          wordCount[word] = (wordCount[word] || 0) + 1;
        }
      });
    });

    const top = Object.entries(wordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word, count]) => ({ word, count }));

    res.json(top);
  } catch (error) {
    console.error('Error GET /api/stats/keywords:', error);
    res.status(500).json({ error: 'Gagal mengambil keyword.' });
  }
});

// GET /api/laporan/export — Export CSV
app.get('/api/laporan/export', async (req, res) => {
  try {
    const laporan = await prisma.laporan.findMany({
      orderBy: { tanggal: 'desc' },
    });

    // Build CSV
    const headers = ['ID', 'Teks', 'Kategori', 'Sentimen', 'Urgensi', 'Status', 'Lokasi', 'Nama', 'Confidence', 'Catatan Admin', 'Tanggal'];
    const rows = laporan.map((l) => [
      l.id,
      `"${(l.teks_asli || '').replace(/"/g, '""')}"`,
      l.kategori || '',
      l.sentimen || '',
      l.skor_urgensi ?? '',
      l.status || '',
      l.lokasi || '',
      l.nama || '',
      l.confidence ?? '',
      `"${(l.catatan_admin || '').replace(/"/g, '""')}"`,
      l.tanggal?.toISOString() || '',
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=laporan_laporin.csv');
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  } catch (error) {
    console.error('Error GET /api/laporan/export:', error);
    res.status(500).json({ error: 'Gagal export data.' });
  }
});

// ===== START SERVER =====
app.listen(port, () => {
  console.log(`Server Backend LaporIn berjalan di http://localhost:${port}`);
  startWarmUpPing();
});
