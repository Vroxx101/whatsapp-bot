// bot.js
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fetch = require("node-fetch"); // ✅ node-fetch v2.6.11 (support require)
const cheerio = require("cheerio");
const P = require("pino");
const qrcode = require("qrcode-terminal");

// === Gunakan API Key langsung (aman karena tidak di .env) ===
const API_KEY = "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";

// === Cache pencarian resep per user (JID) ===
const userSearchResults = new Map();

// === Cek apakah string adalah URL valid ===
function isValidURL(str) {
    try {
        new URL(str);
        return true;
    } catch (_) {
        return false;
    }
}

// === Scrap info dari link (judul, deskripsi, gambar) ===
async function scrapWebsite(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);

        const title = $('meta[property="og:title"]').attr('content') ||
            $('meta[name="twitter:title"]').attr('content') ||
            $('title').text() ||
            'Tidak ada judul';

        const description = $('meta[property="og:description"]').attr('content') ||
            $('meta[name="twitter:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            'Tidak ada deskripsi.';

        const image = $('meta[property="og:image"]').attr('content') ||
            $('meta[name="twitter:image"]').attr('content') ||
            null;

        return {
            title: title.trim().replace(/\s+/g, ' '),
            description: description.trim().replace(/\s+/g, ' '),
            link: url,
            image: image ? (image.startsWith('http') ? image : `https:${image}`) : null
        };
    } catch (err) {
        console.error("Error scrapWebsite:", err.message);
        return null;
    }
}

// === CARI RESEP DI COOKPAD ===
async function cariresep(query) {
    try {
        const url = `https://cookpad.com/id/search/${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);
        const results = [];

        // Ambil daftar resep
        $('div.recipe-preview a').each((i, el) => {
            const $a = $(el);
            const href = $a.attr('href');
            if (!href || !href.includes('/resep')) return;

            const judul = $a.find('h2').text().trim();
            const link = 'https://cookpad.com' + href;
            const thumb = $a.find('img').attr('src');

            if (judul && link) {
                results.push({ judul, link, thumb });
            }
        });

        if (results.length === 0) {
            return { success: false, error: "Tidak ditemukan resep.", data: [] };
        }

        return { success: true, data: results };
    } catch (error) {
        console.error("Error cariresep:", error.message);
        return { success: false, error: error.message, data: [] };
    }
}

// === DETAIL RESEP DARI COOKPAD ===
async function detailresep(url) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);

        const judul = $('h1').first().text().trim() || "Tidak diketahui";
        const waktu = $('th:contains("Waktu")').next().text().trim() || "Tidak diketahui";
        const hasil = $('th:contains("Porsi")').next().text().trim() || "Tidak diketahui";
        const tingkat = $('th:contains("Tingkat kesulitan")').next().text().trim() || "Tidak diketahui";

        const bahan = [];
        $('#ingredients-list li').each((i, el) => {
            const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) bahan.push(text);
        });

        const langkah = [];
        $('#steps li').each((i, el) => {
            const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) langkah.push(`${i + 1}. ${text}`);
        });

        const thumb = $('meta[property="og:image"]').attr('content') ||
            $('img[itemprop="image"]').attr('src') ||
            null;

        return {
            success: true,
            data: {
                judul,
                waktu_masak: waktu,
                hasil,
                tingkat_kesulitan: tingkat,
                thumb,
                bahan: bahan.length > 0 ? bahan.map(b => `• ${b}`).join('\n') : 'Tidak tersedia.',
                langkah_langkah: langkah.length > 0 ? langkah.join('\n\n') : 'Tidak tersedia.',
                sumber: url
            }
        };
    } catch (error) {
        console.error("Error detailresep:", error.message);
        return { success: false, error: error.message, data: null };
    }
}

// === MENU BOT ===
function getMenu() {
    return `
🤖 *Vrox-Bot v1.2*

🔍 *Fitur Utama:*
• Kirim link → Bot ambil judul & deskripsi
• Tanya apa saja → Jawab pakai AI

🍽️ *Fitur Resep:*
• _.resepcari [nama]_ → Cari resep (contoh: _.resepcari nasi goreng_)
• _.resepid [1-10]_ → Lihat detail

📌 *Perintah Lain:*
• _.menu_ atau _.help_ → Tampilkan menu ini

💬 Dikembangkan oleh Vrox
    `.trim();
}

// === MULAI BOT ===
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const sock = makeWASocket({
        logger: P({ level: "silent" }),
        auth: state,
        browser: ["Vrox-Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            console.log("📲 Scan QR berikut:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
                : true);
            console.log("🔌 Koneksi terputus:", lastDisconnect?.error?.message);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ Bot aktif dan terhubung!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
        const args = text.split(/ +/);
        const command = args.shift()?.toLowerCase();

        if (!text) return;
        console.log("📨 Pesan masuk:", text);

        // === .menu / .help ===
        if (['menu', 'help'].includes(command)) {
            return await sock.sendMessage(from, { text: getMenu() }, { quoted: msg });
        }

        // === .resepcari ===
        if (['resepcari', 'cariresep'].includes(command)) {
            const query = args.join(' ').trim();
            if (!query) {
                return await sock.sendMessage(from, {
                    text: "❌ Masukkan nama makanan!\nContoh: _.resepcari rendang_"
                }, { quoted: msg });
            }

            await sock.sendMessage(from, { react: { text: "🕒", key: msg.key } });

            try {
                const { data: results } = await cariresep(query);
                if (!results || results.length === 0) throw new Error("Tidak ditemukan.");

                userSearchResults.set(from, results);

                let reply = `🔍 *Hasil Pencarian untuk "${query}"*\n\n`;
                results.slice(0, 10).forEach((r, i) => {
                    reply += `*${i + 1}.* ${r.judul}\n`;
                });
                reply += `\n📌 Kirim: _.resepid [1-${results.length}]_ untuk detail.`;

                await sock.sendMessage(from, { text: reply }, { quoted: msg });
                await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
            } catch (e) {
                await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                await sock.sendMessage(from, {
                    text: `❌ Tidak ditemukan resep untuk "${query}". Coba kata lain.`
                }, { quoted: msg });
            }
            return;
        }

        // === .resepid ===
        if (command === 'resepid') {
            const index = parseInt(args[0]);
            if (isNaN(index) || index < 1) {
                return await sock.sendMessage(from, {
                    text: "Gunakan: _.resepid [nomor]_ (1-10)"
                }, { quoted: msg });
            }

            const results = userSearchResults.get(from);
            if (!results) {
                return await sock.sendMessage(from, {
                    text: "Anda belum mencari resep. Gunakan _.resepcari [nama]_ dulu."
                }, { quoted: msg });
            }

            const resep = results[index - 1];
            if (!resep) {
                return await sock.sendMessage(from, {
                    text: `Nomor tidak valid. Pilih 1-${results.length}.`
                }, { quoted: msg });
            }

            await sock.sendMessage(from, { react: { text: "🕒", key: msg.key } });

            try {
                const { data: detail } = await detailresep(resep.link);
                if (!detail) throw new Error("Gagal ambil detail.");

                let caption = `*${detail.judul}*\n\n`;
                caption += `⏱️ *Waktu:* ${detail.waktu_masak}\n`;
                caption += `👥 *Porsi:* ${detail.hasil}\n`;
                caption += `⭐ *Tingkat:* ${detail.tingkat_kesulitan}\n\n`;
                caption += `*Bahan-bahan:*\n${detail.bahan}\n\n`;
                caption += `*Langkah-langkah:*\n${detail.langkah_langkah}\n\n`;
                caption += `_Sumber: Cookpad.com_`;

                if (detail.thumb) {
                    await sock.sendMessage(from, {
                        image: { url: detail.thumb },
                        caption
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: caption }, { quoted: msg });
                }

                await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
                userSearchResults.delete(from);
            } catch (e) {
                await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                await sock.sendMessage(from, {
                    text: `❌ Gagal ambil detail resep: ${e.message}`
                }, { quoted: msg });
            }
            return;
        }

        // === Preview Link ===
        if (isValidURL(text)) {
            await sock.sendMessage(from, { react: { text: "🕒", key: msg.key } });
            const info = await scrapWebsite(text);
            if (info) {
                const reply = `📲 *Informasi Link:*\n\n` +
                    `📱 Judul: ${info.title}\n` +
                    `📝 Deskripsi: ${info.description}\n` +
                    `🔗 Link: ${info.link}`;

                if (info.image) {
                    await sock.sendMessage(from, {
                        image: { url: info.image },
                        caption: reply
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                }
                await sock.sendMessage(from, { react: { text: "✅", key: msg.key } });
            } else {
                await sock.sendMessage(from, { react: { text: "❌", key: msg.key } });
                await sock.sendMessage(from, {
                    text: "❌ Tidak bisa ambil info dari link ini."
                }, { quoted: msg });
            }
            return;
        }

        // === AI Mode (Groq + LLaMA-3) ===
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama3-8b-8192",
                    messages: [
                        { role: "system", content: "Jawab dalam bahasa Indonesia dengan sopan dan jelas." },
                        { role: "user", content: text }
                    ],
                    temperature: 0.7
                })
            });

            const json = await res.json();
            const reply = json.choices[0].message.content.trim();
            await sock.sendMessage(from, {
                text: `🤖 *vrox-Bot:*\n${reply}`
            }, { quoted: msg });
        } catch (error) {
            const errMsg = error.response?.data?.error?.message || error.message;
            await sock.sendMessage(from, {
                text: `❌ Error: ${errMsg}`
            }, { quoted: msg });
        }
    });
}

startBot();
