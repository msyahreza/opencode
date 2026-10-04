# Antigravity OAuth di OpenCode Desktop 2.0

Build ini memakai source desktop dan CLI OpenCode **2.0.20**, dari tag `v2.0.20`. Branch pengembangan fork adalah `antigravity-v2-dev`. Jalankan **Buka-OpenCode-Antigravity-v2.cmd** di folder ini untuk mode pengembangan.

## Login

1. Buka Settings → Providers → **Show more providers**.
2. Cari dan pilih **Antigravity**, lalu **Google (Antigravity)**.
3. Selesaikan login dan consent akun Google di browser. Callback otomatis akan menyimpan akun di v2.
4. Pilih model yang tersedia, lalu **Continue**. Model dapat diganti melalui pemilih model pada kotak prompt.

Jika callback otomatis tidak dapat memakai port 51121, pilih **Google (Antigravity, callback URL)**. Setelah login, tempel URL localhost lengkap dari percobaan login yang sama. Validasi origin, path, state, dan PKCE tetap dilakukan.

V2 memiliki credential OAuth sendiri; login v1 tidak diperlukan. Akun dan sesi disimpan di `%LOCALAPPDATA%\OpenCode-Antigravity-2.0`. Access token di-refresh dan disimpan oleh layanan integration v2. Pergantian akun dan disconnect memakai pengaturan provider v2. Token tidak disimpan di `opencode.json`.

## Installer Windows

Installer bernama **OpenCode-Antigravity-2.0.20-antigravity.3-x64-Setup.exe**, tersedia pada GitHub Releases fork `msyahreza/opencode`. Unduh ke laptop Windows x64, jalankan installer, lalu buka **OpenCode Antigravity**. Laptop tidak memerlukan Bun, Node, atau source code. Login Google dilakukan sendiri pada masing-masing perangkat; installer tidak membawa credential atau riwayat percakapan dari komputer pembuat.

Nama aplikasi, App ID, shortcut, profil, dan port layanan terpisah dari OpenCode official. Installer ini tidak mengambil alih tautan `opencode://`. Pilih folder pemasangan sendiri jika sudah ada OpenCode official. Build lokal belum ditandatangani dengan sertifikat Windows, sehingga Windows dapat menampilkan peringatan penerbit yang tidak dikenal.

Untuk build dari satu checkout, gunakan Bun sesuai `packageManager` dan Node 24, lalu jalankan PowerShell:

```powershell
git clone --branch antigravity-v2-dev --single-branch https://github.com/msyahreza/opencode.git opencode-antigravity
cd opencode-antigravity
bun install --frozen-lockfile --ignore-scripts
# Siapkan konfigurasi client OAuth lokal seperti dijelaskan di bawah.
.\script\Build-AntigravityInstaller.ps1
# Revisi berikutnya pada versi upstream yang sama:
.\script\Build-AntigravityInstaller.ps1 -Version '2.0.20-antigravity.4'
```

Hasilnya berada di `packages/desktop/dist-antigravity`. Build menggunakan CLI Windows x64 dengan versi yang sama seperti `packages/desktop/package.json`; jika belum tersedia atau versinya berbeda, script mengunduh CLI yang sesuai. Plugin OAuth dan adapter SDK berada dalam checkout yang sama; repo lama tidak diperlukan.

Source publik tidak memuat client ID atau client secret OAuth. Untuk membuild login Google, isi kedua environment variable `OPENCODE_ANTIGRAVITY_CLIENT_ID` dan `OPENCODE_ANTIGRAVITY_CLIENT_SECRET`, atau buat file lokal `tmp/antigravity-oauth.json` dengan field string `client_id` dan `client_secret` yang sesuai dengan client installed-application Antigravity. Folder `tmp` diabaikan Git. Script `packages/core/script/build-antigravity.ts` memvalidasi dan menyertakan pengaturan client tersebut dalam bundle aplikasi. Jangan memasukkan access token atau refresh token akun ke file ini. Installer pada GitHub Release sudah menyertakan konfigurasi client; pengguna installer cukup login Google.

Setelah menggabungkan pembaruan upstream, pertahankan modifikasi Antigravity, selesaikan konflik, jalankan `bun install` dan `bun run check`, lalu buat installer baru. Tutup OpenCode Antigravity sebelum memasang pembaruan ke folder yang sama. Profil OAuth dan sesi berada di luar folder pemasangan. Updater official dinonaktifkan pada build ini; pembaruan dilakukan dengan installer baru sampai tersedia feed pembaruan sendiri.

## Build dan transport

Gunakan `Buka-OpenCode-Antigravity-v2.cmd -Rebuild` setelah mengubah source. Bun dan Node diperlukan untuk build. Launcher membundel plugin OAuth dari `packages/core/src/plugin/provider/antigravity.ts` dan adapter SDK dari `packages/core/src/plugin/provider/antigravity-sdk.ts`. Runtime CLI resmi 2.0.20 menjalankan plugin lokal tersebut.

Login memakai HTTPS Google OAuth dan callback HTTP loopback `127.0.0.1:51121/oauth-callback`. Katalog model dan project akun diperoleh melalui API HTTPS Antigravity. Permintaan model menggunakan `v1internal:generateContent`; respons JSON diterjemahkan menjadi event AI SDK lokal. Thought signature pada tool call dipertahankan untuk replay. Token teks tampil setelah respons Google selesai.

Profil dan daemon build ini terpisah dari instalasi lain, dengan port localhost kosong yang dipilih saat daemon pertama dibuat. Console transport Electron dinonaktifkan untuk launcher ini agar penutupan console launcher tidak menyebabkan error `EPIPE`; log file desktop tetap aktif.

## Reasoning

Model Gemini 3 menyediakan pilihan tingkat thinking di sebelah nama model pada kotak prompt. Gemini 3.8 dan 3.7 Flash mendukung **Low, Medium, High**; pilihan pada keluarga Gemini 3 lainnya mengikuti kemampuan model. **Default** mempertahankan tingkat bawaan Google dan tetap meminta ringkasan thinking. Arahkan mouse ke kotak prompt untuk melihat pilihan Default, atau gunakan `Ctrl+Shift+D` untuk mengganti tingkatnya.

Ringkasan thinking yang dikembalikan Google disimpan terpisah dari jawaban. Untuk membacanya langsung, buka Settings → Preferences → Timeline → Advanced, lalu matikan **Group Thinking** dan **Collapse Thinking**. Respons tetap memakai `generateContent`, sehingga ringkasan muncul setelah Google selesai merespons. Lihat [dokumentasi Google](https://ai.google.dev/gemini-api/docs/generate-content/thinking) untuk level dan ringkasan yang didukung.

Konfigurasi SDK menyertakan fingerprint bundle agar pembaruan plugin dapat memakai adapter terbaru melalui reload plugin tanpa restart daemon.

## Verifikasi

Tes mencakup PKCE, state, callback manual, refresh token, katalog akun, pergantian credential, disconnect, dan replay tool signature. Smoke test native memakai akun serta respons HTTP dummy untuk memeriksa versi aplikasi dan backend 2.0.20, login dari dialog desktop, penyimpanan credential v2, pemilihan model, dan siklus tool baca file. Login Google sungguhan tetap dilakukan oleh pemilik akun di browser.

Paket Windows diuji langsung dari `win-unpacked` dengan profil kosong: versi desktop mengikuti revisi installer, CLI versi `2.0.20`, resource plugin dimuat dari paket, tidak ada akun bawaan, dan dialog desktop memulai URL Google OAuth dengan PKCE S256. Tes adapter SDK memeriksa reasoning pada generate/stream, pergantian akun, disconnect, dan replay tool signature dari SQLite.

## Impor pengaturan OpenCode existing

Saat startup, sebelum daemon pribadi dijalankan, aplikasi mendeteksi CLI `opencode` di PATH, nama OpenCode pada registry uninstall desktop Windows, dan konfigurasi global. Lokasi standar yang dicek adalah `~/.config/opencode` serta `%APPDATA%/opencode`. Jika proses diluncurkan dengan `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, atau `OPENCODE_CONFIG`, lokasi konfigurasi tersebut ikut dipakai sebagai sumber. Override direktori global dilepas dari daemon Antigravity agar port layanan tidak memakai pengaturan official.

Jika konfigurasi ditemukan, `opencode.json` dan `opencode.jsonc` dibaca, termasuk komentar JSONC dan field kompatibilitas v1. Pengaturan Antigravity yang sudah ada diprioritaskan. Model default dan updater Antigravity dipertahankan. Folder `skill/skills`, `agent/agents`, `command/commands`, `mode/modes`, `tools`, `themes`, dan `AGENTS.md` disalin tanpa menimpa file yang sudah ada. Akun pada file auth, database percakapan, `service.json`, cache, dan state desktop official tidak ikut diimpor.

Plugin lokal berbentuk package directory direferensikan pada lokasi asal agar dependensinya tetap dapat ditemukan. Plugin npm tetap mengikuti dukungan plugin v2. Plugin auth Antigravity lama dilewati karena OAuth sudah dibundel; plugin standalone `.js/.ts/.mjs` v1 yang memerlukan konversi juga dilewati dan dicatat. Source OpenCode tidak diubah. Referensi `{file:...}` relatif pada JSON diarahkan ke file sumber yang sama.

Impor yang berhasil berjalan satu kali untuk setiap profil; file berikutnya dikelola sendiri dalam profil Antigravity. Jika konfigurasi belum ada atau bermasalah, aplikasi tetap dapat dibuka dan pencarian dicoba lagi pada startup berikutnya. Ini merupakan salinan awal, bukan sinkronisasi dua arah.

Laporan berisi lokasi sumber, hasil deteksi instalasi, file yang disalin, plugin yang dilewati, dan masalah pembacaan di `%LOCALAPPDATA%/OpenCode-Antigravity-2.0/config/opencode/antigravity-import.json`. Laporan tidak memuat nilai konfigurasi atau token. Config pribadi sebelum impor dicadangkan sebagai `opencode.json.before-import`. Untuk menjalankan ulang impor secara manual, tutup aplikasi dan hapus hanya `antigravity-import.json`; pengaturan dan file pribadi tetap diprioritaskan.
