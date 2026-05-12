-- CreateTable
CREATE TABLE "Laporan" (
    "id" SERIAL NOT NULL,
    "teks_asli" TEXT NOT NULL,
    "teks_bersih" TEXT,
    "kategori" TEXT,
    "sentimen" TEXT,
    "skor_urgensi" INTEGER,
    "confidence" DOUBLE PRECISION,
    "tanggal" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Laporan_pkey" PRIMARY KEY ("id")
);
