// bot.js
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fetch = require("node-fetch");
const cheerio = require("cheerio");
const P = require("pino");
const qrcode = require("qrcode-terminal");

// === Gunakan API key langsung ===
const API_KEY = "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";

// === Cache pencarian resep per user ===
const userSearchResults = new Map();

// === Cek URL valid ===
function isValidURL(str) {
    try {
        new URL(str);
        return true;
    } catch (_) {
        return false;
    }
}

// === Scrap info dari link (judul, deskripsi) ===
async function scrapWebsite(url) {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);

        const title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Tidak ada judul';
        const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'Tidak ada deskripsi.';
        const image = $('meta[property="og:image"]').attr('content') || null;

        return {
            title: title.trim(),
            description: description.trim(),
            link: url,
            image: image ? (image.startsWith('http') ? image : `https:${image}`) : null
        };
    } catch (err) {
        return null;
    }
}

// === CARI RESEP DI MASAKAPAHARIINI.COM ===
async function cariresep(query) {
    try {
        const url = `https://www.masakapahariini.com/?s=${encodeURIComponent(query)}`;
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);
        const results = [];

        $('.content-card a').each((i, el) => {
            const $el = $(el);
            const judul = $el.find('h3').text().trim();
            const link = $el.attr('href');
            const thumb = $el.find('img').attr('data-src') || $el.find('img').attr('src');

            if (judul && link && link.includes('https://www.masakapahariini.com/resep/')) {
                results.push({ judul, link, thumb });
            }
        });

        if (results.length === 0) {
            return { success: false, error: "Tidak ada hasil ditemukan.",  [] };
        }

        return { success: true,  results };
    } catch (error) {
        return { success: false, error: error.message,  [] };
    }
}

// === DETAIL RESEP DARI MASAKAPAHARIINI.COM ===
async function detailresep(url) {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 10000
        });
        const data = await res.text();
        const $ = cheerio.load(data);

        const judul = $('h1').first().text().trim() || "Tidak diketahui";
        const waktu = $('.recipe-meta-time span').text().trim() || "Tidak diketahui";
        const hasil = $('.recipe-meta-serves span').text().trim() || "Tidak diketahui";
        const tingkat = $('.recipe-meta-difficulty span').text().trim() || "Tidak diketahui";

        const bahan = [];
        $('.ingredient-list li').each((i, el) => {
            const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) bahan.push(text);
        });

        const langkah = [];
        $('.instruction-list li').each((i, el) => {
            const text = $(el).text().replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            if (text) langkah.push(`${i + 1}. ${text}`);
        });

        const thumb = $('meta[property="og:image"]').attr('content') ||
            $('.recipe-image img').attr('data-src') ||
            $('.recipe-image img').attr('src') ||
            null;

        return {
            success: true,
             {
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
        return { success: false, error: error.message,  null };
    }
}

// === MENU BOT ===
function getMenu() {
    return `
🤖 *Vrox-Bot*

🍽️ Fitur:
• Kirim link → Dapat info
• .resepcari [nama] → Cari resep
• .resepid [nomor] → Lihat detail
• .menu → Tampilkan ini
    `.trim();
}

// === MULAI BOT ===
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth");

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
            console.log("🔌 Terputus:", lastDisconnect?.error?.message);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ Bot aktif!");
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

        // === .menu ===
        if (command === 'menu') {
            return await sock.sendMessage(from, { text: getMenu() }, { quoted: msg });
        }

        // === .resepcari ===
        if (command === 'resepcari') {
            const query = args.join(' ').trim();
            if (!query) return await sock.sendMessage(from, {
                text: "❌ Masukkan nama makanan!\nContoh: .resepcari rendang"
            }, { quoted: msg });

            try {
                const { data: results } = await cariresep(query);
                if (!results.length) throw new Error();

                userSearchResults.set(from, results);

                let reply = `🔍 *Hasil untuk "${query}"*\n\n`;
                results.forEach((r, i) => reply += `*${i+1}.* ${r.judul}\n`);
                reply += `\n📌 .resepid [1-${results.length}]`;

                await sock.sendMessage(from, { text: reply }, { quoted: msg });
            } catch {
                await sock.sendMessage(from, {
                    text: `❌ Tidak ditemukan resep untuk "${query}".`
                }, { quoted: msg });
            }
            return;
        }

        // === .resepid ===
        if (command === 'resepid') {
            const index = parseInt(args[0]);
            const results = userSearchResults.get(from);
            if (!results || !index || index < 1 || index > results.length) {
                return await sock.sendMessage(from, {
                    text: "Gunakan: .resepid [1-10]"
                }, { quoted: msg });
            }

            try {
                const {  detail } = await detailresep(results[index - 1].link);
                if (!detail) throw new Error();

                let caption = `*${detail.judul}*\n\n⏱️ ${detail.waktu_masak} | 👥 ${detail.hasil} | ⭐ ${detail.tingkat_kesulitan}\n\n`;
                caption += `*Bahan:*\n${detail.bahan}\n\n*Langkah:*\n${detail.langkah_langkah}\n\n_Sumber: masakapahariini.com_`;

                if (detail.thumb) {
                    await sock.sendMessage(from, {
                        image: { url: detail.thumb },
                        caption
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: caption }, { quoted: msg });
                }
                userSearchResults.delete(from);
            } catch (e) {
                await sock.sendMessage(from, {
                    text: `❌ Gagal: ${e.message}`
                }, { quoted: msg });
            }
            return;
        }

        // === Preview Link ===
        if (isValidURL(text)) {
            const info = await scrapWebsite(text);
            if (info) {
                const reply = `📲 *Info Link:*\n\n` +
                    `📱 ${info.title}\n` +
                    `📝 ${info.description}\n` +
                    `🔗 ${info.link}`;

                if (info.image) {
                    await sock.sendMessage(from, {
                        image: { url: info.image },
                        caption: reply
                    }, { quoted: msg });
                } else {
                    await sock.sendMessage(from, { text: reply }, { quoted: msg });
                }
            }
            return;
        }

        // === AI Mode ===
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
                        { role: "system", content: "Jawab dalam bahasa Indonesia." },
                        { role: "user", content: text }
                    ],
                    temperature: 0.7
                })
            });

            const json = await res.json();
            const reply = json.choices[0].message.content.trim();
            await sock.sendMessage(from, {
                text: `🤖 *AI:* ${reply}`
            }, { quoted: msg });
        } catch (e) {
            await sock.sendMessage(from, {
                text: "❌ AI error."
            }, { quoted: msg });
        }
    });
}

startBot();
