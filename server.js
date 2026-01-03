import express from "express";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const WORKDIR = "/tmp";
const PUBLIC_DIR = path.join(WORKDIR, "public");
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

const {
  TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET,
  TIKTOK_REDIRECT_URI,
  TIKTOK_REFRESH_TOKEN,
  PUBLIC_BASE_URL,
  VIDEO_TTL_SECONDS,
} = process.env;

const ttlSeconds = Number(VIDEO_TTL_SECONDS || 7200);

function baseUrl(req) {
  const envBase = (PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").toString().split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function scheduleDelete(filePath) {
  const ms = Math.max(10, ttlSeconds) * 1000;
  setTimeout(() => {
    fs.unlink(filePath, () => {});
  }, ms);
}

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/auth/tiktok/start", (req, res) => {
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_REDIRECT_URI) {
    return res.status(400).send("Missing TIKTOK_CLIENT_KEY or TIKTOK_REDIRECT_URI");
  }

  const scope = ["user.info.basic", "video.upload", "video.publish"].join(",");
  const state = crypto.randomBytes(16).toString("hex");

  const url =
    "https://www.tiktok.com/v2/auth/authorize/?" +
    new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      scope,
      response_type: "code",
      redirect_uri: TIKTOK_REDIRECT_URI,
      state,
    }).toString();

  res.redirect(url);
});

app.get("/auth/tiktok/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET || !TIKTOK_REDIRECT_URI) {
    return res.status(400).send("Missing TikTok credentials env vars");
  }

  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      code: String(code),
      grant_type: "authorization_code",
      redirect_uri: TIKTOK_REDIRECT_URI,
    }).toString(),
  });

  const data = await r.json();

  res.type("text/plain").send(
    [
      "TikTok connected.",
      "",
      "Copy this refresh token and save it in Railway as ENV var TIKTOK_REFRESH_TOKEN:",
      "",
      data?.refresh_token || JSON.stringify(data, null, 2),
    ].join("\n")
  );
});

app.get("/tiktok/access-token", async (req, res) => {
  if (!TIKTOK_REFRESH_TOKEN) {
    return res.status(400).json({ error: "Missing TIKTOK_REFRESH_TOKEN" });
  }
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) {
    return res.status(400).json({ error: "Missing TikTok client env vars" });
  }

  const r = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: TIKTOK_CLIENT_KEY,
      client_secret: TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: TIKTOK_REFRESH_TOKEN,
    }).toString(),
  });

  const data = await r.json();
  res.json(data);
});

app.post("/render", async (req, res) => {
  try {
    const top = (req.body?.top_text || "").toString().trim();
    const bottom = (req.body?.bottom_text || "").toString().trim();

    if (!top || !bottom) {
      return res.status(400).json({ error: "top_text and bottom_text are required" });
    }

    const bgPath = path.join(process.cwd(), "background.mp4");
    const fontPath = path.join(process.cwd(), "font.ttf");

    if (!fs.existsSync(bgPath)) return res.status(500).json({ error: "background.mp4 missing" });
    if (!fs.existsSync(fontPath)) return res.status(500).json({ error: "font.ttf missing" });

    const id = crypto.randomBytes(8).toString("hex");
    const outFile = `out_${id}.mp4`;
    const outPath = path.join(PUBLIC_DIR, outFile);

    const esc = (s) =>
      s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/\n/g, " ");

    const topEsc = esc(top);
    const bottomEsc = esc(bottom);

    const vf =
      `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
      `drawtext=fontfile=${fontPath}:text='${topEsc}':x=(w-text_w)/2:y=180:` +
      `fontsize=72:fontcolor=white:borderw=6:bordercolor=black,` +
      `drawtext=fontfile=${fontPath}:text='${bottomEsc}':x=(w-text_w)/2:y=h-260:` +
      `fontsize=72:fontcolor=white:borderw=6:bordercolor=black`;

    const args = [
      "-y",
      "-stream_loop", "-1",
      "-i", bgPath,
      "-t", "8",
      "-vf", vf,
      "-r", "30",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath
    ];

    execFile("ffmpeg", args, (error) => {
      if (error) {
        return res.status(500).json({ error: "ffmpeg failed", detail: error.message });
      }

      scheduleDelete(outPath);

      const fullUrl = `${baseUrl(req)}/public/${outFile}`;
      return res.json({ video_url: fullUrl, expires_in_seconds: ttlSeconds });
    });
  } catch (e) {
    return res.status(500).json({ error: "server error", detail: e.message });
  }
});

app.use("/public", express.static(PUBLIC_DIR));

app.listen(PORT, () => console.log(`Renderer running on ${PORT}`));
