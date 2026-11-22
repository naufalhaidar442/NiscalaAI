# StoryVerse — versi update

## Fitur yang ditambahkan
- Beranda katalog cerita: pencarian judul/deskripsi dan filter genre.
- Genre cerita dapat diisi saat membuat atau mengedit cerita.
- Halaman `detail.html`: deskripsi, genre, rating SFW/NSFW, karakter, opening message, dan riwayat chat per cerita.
- Sidebar: Discover, Riwayat Chat, Shop, Setting, Account.
- Wallet per akun dan aturan biaya 30 koin untuk setiap jawaban AI yang berhasil.
- Regenerate juga menggunakan endpoint generate, sehingga ikut dikenai biaya 30 koin.
- Jika proses AI gagal, reservasi 30 koin dikembalikan.

## Menjalankan
Gunakan struktur folder yang sama seperti project sebelumnya. Salin file-file dalam ZIP ke folder project yang berisi `server.js`, lalu jalankan:

```bash
RUNPOD_KEY="API_KEY_BARU_KAMU" node server.js
```

Di Windows PowerShell:
```powershell
$env:RUNPOD_KEY="API_KEY_BARU_KAMU"
node server.js
```

`RUNPOD_KEY` sekarang dibaca dari environment, bukan disimpan di source code. Untuk pengujian lokal saja, kamu bisa menambahkan `INITIAL_COINS=300` agar akun yang belum punya file wallet mendapat 300 koin awal; jangan gunakan saldo awal gratis ini untuk produksi. API key yang sebelumnya tertulis langsung di file server yang kamu unggah sebaiknya segera di-rotate/revoke di dashboard provider karena sudah terekspos di source.

## Catatan penting tentang Shop
Tampilan paket 500 / 1.500 / 5.000 koin dan langganan Unlimited sudah disiapkan. Wallet dan pemotongan koin berjalan di backend. Namun pembelian belum dapat mengkredit saldo secara otomatis karena project belum memiliki konfigurasi payment gateway dan webhook terverifikasi. Endpoint checkout sengaja mengembalikan status belum dikonfigurasi; jangan mengaktifkan top-up dari sisi browser saja karena itu bisa dimanipulasi.

Untuk mengaktifkan transaksi sungguhan, tentukan provider pembayaran (misalnya Midtrans atau Xendit), mata uang/harga paket, dan aturan langganan. Setelah itu perlu dibuat checkout server-side serta webhook signature verification sebelum koin atau masa unlimited ditambahkan. Saat ini saldo akun baru dimulai dari 0 sampai payment/admin credit flow disiapkan.

## Catatan data
Wallet disimpan pada `data/<googleUserId>/wallet.json`, terpisah dari file chat. Jangan hapus folder `data` saat deploy jika ingin mempertahankan chat dan saldo.
