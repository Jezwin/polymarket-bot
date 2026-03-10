import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const notify = async (title: string, message: string, tags?: string[]): Promise<void> => {
  if (!env.NTFY_TOPIC) {
    return;
  }

  try {
    const encodedTitle = `=?UTF-8?B?${Buffer.from(title).toString("base64")}?=`;

    const headers: Record<string, string> = {
      "Title": encodedTitle,
    };
    if (tags && tags.length > 0) {
      headers["Tags"] = tags.join(",");
    }

    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers,
      body: message,
    });
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, "Failed to send ntfy notification");
  }
};
