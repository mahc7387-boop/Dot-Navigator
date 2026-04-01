import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createRequire } from "module";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { openai } from "@workspace/integrations-openai-ai-server";
import { updateJob } from "./jobs.js";

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

const audioPaths = new Map<string, string>();

export function getAudioPath(jobId: string): string | null {
  return audioPaths.get(jobId) ?? null;
}

export interface TtsVoice {
  id: string;
  name: string;
  gender: string;
}

export interface TtsModel {
  id: string;
  name: string;
  voices: TtsVoice[];
}

export const TTS_MODELS: TtsModel[] = [
  {
    id: "edge",
    name: "Microsoft Edge TTS",
    voices: [
      { id: "edge:ar-SA-ZariyahNeural", name: "زارية (عربية سعودية)", gender: "أنثى" },
      { id: "edge:ar-SA-HamedNeural", name: "حامد (عربي سعودي)", gender: "ذكر" },
      { id: "edge:ar-EG-SalmaNeural", name: "سلمى (عربية مصرية)", gender: "أنثى" },
      { id: "edge:ar-EG-ShakirNeural", name: "شاكر (عربي مصري)", gender: "ذكر" },
      { id: "edge:fr-FR-RemyMultilingualNeural", name: "Rémy (متعدد اللغات)", gender: "ذكر" },
    ],
  },
  {
    id: "google",
    name: "Google TTS",
    voices: [
      { id: "google:ar", name: "عربي", gender: "أنثى" },
    ],
  },
];

export interface ProcessOptions {
  jobId: string;
  videoUrl: string;
  startTime: number;
  voice?: string;
  speed?: number;
  duration?: number;
}

async function downloadAudioClip(
  videoUrl: string,
  startTime: number,
  outputPath: string,
  duration: number,
): Promise<void> {
  const ytDlp = require("yt-dlp-exec");

  const audioUrl: string = await ytDlp(videoUrl, {
    getUrl: true,
    format: "bestaudio/best",
    noPlaylist: true,
    noCheckCertificate: true,
  });

  const cleanUrl = audioUrl.trim().split("\n")[0];

  await execAsync(
    `ffmpeg -y -ss ${startTime} -i "${cleanUrl}" -t ${duration} -ar 16000 -ac 1 -f mp3 "${outputPath}"`,
    { maxBuffer: 1024 * 1024 * 10 },
  );
}

async function transcribeAudio(audioPath: string): Promise<string> {
  const audioFile = fs.createReadStream(audioPath) as unknown as File;
  const response = await openai.audio.transcriptions.create({
    model: "gpt-4o-mini-transcribe",
    file: audioFile,
  });
  return response.text;
}

async function translateToArabic(text: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "أنت مترجم محترف. ترجم النص التالي إلى العربية الفصحى الطبيعية. أعطِ الترجمة فقط دون أي شرح أو تعليق.",
      },
      {
        role: "user",
        content: text,
      },
    ],
  });
  return response.choices[0]?.message?.content?.trim() ?? "";
}

function buildAtempoFilter(speed: number): string | null {
  if (Math.abs(speed - 1.0) < 0.001) return null;
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2.0 + 0.001) {
    filters.push("atempo=2.0");
    remaining /= 2.0;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  return filters.join(",");
}

async function synthesizeEdgeTTS(
  text: string,
  voice: string,
  outDir: string,
  speed: number,
): Promise<string> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioFilePath } = await tts.toFile(outDir, text, { rate: speed });
  return audioFilePath;
}

async function synthesizeGoogleTTS(
  text: string,
  lang: string,
  tmpDir: string,
  speed: number,
): Promise<string> {
  const rawPath = path.join(tmpDir, "google_raw.mp3");
  const gtts = require("node-gtts")(lang);
  await new Promise<void>((resolve, reject) => {
    gtts.save(rawPath, text, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const atempoFilter = buildAtempoFilter(speed);
  if (!atempoFilter) return rawPath;

  const outputPath = path.join(tmpDir, "google_output.mp3");
  await execAsync(
    `ffmpeg -y -i "${rawPath}" -filter:a "${atempoFilter}" "${outputPath}"`,
    { maxBuffer: 1024 * 1024 * 10 },
  );
  return outputPath;
}

export async function processVideoSegment(
  options: ProcessOptions,
): Promise<void> {
  const {
    jobId,
    videoUrl,
    startTime,
    voice = "edge:ar-SA-ZariyahNeural",
    speed = 1.0,
    duration = 20,
  } = options;

  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `vtrans-${jobId.slice(0, 8)}-`),
  );

  try {
    updateJob(jobId, {
      status: "processing",
      progress: "جاري استخراج الصوت من الفيديو...",
    });

    const audioInputPath = path.join(tmpDir, "input.mp3");
    await downloadAudioClip(videoUrl, startTime, audioInputPath, duration);

    updateJob(jobId, { progress: "جاري التعرف على الكلام..." });
    const transcript = await transcribeAudio(audioInputPath);

    updateJob(jobId, { progress: "جاري الترجمة إلى العربية...", transcript });
    const translation = await translateToArabic(transcript);

    updateJob(jobId, {
      progress: "جاري تركيب الصوت العربي...",
      translation,
    });

    const colonIdx = voice.indexOf(":");
    const provider = colonIdx >= 0 ? voice.slice(0, colonIdx) : "edge";
    const voiceId = colonIdx >= 0 ? voice.slice(colonIdx + 1) : voice;

    let finalAudioPath: string;

    if (provider === "google") {
      finalAudioPath = await synthesizeGoogleTTS(
        translation,
        voiceId || "ar",
        tmpDir,
        speed,
      );
    } else {
      finalAudioPath = await synthesizeEdgeTTS(
        translation,
        voiceId || "ar-SA-ZariyahNeural",
        tmpDir,
        speed,
      );
    }

    audioPaths.set(jobId, finalAudioPath);

    updateJob(jobId, {
      status: "completed",
      progress: "اكتملت المعالجة بنجاح ✓",
      audioPath: finalAudioPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateJob(jobId, {
      status: "failed",
      progress: "فشلت المعالجة",
      error: message,
    });
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
    }
  }
}
