import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI, { toFile } from "openai";
import { IncomingForm, File } from "formidable";
import fs from "fs";

export const config = {
  api: { bodyParser: false },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const form = new IncomingForm({ keepExtensions: true });
    const { files } = await new Promise<{ files: Record<string, File[]> }>(
      (resolve, reject) => {
        form.parse(req, (err, _fields, files) => {
          if (err) reject(err);
          else resolve({ files: files as Record<string, File[]> });
        });
      }
    );

    const audioFile = files.audio?.[0];
    if (!audioFile) {
      return res.status(400).json({ error: "No audio file provided" });
    }

    const buffer = fs.readFileSync(audioFile.filepath);
    fs.unlinkSync(audioFile.filepath);

    const file = await toFile(buffer, "recording.webm", { type: "audio/webm" });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });

    return res.status(200).json({ text: transcription.text });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Transcription failed";
    return res.status(500).json({ error: message });
  }
}
