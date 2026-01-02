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

app.get("/", (req, res) => res.json({ ok: true }));

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
      return res.json({ video_url: `/public/${outFile}` });
    });
  } catch (e) {
    return res.status(500).json({ error: "server error", detail: e.message });
  }
});

app.use("/public", express.static(PUBLIC_DIR));
app.listen(PORT, () => console.log(`Renderer running on ${PORT}`));
