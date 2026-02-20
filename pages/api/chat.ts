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

    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `You are a personal email assistant with voice interface. You help the user manage and understand their email inbox.

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
- For replies, use search_emails and read_email first to find the message, then compose the reply.`,
      },
      ...history,
      { role: "user", content: message },
    ];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        ...(tools.length > 0 && { tools }),
      });

      const choice = completion.choices[0];
      const assistantMessage = choice.message;

      // If no tool calls, return the text response
      if (choice.finish_reason !== "tool_calls" || !assistantMessage.tool_calls?.length) {
        const reply = assistantMessage.content ?? "";
        return res.status(200).json({ reply });
      }

      // Append the assistant message with tool calls to the conversation
      messages.push(assistantMessage);

      // Execute each tool call and append results
      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.type !== "function") continue;

        const fn = toolHandlers[toolCall.function.name];
        let result: string;

        if (fn) {
          const args = JSON.parse(toolCall.function.arguments);
          result = await fn(args);
        } else {
          result = `Error: unknown tool "${toolCall.function.name}"`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // If we hit the iteration cap, make one final call without tools to force a text response
    const finalCompletion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
    });

    const reply = finalCompletion.choices[0]?.message?.content ?? "";
    return res.status(200).json({ reply });
  } catch (error: unknown) {
    console.error("[/api/chat] Error:", error);
    const message =
      error instanceof Error ? error.message : "Chat request failed";
    return res.status(500).json({ error: message });
  }
}
