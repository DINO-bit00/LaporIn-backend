process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Supabase pooler SSL workaround
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    process.env.FRONTEND_URL, // e.g. https://laporin.vercel.app
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

// ===== HUGGINGFACE CONFIG =====
const HF_API_URL = process.env.HUGGINGFACE_API_URL; // e.g. https://your-space.hf.space/predict
const HF_API_TOKEN = process.env.HUGGINGFACE_API_TOKEN; // optional, for auth

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
  if (matches.length >= 3) return 2; // Tinggi
  if (matches.length >= 1) return 1; // Sedang
  return 0; // Rendah
}

// ===== HUGGINGFACE AI CALL WITH RETRY (cold-start workaround) =====
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
        { headers, timeout: 120000 } // 120s timeout for cold-start
      );
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      // 503 = model loading (cold-start), retry
      if (status === 503 && attempt < retries) {
        const wait = attempt * 10000; // 10s, 20s, 30s
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

// ===== WARM-UP PING (keep model awake) =====
function startWarmUpPing() {
  if (!HF_API_URL) return;

  const INTERVAL = 10 * 60 * 1000; // 10 menit
  console.log(`🏓 Warm-up ping aktif: ping ke HuggingFace setiap 10 menit`);

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
      console.log('🏓 Warm-up ping: OK');
    } catch (err) {
      console.log('🏓 Warm-up ping: model mungkin sedang loading -', err.message);
    }
  }, INTERVAL);
}

// ===== ROUTES =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ai_configured: !!HF_API_URL,
    timestamp: new Date().toISOString(),
  });
});

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
        kategori: aiResponse.kategori || hasilAI.kategori,
        sentimen: aiResponse.sentimen || hasilAI.sentimen,
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
      },
    });

    res.status(201).json({
      message: 'Laporan berhasil diproses dan dianalisis oleh AI!',
      data: laporanBaru,
      ai_processed: !!aiResponse,
    });
  } catch (error) {
    console.error('Error POST /api/laporan:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server. Mohon coba beberapa saat lagi.' });
  }
});

// GET /api/laporan — Daftar laporan
app.get('/api/laporan', async (req, res) => {
  try {
    const { kategori, sentimen } = req.query;
    const where = {};
    if (kategori && kategori !== 'all') where.kategori = kategori;
    if (sentimen && sentimen !== 'all') where.sentimen = sentimen;

    const daftarLaporan = await prisma.laporan.findMany({
      where,
      orderBy: { tanggal: 'desc' },
    });
    res.status(200).json({ data: daftarLaporan });
  } catch (error) {
    console.error('Error GET /api/laporan:', error);
    res.status(500).json({ error: 'Gagal mengambil data laporan.' });
  }
});

// GET /api/stats — Statistik agregat untuk dashboard
app.get('/api/stats', async (req, res) => {
  try {
    const totalLaporan = await prisma.laporan.count();

    // Breakdown per kategori
    const kategoriRaw = await prisma.laporan.groupBy({
      by: ['kategori'],
      _count: { id: true },
    });
    const kategori_breakdown = {};
    kategoriRaw.forEach((r) => {
      if (r.kategori) kategori_breakdown[r.kategori] = r._count.id;
    });

    // Breakdown per sentimen
    const sentimenRaw = await prisma.laporan.groupBy({
      by: ['sentimen'],
      _count: { id: true },
    });
    const sentimen_breakdown = {};
    sentimenRaw.forEach((r) => {
      if (r.sentimen) sentimen_breakdown[r.sentimen] = r._count.id;
    });

    // Breakdown per urgensi
    const urgensiRaw = await prisma.laporan.groupBy({
      by: ['skor_urgensi'],
      _count: { id: true },
    });
    const urgensi_breakdown = {};
    urgensiRaw.forEach((r) => {
      if (r.skor_urgensi != null) urgensi_breakdown[r.skor_urgensi] = r._count.id;
    });

    res.status(200).json({
      total_laporan: totalLaporan,
      kategori_breakdown,
      sentimen_breakdown,
      urgensi_breakdown,
    });
  } catch (error) {
    console.error('Error GET /api/stats:', error);
    res.status(500).json({ error: 'Gagal mengambil data statistik.' });
  }
});

// ===== START SERVER =====
app.listen(port, () => {
  console.log(`🚀 Server Backend LaporIn berjalan di http://localhost:${port}`);
  startWarmUpPing();
});