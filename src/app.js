
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEM_PROMPT = `You are a customer-support executive for our
Food ordering app named Tomato.

Your job is to identify the customer's main
problem and urgency. Answer them related to their query.

Use professional language. If the user has an issue,
use words like I understand your frustration,
I am really sorry for your trouble, etc.

Do not answer any other question which is not
related to food ordering, refund, order tracking,
or company policy.
`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const history = [];

// Process conversation turns one at a time.
let historyQueue = Promise.resolve();

function useHistory(operation) {
  const result = historyQueue.then(operation);
  historyQueue = result.catch(() => {});
  return result;
}

app.use(cors());

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.text({ type: "*/*" }));

app.post("/api/chat", async (req, res, next) => {
  if (typeof req.body !== "string" || !req.body.trim()) {
    res.status(400).type("text/plain").send("Message is required");
    return;
  }

  // Tell the browser that this response will stream.
  res.status(200);
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });

  res.flushHeaders();

  try {
    await useHistory(async () => {
      history.push({
        role: "user",
        content: req.body,
      });

      let answer = "";

      try {
        const stream = await client.responses.create({
          model,
          instructions: SYSTEM_PROMPT,
          input: history,
          max_output_tokens: 4096,
          store: false,
          stream: true,
        });

        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            answer += event.delta;

            // Send each generated text chunk to the browser.
            if (!res.destroyed) {
              res.write(event.delta);
            }
          }
        }

        // Save the complete answer for future conversation turns.
        history.push({
          role: "assistant",
          content: answer,
        });
      } catch (error) {
        // Do not leave an incomplete user turn in history.
        history.pop();
        throw error;
      }
    });

    if (!res.destroyed) {
      res.end();
    }
  } catch (error) {
    console.error("Streaming error:", error);

    if (res.headersSent) {
      // Headers are already sent; an HTTP error response
      // can no longer replace this streaming response.
      if (!res.destroyed) {
        res.end();
      }
    } else {
      next(error);
    }
  }
});

app.delete("/api", async (_req, res, next) => {
  try {
    await useHistory(async () => {
      history.length = 0;
    });

    res.status(200).send();
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);

  if (!res.headersSent) {
    res.status(500)
      .type("text/plain")
      .send("Unable to process the chat request");
  }
});

export default app;
