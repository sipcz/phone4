import express from "express";
import { WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Віддаємо файли з папки public
app.use(express.static(path.join(__dirname, "public")));

// Головна сторінка
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const server = app.listen(process.env.PORT || 3000, () => {
    console.log("🚀 Військова база запущена на порту " + (process.env.PORT || 3000));
});

const wss = new WebSocketServer({ server });
const clients = new Map(); // Сховище: Номер -> WebSocket

wss.on("connection", (ws) => {
    ws.isAlive = true;
    
    // Функція для підтвердження, що клієнт ще в мережі
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
        try {
            const data = JSON.parse(raw);

            // 1. РЕЄСТРАЦІЯ АБО ВІДНОВЛЕННЯ НОМЕРА
            if (data.type === "register") {
                let num = data.number;
                
                // Якщо номер вже зайнятий іншим активним пристроєм — даємо новий випадковий
                if (!num || (clients.has(num) && clients.get(num) !== ws)) {
                    num = String(Math.floor(100000 + Math.random() * 900000));
                }
                
                ws.number = num;
                clients.set(num, ws);
                
                console.log(`📡 Абонент ${num} в мережі`);
                ws.send(JSON.stringify({ type: "your_number", number: num }));
                return;
            }

            // 2. ПІНГ (щоб Render не обривав зв'язок)
            if (data.type === "ping") {
                ws.isAlive = true;
                return;
            }

            // 3. ПЕРЕСИЛКА СИГНАЛІВ (Виклики, Оффери, ICE, Чат)
            if (data.to) {
                const target = clients.get(data.to);
                if (target && target.readyState === 1) { // 1 = OPEN
                    target.send(JSON.stringify({
                        ...data,
                        from: ws.number // Завжди додаємо, від кого прийшло
                    }));
                } else {
                    // Якщо абонент не знайдений, повідомляємо відправника
                    ws.send(JSON.stringify({ type: "error", message: "Абонент поза зоною досяжності" }));
                }
            }

        } catch (err) {
            console.error("❌ Помилка обробки даних:", err);
        }
    });

    // Очищення при виході
    ws.on("close", () => {
        if (ws.number) {
            console.log(`🔌 Абонент ${ws.number} вийшов з мережі`);
            clients.delete(ws.number);
        }
    });

    ws.on("error", (err) => {
        console.error("⚠️ Помилка сокета:", err);
        if (ws.number) clients.delete(ws.number);
    });
});

// АНТИ-СОН: Перевірка зв'язку кожні 30 секунд
// Render не розірве з'єднання, поки йдуть ці перевірки
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            clients.delete(ws.number);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping(); // Посилаємо пінг клієнту
    });
}, 30000);

wss.on("close", () => {
    clearInterval(interval);
});
