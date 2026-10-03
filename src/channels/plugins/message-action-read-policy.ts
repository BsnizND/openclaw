import type { ChannelMessageActionName } from "./types.js";

export type ChannelMessageActionReadPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "conversation-read";
      readonly targetlessCache: "deny" | "bundled-current-context";
    };

const NO_CONVERSATION_READ = { kind: "none" } as const;
const CONVERSATION_READ = { kind: "conversation-read", targetlessCache: "deny" } as const;
const BUNDLED_CURRENT_CONTEXT_CACHE_READ = {
  kind: "conversation-read",
  targetlessCache: "bundled-current-context",
} as const;

// Exhaustive by design: every new core action must declare its read authority
// before the dispatcher will compile.
const CHANNEL_MESSAGE_ACTION_READ_POLICIES = {
  send: NO_CONVERSATION_READ,
  broadcast: NO_CONVERSATION_READ,
  poll: NO_CONVERSATION_READ,
  "poll-vote": CONVERSATION_READ,
  react: CONVERSATION_READ,
  reactions: CONVERSATION_READ,
  read: CONVERSATION_READ,
  edit: CONVERSATION_READ,
  unsend: CONVERSATION_READ,
  reply: NO_CONVERSATION_READ,
  sendWithEffect: NO_CONVERSATION_READ,
  renameGroup: NO_CONVERSATION_READ,
  setGroupIcon: NO_CONVERSATION_READ,
  addParticipant: NO_CONVERSATION_READ,
  removeParticipant: NO_CONVERSATION_READ,
  leaveGroup: NO_CONVERSATION_READ,
  sendAttachment: NO_CONVERSATION_READ,
  delete: CONVERSATION_READ,
  pin: CONVERSATION_READ,
  unpin: CONVERSATION_READ,
  "list-pins": CONVERSATION_READ,
  permissions: CONVERSATION_READ,
  "thread-create": NO_CONVERSATION_READ,
  "thread-list": CONVERSATION_READ,
  "thread-reply": NO_CONVERSATION_READ,
  search: CONVERSATION_READ,
  sticker: NO_CONVERSATION_READ,
  "sticker-search": BUNDLED_CURRENT_CONTEXT_CACHE_READ,
  "member-info": CONVERSATION_READ,
  "role-info": CONVERSATION_READ,
  "emoji-list": CONVERSATION_READ,
  "emoji-upload": NO_CONVERSATION_READ,
  "sticker-upload": NO_CONVERSATION_READ,
  "role-add": NO_CONVERSATION_READ,
  "role-remove": NO_CONVERSATION_READ,
  "channel-info": CONVERSATION_READ,
  "channel-list": CONVERSATION_READ,
  "channel-create": NO_CONVERSATION_READ,
  "conversation-open": NO_CONVERSATION_READ,
  "channel-edit": NO_CONVERSATION_READ,
  "channel-delete": NO_CONVERSATION_READ,
  "channel-move": NO_CONVERSATION_READ,
  "category-create": NO_CONVERSATION_READ,
  "category-edit": NO_CONVERSATION_READ,
  "category-delete": NO_CONVERSATION_READ,
  "topic-create": NO_CONVERSATION_READ,
  "topic-edit": NO_CONVERSATION_READ,
  "voice-status": CONVERSATION_READ,
  "event-list": CONVERSATION_READ,
  "event-create": NO_CONVERSATION_READ,
  timeout: NO_CONVERSATION_READ,
  kick: NO_CONVERSATION_READ,
  ban: NO_CONVERSATION_READ,
  "set-profile": NO_CONVERSATION_READ,
  "set-presence": NO_CONVERSATION_READ,
  "download-file": CONVERSATION_READ,
  "upload-file": NO_CONVERSATION_READ,
} as const satisfies Record<ChannelMessageActionName, ChannelMessageActionReadPolicy>;

export function resolveChannelMessageActionReadPolicy(
  action: unknown,
): ChannelMessageActionReadPolicy | undefined {
  if (typeof action !== "string" || !Object.hasOwn(CHANNEL_MESSAGE_ACTION_READ_POLICIES, action)) {
    return undefined;
  }
  // SAFETY: own-key admission above narrows this exhaustive core action policy table.
  return CHANNEL_MESSAGE_ACTION_READ_POLICIES[action as ChannelMessageActionName];
}
