"use strict";

const { getSystemPrompt } = require("./personality");

const API_URL =
  "https://api.groq.com/openai/v1/chat/completions";

const API_KEY = process.env.GROQ_API_KEY;
const MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-120b";

const MAX_HISTORY = Math.max(
  2,
  Number(process.env.MAX_HISTORY_MESSAGES || 10)
);

const conversations = new Map();

function getConversationKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

function getHistory(chatId, userId) {
  const key = getConversationKey(chatId, userId);
  return conversations.get(key) || [];
}

function saveHistory(chatId, userId, userText, answer) {
  const key = getConversationKey(chatId, userId);
  const history = getHistory(chatId, userId);

  history.push(
    { role: "user", content: userText },
    { role: "assistant", content: answer }
  );

  conversations.set(
    key,
    history.slice(-MAX_HISTORY)
  );
}

function clearHistory(chatId, userId) {
  conversations.delete(
    getConversationKey(chatId, userId)
  );
}

async function askGroq(userText, userName, chatId, userId) {
  if (process.env.AI_ENABLED === "false") {
    throw new Error("AI_DISABLED");
  }

  if (!API_KEY) {
    throw new Error("GROQ_API_KEY is missing");
  }

  const history = getHistory(chatId, userId);

  const messages = [
    {
      role: "system",
      content: getSystemPrompt()
    },
    ...history,
    {
      role: "user",
      content:
        `اسم الشخص الذي يتحدث معك هو ${userName}.\n` +
        `رسالته: ${userText}`
    }
  ];

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    45000
  );

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.65,
        max_tokens: 1200
      }),
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        `Groq HTTP ${response.status}`;

      throw new Error(message);
    }

    const answer =
      data?.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Groq returned an empty response");
    }

    const cleanAnswer = answer.trim();

    saveHistory(
      chatId,
      userId,
      userText,
      cleanAnswer
    );

    return cleanAnswer;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Groq request timed out");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  askGroq,
  getHistory,
  clearHistory
};