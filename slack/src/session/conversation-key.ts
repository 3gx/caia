export function makeConversationKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}_${threadTs}` : channelId;
}

export function parseConversationKey(key: string): { channelId: string; threadTs?: string } {
  const separatorIndex = key.indexOf('_');
  if (separatorIndex === -1) {
    return { channelId: key };
  }
  return {
    channelId: key.slice(0, separatorIndex),
    threadTs: key.slice(separatorIndex + 1),
  };
}
