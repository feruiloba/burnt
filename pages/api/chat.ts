import type { NextApiRequest, NextApiResponse } from "next";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import nylas, { GRANT_ID } from "@/lib/nylas";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MAX_TOOL_ITERATIONS = 5;

// --- Tool definitions ---
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "search_emails",
      description:
        "Search the user's email inbox by query string. Supports searching by sender, subject, keywords, etc. Returns a summary list of matching emails.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query (sender name, subject keywords, etc.)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_email",
      description:
        "Fetch the full content of a specific email by its message ID. Returns the email body and attachment metadata (filenames, types, sizes). Use this after search_emails to read a specific message.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "The ID of the email message to read",
          },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_attachment",
      description:
        "Download and extract content from an email attachment. Supports text files, CSVs, PDFs, and images. Use this when the user asks about the contents of an attachment.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "The ID of the email message the attachment belongs to",
          },
          attachment_id: {
            type: "string",
            description: "The ID of the attachment to read",
          },
        },
        required: ["message_id", "attachment_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description:
        "Compose and send a new email. Only call this after the user has verbally confirmed the draft.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "Recipient email address",
          },
          subject: {
            type: "string",
            description: "Email subject line",
          },
          body: {
            type: "string",
            description: "Email body text",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_email",
      description:
        "Reply to an existing email by message ID. Only call this after the user has verbally confirmed the draft.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "The ID of the email message to reply to",
          },
          body: {
            type: "string",
            description: "Reply body text",
          },
        },
        required: ["message_id", "body"],
      },
    },
  },
];

// --- Tool handlers ---

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function handleSearchEmails(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number) || 5;

  const response = await nylas.messages.list({
    identifier: GRANT_ID,
    queryParams: {
      searchQueryNative: query,
      limit,
    },
  });

  const messages = response.data;

  if (messages.length === 0) {
    return `No emails found matching "${query}".`;
  }

  const results = messages.map((msg) => {
    const from = msg.from?.map((f) => f.name || f.email).join(", ") ?? "Unknown";
    const date = new Date(msg.date * 1000).toLocaleString();
    const attachmentCount = msg.attachments?.filter((a) => !a.isInline).length ?? 0;

    return [
      `ID: ${msg.id}`,
      `From: ${from}`,
      `Subject: ${msg.subject ?? "(no subject)"}`,
      `Date: ${date}`,
      `Snippet: ${msg.snippet ?? ""}`,
      attachmentCount > 0 ? `Attachments: ${attachmentCount}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  });

  return results.join("\n---\n");
}

async function handleReadEmail(args: Record<string, unknown>): Promise<string> {
  const messageId = args.message_id as string;

  const response = await nylas.messages.find({
    identifier: GRANT_ID,
    messageId,
  });

  const msg = response.data;
  const from = msg.from?.map((f) => `${f.name ?? ""} <${f.email}>`).join(", ") ?? "Unknown";
  const to = msg.to?.map((t) => `${t.name ?? ""} <${t.email}>`).join(", ") ?? "";
  const date = new Date(msg.date * 1000).toLocaleString();

  const body = msg.body ? stripHtml(msg.body) : "(no body)";
  // Truncate very long bodies to keep within token limits
  const truncatedBody = body.length > 3000 ? body.slice(0, 3000) + "... [truncated]" : body;

  const attachments = msg.attachments
    ?.filter((a) => !a.isInline)
    .map((a) => {
      const size = a.size ? `${Math.round(a.size / 1024)} KB` : "unknown size";
      return `- ${a.filename} (${a.contentType}, ${size}, attachment_id: ${a.id})`;
    }) ?? [];

  const parts = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${msg.subject ?? "(no subject)"}`,
    `Date: ${date}`,
    "",
    truncatedBody,
  ];

  if (attachments.length > 0) {
    parts.push("", `Attachments (${attachments.length}):`, ...attachments);
  }

  return parts.join("\n");
}

const MAX_TEXT_LENGTH = 4000;

function truncateText(text: string): string {
  return text.length > MAX_TEXT_LENGTH
    ? text.slice(0, MAX_TEXT_LENGTH) + "... [truncated]"
    : text;
}

function isTextType(contentType: string, filename: string): boolean {
  const textPrefixes = ["text/"];
  const textMimes = ["application/json", "application/xml"];
  const textExtensions = [".txt", ".csv", ".html", ".json", ".xml", ".md", ".htm", ".log", ".tsv"];

  if (textPrefixes.some((p) => contentType.startsWith(p))) return true;
  if (textMimes.some((m) => contentType.startsWith(m))) return true;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return textExtensions.some((e) => e === `.${ext}`);
}

function isPdfType(contentType: string, filename: string): boolean {
  if (contentType.startsWith("application/pdf")) return true;
  return filename.toLowerCase().endsWith(".pdf");
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

async function handleReadAttachment(args: Record<string, unknown>): Promise<string> {
  const messageId = args.message_id as string;
  const attachmentId = args.attachment_id as string;

  // First get attachment metadata
  const metaResponse = await nylas.attachments.find({
    identifier: GRANT_ID,
    attachmentId,
    queryParams: { messageId },
  });

  const attachment = metaResponse.data;
  const contentType = attachment.contentType.toLowerCase().split(";")[0].trim();
  const filename = attachment.filename ?? "unknown";

  // Download the attachment bytes
  const buffer = await nylas.attachments.downloadBytes({
    identifier: GRANT_ID,
    attachmentId,
    queryParams: { messageId },
  });

  // PDF files (check before text since application/pdf could be missed)
  if (isPdfType(contentType, filename)) {
    const parsed = await pdfParse(buffer);
    return `File: ${filename} (${parsed.numpages} pages)\n\n${truncateText(parsed.text)}`;
  }

  // Text-based files
  if (isTextType(contentType, filename)) {
    const text = buffer.toString("utf-8");
    return `File: ${filename}\n\n${truncateText(text)}`;
  }

  // Images — use GPT-4o vision
  if (isImageType(contentType)) {
    const base64 = buffer.toString("base64");
    const dataUrl = `data:${contentType};base64,${base64}`;

    const visionResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in detail." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 500,
    });

    const description = visionResponse.choices[0]?.message?.content ?? "Could not describe image.";
    return `File: ${filename} (image)\n\nDescription: ${description}`;
  }

  // Unsupported format
  const size = attachment.size ? `${Math.round(attachment.size / 1024)} KB` : "unknown size";
  return `File: ${filename} (${contentType}, ${size})\n\nThis file format is not supported for content extraction.`;
}

async function handleSendEmail(args: Record<string, unknown>): Promise<string> {
  const to = args.to as string;
  const subject = args.subject as string;
  const body = args.body as string;

  const response = await nylas.messages.send({
    identifier: GRANT_ID,
    requestBody: {
      to: [{ email: to }],
      subject,
      body,
    },
  });

  const sent = response.data;
  const snippet = body.length > 100 ? body.slice(0, 100) + "..." : body;
  return `Email sent successfully.\nTo: ${to}\nSubject: ${subject}\nSnippet: ${snippet}\nMessage ID: ${sent.id}`;
}

async function handleReplyToEmail(args: Record<string, unknown>): Promise<string> {
  const messageId = args.message_id as string;
  const body = args.body as string;

  // Fetch original message to get sender and subject
  const original = await nylas.messages.find({
    identifier: GRANT_ID,
    messageId,
  });

  const originalMsg = original.data;
  const replyTo = originalMsg.from?.[0]?.email;
  if (!replyTo) {
    return "Error: could not determine the sender of the original email.";
  }

  const subject = originalMsg.subject?.startsWith("Re:")
    ? originalMsg.subject
    : `Re: ${originalMsg.subject ?? "(no subject)"}`;

  const response = await nylas.messages.send({
    identifier: GRANT_ID,
    requestBody: {
      to: [{ email: replyTo }],
      subject,
      body,
      replyToMessageId: messageId,
    },
  });

  const sent = response.data;
  const snippet = body.length > 100 ? body.slice(0, 100) + "..." : body;
  return `Reply sent successfully.\nTo: ${replyTo}\nSubject: ${subject}\nSnippet: ${snippet}\nMessage ID: ${sent.id}`;
}

const toolHandlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  search_emails: handleSearchEmails,
  read_email: handleReadEmail,
  read_attachment: handleReadAttachment,
  send_email: handleSendEmail,
  reply_to_email: handleReplyToEmail,
};

const SYSTEM_PROMPT = `You are a personal email assistant with voice interface. You help the user manage and understand their email inbox.

Your capabilities:
- Search emails by sender, subject, keywords, or date
- Read full email contents including body text
- Read attachment contents: text files, CSVs, PDFs (with text extraction), and images (with visual description)
- Report on attachment metadata (filenames, types, sizes)
- Send new emails to any recipient
- Reply to existing emails

Guidelines:
- Always use the available tools to answer questions — never guess or make up email content.
- When a search or attachment download might take a moment, let the user know briefly (e.g. "Let me look that up" or "Let me read that attachment, it might take a moment").
- Keep responses concise and conversational since they will be spoken aloud.
- When summarizing emails, mention the sender, subject, and key points.
- IMPORTANT: You CAN read attachment contents. When the user asks about an attachment (PDF, text file, image, etc.), you MUST use the read_attachment tool to fetch and read it. First use read_email to get the attachment_id, then call read_attachment with the message_id and attachment_id. Never tell the user you cannot open or read attachments — you can.

Sending and replying to emails:
- When the user wants to send an email or reply to one, compose a draft and READ IT BACK to the user before sending.
- You MUST ask for explicit verbal confirmation (e.g. "Shall I send this?") and wait for the user to say "yes" before calling send_email or reply_to_email.
- NEVER call send_email or reply_to_email without the user's confirmation first.
- If the user says "no" or wants changes, adjust the draft and ask for confirmation again.
- For replies, use search_emails and read_email first to find the message, then compose the reply.`;

function sendSSE(res: NextApiResponse, data: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Stream the final text response from OpenAI as SSE delta events.
 * Returns the full accumulated reply text.
 */
async function streamFinalResponse(
  messages: ChatCompletionMessageParam[],
  res: NextApiResponse,
  includTools: boolean
): Promise<string> {
  const stream = await openai.chat.completions.create({
    model: "gpt-4o",
    messages,
    ...(includTools && tools.length > 0 && { tools }),
    stream: true,
  });

  let fullReply = "";
  // Accumulate tool call deltas in case the model decides to call tools
  const toolCallAccum: Record<number, { id: string; name: string; args: string }> = {};
  let hasToolCalls = false;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

    // Text content delta
    if (delta.content) {
      fullReply += delta.content;
      sendSSE(res, { delta: delta.content });
    }

    // Tool call deltas — accumulate them
    if (delta.tool_calls) {
      hasToolCalls = true;
      for (const tc of delta.tool_calls) {
        if (!toolCallAccum[tc.index]) {
          toolCallAccum[tc.index] = { id: "", name: "", args: "" };
        }
        const acc = toolCallAccum[tc.index];
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.args += tc.function.arguments;
      }
    }
  }

  // If the stream produced tool calls instead of text, handle them
  if (hasToolCalls && Object.keys(toolCallAccum).length > 0) {
    const toolCalls = Object.values(toolCallAccum);

    // Build the assistant message with tool_calls for the conversation
    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: fullReply || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    };
    messages.push(assistantMsg);

    // Execute each tool call
    for (const tc of toolCalls) {
      const fn = toolHandlers[tc.name];
      let result: string;
      if (fn) {
        const args = JSON.parse(tc.args);
        result = await fn(args);
      } else {
        result = `Error: unknown tool "${tc.name}"`;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }

    // After handling tools, stream the next response (recursively, with depth limit via caller)
    return fullReply;
  }

  return fullReply;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { message, history } = req.body as {
      message: string;
      history: { role: "user" | "assistant"; content: string }[];
    };

    if (!message) {
      return res.status(400).json({ error: "No message provided" });
    }

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: message },
    ];

    // Tool loop: handle up to MAX_TOOL_ITERATIONS rounds of tool calls
    // before the final streamed text response
    let finalReply = "";

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const replyText = await streamFinalResponse(messages, res, true);
      finalReply = replyText;

      // Check if the last message in the conversation is a tool result
      // (meaning streamFinalResponse handled tool calls and we need another round)
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === "tool") {
        // Tool calls were handled; loop to get the next response
        continue;
      }

      // No tool calls — we're done streaming
      break;
    }

    // If we exhausted tool iterations and the last message is still a tool result,
    // do one final streaming call without tools to force a text response
    const lastMsg = messages[messages.length - 1];
    if (lastMsg.role === "tool") {
      finalReply = await streamFinalResponse(messages, res, false);
    }

    // Send the done event with the full reply
    sendSSE(res, { done: true, reply: finalReply });
    res.end();
  } catch (error: unknown) {
    console.error("[/api/chat] Error:", error);
    const message =
      error instanceof Error ? error.message : "Chat request failed";
    // If headers already sent, send error as SSE event
    if (res.headersSent) {
      sendSSE(res, { error: message });
      res.end();
    } else {
      return res.status(500).json({ error: message });
    }
  }
}
