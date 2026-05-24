// GHL Conversations send — operator-side helper (kept in lock-step with
// the parent portal copy). Used by the retry-push action when an upload
// failed to sync the first time.

import type { GhlClient } from './client';

export interface SendMessageInput {
  contactId: string;
  body: string;
  type?: string;            // defaults to 'Live_Chat'
  attachments?: string[];   // public URLs (typically from GHL media)
}

export interface SendMessageResult {
  conversationId: string;
  messageId: string;
}

export async function sendMessage(
  client: GhlClient,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  const body: Record<string, unknown> = {
    type: input.type ?? 'Live_Chat',
    contactId: input.contactId,
    message: input.body,
  };
  if (input.attachments && input.attachments.length > 0) {
    body.attachments = input.attachments;
  }
  const { data } = await client.axios.post<{ conversationId?: string; messageId?: string }>(
    '/conversations/messages',
    body,
  );
  if (!data.conversationId || !data.messageId) {
    throw new Error('GHL did not return conversationId / messageId');
  }
  return { conversationId: data.conversationId, messageId: data.messageId };
}
