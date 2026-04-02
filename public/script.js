let pass = "", ws = null, pc = null, dc = null, stream = null, remoteNum = null;
let cryptoKey = null, iceQueue = [], isMuted = false;
let incomingFile = { chunks: [], total: 0 };
let pendingOffer = null;

const ringtone = new Audio('ringtone.mp3'); 
ringtone.loop = true;
const servers = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

// UI REFS
const statusDiv = document.getElementById("status");
const chatArea = document.getElementById("chatMessages");
const progDiv = document.getElementById("fileProgress");
const progBar = document.getElementById("progBar");
const progText = document.getElementById("progText");

function scrollToBottom() {
    chatArea.scrollTop = chatArea.scrollHeight;
    setTimeout(() => { chatArea.scrollTop = chatArea.scrollHeight; }, 100);
}

// --- СИСТЕМА ВХОДУ ---
document.getElementById("startBtn").onclick = () => {
    const pInp = document.getElementById("passInput");
    pass = pInp.value;
    if (pass.length < 4) return alert("KEY TOO SHORT");
    pInp.value = "";
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("mainApp").classList.remove("hidden");
    initWS();
};

async function getK() {
    if (cryptoKey) return cryptoKey;
    const enc = new TextEncoder();
    const b = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    cryptoKey = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: enc.encode("DRESDEN_V16_STABLE"), iterations: 100000, hash: "SHA-256" },
        b, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
    return cryptoKey;
}

async function encrypt(d) {
    const k = await getK(), iv = crypto.getRandomValues(new Uint8Array(12));
    const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode(JSON.stringify(d)));
    return { iv: Array.from(iv), data: Array.from(new Uint8Array(c)) };
}

async function decrypt(ed) {
    try { const k = await getK(); const d = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ed.iv) }, k, new Uint8Array(ed.data)); return JSON.parse(new TextDecoder().decode(d)); } catch (e) { return null; }
}

// --- ДЕТЕКТОР ЗАКРИТТЯ ВКЛАДКИ ---
window.onbeforeunload = () => {
    if (ws && ws.readyState === 1 && remoteNum) {
        // Останній сигнал серверу перед виходом
        ws.send(JSON.stringify({ type: "hangup", to: remoteNum }));
    }
};

// --- МЕРЕЖА ---
function initWS() {
    ws = new WebSocket("wss://phone4.onrender.com");
    ws.onopen = () => ws.send(JSON.stringify({type: "register", number: localStorage.getItem("my_id")}));
    ws.onclose = () => setTimeout(initWS, 3000);
    ws.onmessage = async (e) => {
        let d = JSON.parse(e.data);
        if (d.payload) { const r = await decrypt(d.payload); if (r) d = { ...d, ...r }; else return; }
        switch(d.type) {
            case "your_number":
                localStorage.setItem("my_id", d.number);
                document.getElementById("myNum").textContent = d.number;
                statusDiv.textContent = "ONLINE"; break;
            case "call":
                remoteNum = d.from;
                document.getElementById("callerId").textContent = d.from;
                document.getElementById("incomingUI").classList.remove("hidden");
                ringtone.play().catch(()=>{}); break;
            case "offer": pendingOffer = d.offer; remoteNum = d.from; break;
            case "answer": if (pc) await pc.setRemoteDescription(new RTCSessionDescription(d.answer)); break;
            case "ice": if (pc && pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(d.cand)).catch(()=>{}); else iceQueue.push(d.cand); break;
            case "hangup": 
                // Якщо напарник натиснув "Terminate" або закрив вкладку
                location.reload(); 
                break;
        }
    };
}

// --- ВІЗУАЛІЗАЦІЯ ---
function startViz(s, id) {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = ctx.createAnalyser(); ctx.createMediaStreamSource(s).connect(analyser); analyser.fftSize = 32;
        const data = new Uint8Array(analyser.frequencyBinCount); const canv = document.getElementById(id); const cctx = canv.getContext("2d");
        function draw() { if (!pc || pc.iceConnectionState === "closed") return; requestAnimationFrame(draw); analyser.getByteFrequencyData(data); cctx.fillStyle = "#000"; cctx.fillRect(0,0,canv.width,canv.height); data.forEach((v, i) => { cctx.fillStyle = "#39FF14"; cctx.fillRect(i*10, canv.height - v/5, 6, v/5); }); } draw();
    } catch(e) {}
}

// --- WebRTC ТУНЕЛЬ ---
async function initPC() {
    pc = new RTCPeerConnection(servers);
    
    pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        statusDiv.textContent = state.toUpperCase();
        // ЯКЩО ЗВ'ЯЗОК ОБІРВАВСЯ (наприклад, зник інтернет або телефон вимкнувся)
        if (state === "failed" || state === "disconnected") {
            document.getElementById("lostLinkUI").classList.remove("hidden");
            ringtone.pause();
        }
    };

    pc.onicecandidate = async (e) => { if (e.candidate) ws.send(JSON.stringify({ type: "ice", to: remoteNum, payload: await encrypt({ cand: e.candidate }) })); };
    pc.ontrack = (e) => { document.getElementById("audio").srcObject = e.streams[0]; startViz(e.streams[0], "remoteViz"); };
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => pc.addTrack(t, stream)); startViz(stream, "localViz");
}

// --- ЛОГІКА ВИКЛИКІВ ---
document.getElementById("callBtn").onclick = async () => {
    const tNum = document.getElementById("targetNum").value;
    if (!tNum || tNum === localStorage.getItem("my_id")) return alert("SELF-DIAL ERROR");
    remoteNum = tNum; statusDiv.textContent = "DIALING...";
    ws.send(JSON.stringify({type: "call", to: remoteNum}));
    await initPC();
    dc = pc.createDataChannel("secureData"); setupDC(dc);
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: "offer", to: remoteNum, payload: await encrypt({ offer }) }));
};

document.getElementById("acceptBtn").onclick = async () => {
    ringtone.pause(); document.getElementById("incomingUI").classList.add("hidden");
    if (pendingOffer) {
        await initPC(); pc.ondatachannel = (e) => setupDC(e.channel);
        await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: "answer", to: remoteNum, payload: await encrypt({ answer }) }));
        iceQueue.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{})); iceQueue = [];
    }
};

function syncHangup() {
    if (ws && ws.readyState === 1 && remoteNum) ws.send(JSON.stringify({ type: "hangup", to: remoteNum }));
    ringtone.pause();
    setTimeout(() => location.reload(), 200);
}

document.getElementById("hangBtn").onclick = syncHangup;
document.getElementById("declineBtn").onclick = syncHangup;

function setupDC(channel) {
    dc = channel;
    dc.onopen = () => { document.getElementById("vizContainer").classList.remove("hidden"); document.getElementById("dialerUI").classList.add("hidden"); document.getElementById("activeCallUI").classList.remove("hidden"); scrollToBottom(); };
    dc.onmessage = async (e) => {
        const d = await decrypt(JSON.parse(e.data)); if (!d) return;
        if (d.type === "msg") appendMsg(d.txt, "peer");
        if (d.type === "file-start") { incomingFile = { chunks: [], total: d.total }; progDiv.classList.remove("hidden"); }
        if (d.type === "file-chunk") {
            incomingFile.chunks.push(d.data);
            let p = Math.round((incomingFile.chunks.length/incomingFile.total)*100);
            progBar.style.width = p+"%"; progText.textContent = "RCV: "+p+"%";
            if (incomingFile.chunks.length === incomingFile.total) { appendImg(incomingFile.chunks.join(''), "peer"); progDiv.classList.add("hidden"); }
        }
    };
}

// --- ЧАТ Dresden ---
function appendMsg(t, cls) { const d = document.createElement("div"); d.className = `msg ${cls}`; d.textContent = t; chatArea.appendChild(d); scrollToBottom(); }
function appendImg(data, cls) { const d = document.createElement("div"); d.className = `msg ${cls}`; const img = new Image(); img.src = data; img.className = "chat-img"; img.onload = scrollToBottom; d.appendChild(img); chatArea.appendChild(d); }

document.getElementById("sendBtn").onclick = async () => {
    const txt = document.getElementById("msgInput").value; if (!txt || !dc || dc.readyState !== "open") return;
    dc.send(JSON.stringify(await encrypt({ type: "msg", txt }))); appendMsg(txt, "self"); document.getElementById("msgInput").value = "";
};

// --- ФОТО (AUTO RESIZE + CLEAN EXIF) ---
document.getElementById("photoBtn").onclick = () => document.getElementById("fileInp").click();
document.getElementById("fileInp").onchange = (e) => {
    const file = e.target.files[0]; if (!file || !dc) return;
    progDiv.classList.remove("hidden");
    const reader = new FileReader(); reader.onload = (ev) => {
        const img = new Image(); img.onload = async () => {
            const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d"); const MAX = 1280;
            let w = img.width, h = img.height; if (w > h && w > MAX) { h *= MAX/w; w = MAX; } else if (h > MAX) { w *= MAX/h; h = MAX; }
            canvas.width = w; canvas.height = h; ctx.drawImage(img, 0, 0, w, h);
            const cleanData = canvas.toDataURL("image/jpeg", 0.7); const CHUNK = 16384; const total = Math.ceil(cleanData.length / CHUNK);
            dc.send(JSON.stringify(await encrypt({ type: "file-start", total })));
            for (let i = 0; i < total; i++) {
                while (dc.bufferedAmount > 65536) await new Promise(r => setTimeout(r, 40));
                dc.send(JSON.stringify(await encrypt({ type: "file-chunk", data: cleanData.slice(i*CHUNK, (i+1)*CHUNK) })));
                let p = Math.round(((i + 1) / total) * 100); progBar.style.width = p + "%"; progText.textContent = `SEND: ${p}%`;
            }
            appendImg(cleanData, "self"); progDiv.classList.add("hidden"); e.target.value = "";
        }; img.src = ev.target.result;
    }; reader.readAsDataURL(file);
};

document.getElementById("muteBtn").onclick = function() {
    isMuted = !isMuted; if (stream) stream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    this.textContent = isMuted ? "🎙 MIC: OFF" : "🎙 MIC: ON"; this.classList.toggle("off", isMuted);
};
