import { useState, useRef, useCallback, useEffect } from "react";
import Head from "next/head";

type AppState = "idle" | "listening" | "recording" | "processing" | "speaking";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const SILENCE_THRESHOLD = 0.02;
const SILENCE_DURATION_MS = 1500;
const MIN_RECORDING_MS = 500;

export default function Home() {
  const [state, setState] = useState<AppState>("idle");
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);

  const messagesRef = useRef<Message[]>([]);
  const stateRef = useRef<AppState>("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const silenceStartRef = useRef<number>(0);
  const recordingStartRef = useRef<number>(0);
  const activeRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const startListeningRef = useRef<() => void>(() => {});
  const startListeningForInterruptRef = useRef<() => void>(() => {});
  const ttsAbortRef = useRef<AbortController | null>(null);
  const audioQueueRef = useRef<Array<{ blob: Blob; text: string }>>([]);
  const isPlayingQueueRef = useRef(false);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const playAudioBlob = useCallback(
    async (blob: Blob): Promise<void> => {
      if (!activeRef.current) return;

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;

      if (activeRef.current) {
        startListeningForInterruptRef.current();
      }

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        audio.onpause = () => {
          URL.revokeObjectURL(url);
          resolve();
        };
        if (!activeRef.current) {
          URL.revokeObjectURL(url);
          resolve();
          return;
        }
        audio.play();
      });

      audioRef.current = null;
    },
    []
  );

  const playTTS = useCallback(
    async (text: string): Promise<void> => {
      if (!activeRef.current) return;

      const speakRes = await fetch("/api/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });

      if (!speakRes.ok) {
        throw new Error("Speech synthesis failed");
      }

      if (!activeRef.current) return;

      const blob = await speakRes.blob();
      if (!activeRef.current) return;

      await playAudioBlob(blob);
    },
    [playAudioBlob]
  );

  /**
   * Reads the SSE stream from /api/chat, splits text into sentences,
   * fires TTS requests per sentence, and plays audio segments sequentially.
   * Returns the full reply text.
   */
  const processStreamingResponse = useCallback(
    async (chatRes: Response): Promise<string> => {
      const abortController = new AbortController();
      ttsAbortRef.current = abortController;
      audioQueueRef.current = [];
      isPlayingQueueRef.current = false;

      const reader = chatRes.body!.getReader();
      const decoder = new TextDecoder();

      let fullReply = "";
      let sentenceBuffer = "";
      let sseBuffer = "";

      // Sentence boundary regex: ends with . ! or ? followed by space or end
      const sentenceEnd = /[.!?](?:\s|$)/;

      // Promise that resolves when all queued audio has finished playing
      let playbackFinished: Promise<void> = Promise.resolve();

      const enqueueSentence = (sentence: string) => {
        if (!sentence.trim() || !activeRef.current || abortController.signal.aborted) return;

        // Fire TTS fetch immediately
        const ttsPromise = fetch("/api/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence }),
          signal: abortController.signal,
        }).then((res) => {
          if (!res.ok) throw new Error("TTS failed");
          return res.blob();
        });

        // Chain playback: each segment waits for the previous one
        playbackFinished = playbackFinished.then(async () => {
          if (!activeRef.current || abortController.signal.aborted) return;
          try {
            const blob = await ttsPromise;
            if (!activeRef.current || abortController.signal.aborted) return;
            setState("speaking");
            await playAudioBlob(blob);
          } catch {
            // Aborted or failed — skip
          }
        });
      };

      // Read SSE stream
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          sseBuffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = sseBuffer.split("\n");
          // Keep the last potentially incomplete line in the buffer
          sseBuffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            const jsonStr = line.slice(6);
            let event: { delta?: string; done?: boolean; reply?: string; error?: string };
            try {
              event = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            if (event.error) {
              throw new Error(event.error);
            }

            if (event.delta) {
              fullReply += event.delta;
              sentenceBuffer += event.delta;

              // Check for sentence boundaries
              let match: RegExpExecArray | null;
              while ((match = sentenceEnd.exec(sentenceBuffer)) !== null) {
                const endIndex = match.index + match[0].length;
                const sentence = sentenceBuffer.slice(0, endIndex).trim();
                sentenceBuffer = sentenceBuffer.slice(endIndex);
                enqueueSentence(sentence);
              }
            }

            if (event.done) {
              // Use the full reply from the done event if provided
              if (event.reply) {
                fullReply = event.reply;
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // Flush any remaining text in the buffer as the last sentence
      if (sentenceBuffer.trim()) {
        enqueueSentence(sentenceBuffer.trim());
        sentenceBuffer = "";
      }

      // Wait for all audio segments to finish playing
      await playbackFinished;

      ttsAbortRef.current = null;
      return fullReply;
    },
    [playAudioBlob]
  );

  const processAudio = useCallback(async (audioBlob: Blob) => {
    setState("processing");
    setError(null);

    try {
      // Step 1: Transcribe
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");

      const transcribeRes = await fetch("/api/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!transcribeRes.ok) {
        const err = await transcribeRes.json();
        throw new Error(err.error || "Transcription failed");
      }

      if (!activeRef.current) return;

      const { text } = await transcribeRes.json();
      const userMessage: Message = { role: "user", content: text };
      setMessages((prev) => [...prev, userMessage]);

      // Step 2: Stream chat response with sentence-level TTS
      const currentHistory = [...messagesRef.current, userMessage];
      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history: currentHistory }),
      });

      if (!activeRef.current) return;

      if (!chatRes.ok) {
        // Non-SSE error response
        const err = await chatRes.json();
        throw new Error(err.error || "Chat request failed");
      }

      const reply = await processStreamingResponse(chatRes);

      const assistantMessage: Message = {
        role: "assistant",
        content: reply,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // If we weren't interrupted, resume normal listening
      if (activeRef.current && stateRef.current === "speaking") {
        startListening();
      } else if (!activeRef.current) {
        setState("idle");
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setError(message);
      if (activeRef.current) {
        startListening();
      } else {
        setState("idle");
      }
    }
  }, [playTTS, processStreamingResponse]);

  const stopAudioPlayback = useCallback(() => {
    // Abort any pending TTS fetches
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    audioQueueRef.current = [];

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, []);

  const startListeningForInterrupt = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.fftSize);

    const monitor = () => {
      if (!activeRef.current || stateRef.current !== "speaking") return;

      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Interrupt immediately when voice is detected above threshold
      if (rms > SILENCE_THRESHOLD * 3) {
        // User is interrupting — stop audio immediately and start recording
        stopAudioPlayback();

        // Stop any existing recorder
        if (mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
        }

        startListeningRef.current();
        return;
      }

      animFrameRef.current = requestAnimationFrame(monitor);
    };

    animFrameRef.current = requestAnimationFrame(monitor);
  }, [stopAudioPlayback]);

  const startListening = useCallback(() => {
    const stream = streamRef.current;
    const analyser = analyserRef.current;
    if (!stream || !analyser) return;

    setState("listening");
    silenceStartRef.current = 0;
    recordingStartRef.current = 0;
    chunksRef.current = [];

    const mediaRecorder = new MediaRecorder(stream);
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    mediaRecorder.onstop = () => {
      if (!activeRef.current) return;
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      if (blob.size > 0) {
        processAudio(blob);
      } else if (activeRef.current) {
        startListening();
      }
    };

    mediaRecorder.start(250); // collect data in 250ms chunks

    const dataArray = new Uint8Array(analyser.fftSize);

    const monitor = () => {
      if (!activeRef.current) return;

      analyser.getByteTimeDomainData(dataArray);

      // Calculate RMS level
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length);
      setAudioLevel(rms);

      const now = Date.now();
      const currentState = stateRef.current;

      if (currentState === "listening" && rms > SILENCE_THRESHOLD) {
        // Speech detected — start recording
        setState("recording");
        recordingStartRef.current = now;
        silenceStartRef.current = 0;
      } else if (currentState === "recording") {
        if (rms > SILENCE_THRESHOLD) {
          silenceStartRef.current = 0;
        } else {
          if (silenceStartRef.current === 0) {
            silenceStartRef.current = now;
          }
          const elapsed = now - recordingStartRef.current;
          const silentFor = now - silenceStartRef.current;

          if (elapsed >= MIN_RECORDING_MS && silentFor >= SILENCE_DURATION_MS) {
            // End of speech — stop recording and process
            if (mediaRecorderRef.current?.state === "recording") {
              mediaRecorderRef.current.stop();
            }
            return; // stop monitoring
          }
        }
      }

      animFrameRef.current = requestAnimationFrame(monitor);
    };

    animFrameRef.current = requestAnimationFrame(monitor);
  }, [processAudio]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  useEffect(() => {
    startListeningForInterruptRef.current = startListeningForInterrupt;
  }, [startListeningForInterrupt]);

  const startSession = useCallback(async () => {
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;

      activeRef.current = true;
      startListening();
    } catch {
      setError(
        "Microphone access denied. Please allow microphone permissions and try again."
      );
    }
  }, [startListening]);

  const stopSession = useCallback(() => {
    activeRef.current = false;
    cancelAnimationFrame(animFrameRef.current);

    // Abort pending TTS fetches
    if (ttsAbortRef.current) {
      ttsAbortRef.current.abort();
      ttsAbortRef.current = null;
    }
    audioQueueRef.current = [];

    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }

    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;

    setAudioLevel(0);
    setState("idle");
  }, []);

  const stateLabel: Record<AppState, string> = {
    idle: "Start Conversation",
    listening: "Listening...",
    recording: "Recording...",
    processing: "Thinking...",
    speaking: "Speaking...",
  };

  const stateHint: Record<AppState, string> = {
    idle: "Press to begin",
    listening: "Waiting for you to speak",
    recording: "Speak naturally — pausing will send",
    processing: "Processing your message...",
    speaking: "Playing response — speak to interrupt",
  };

  const isActive = state !== "idle";

  // Audio level ring scale (0 to ~1.2 for visual pop)
  const ringScale = isActive ? 1 + audioLevel * 6 : 1;

  return (
    <>
      <Head>
        <title>Voice Assistant</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
        {/* Header */}
        <header className="border-b border-gray-800 px-6 py-4">
          <h1 className="text-xl font-semibold text-center">
            Voice Assistant
          </h1>
        </header>

        {/* Transcript */}
        <main className="flex-1 overflow-y-auto px-4 py-6 max-w-2xl mx-auto w-full">
          {messages.length === 0 && (
            <p className="text-gray-500 text-center mt-20">
              Press the button below to start a conversation.
            </p>
          )}

          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    msg.role === "user"
                      ? "bg-blue-600 text-white rounded-br-md"
                      : "bg-gray-800 text-gray-100 rounded-bl-md"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </main>

        {/* Error banner */}
        {error && (
          <div className="mb-2 max-w-2xl mx-auto w-full px-4">
            <div className="bg-red-900/60 border border-red-700 text-red-200 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          </div>
        )}

        {/* Controls */}
        <footer className="border-t border-gray-800 px-6 py-6 flex flex-col items-center gap-3">
          <div className="relative flex items-center justify-center">
            {/* Audio level ring */}
            <div
              className={`absolute w-32 h-32 rounded-full transition-transform duration-100 ${
                state === "recording"
                  ? "bg-red-500/20 border-2 border-red-500/40"
                  : state === "listening"
                    ? "bg-blue-500/10 border-2 border-blue-500/20"
                    : "border-2 border-transparent"
              }`}
              style={{ transform: `scale(${ringScale})` }}
            />

            <button
              onClick={isActive ? stopSession : startSession}
              className={`relative z-10 w-28 h-28 rounded-full text-white font-medium text-sm transition-all select-none ${
                isActive
                  ? "bg-red-600 hover:bg-red-700"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {isActive ? "Stop" : stateLabel.idle}
            </button>
          </div>

          <p className="text-xs text-gray-500">{stateHint[state]}</p>
        </footer>
      </div>
    </>
  );
}
