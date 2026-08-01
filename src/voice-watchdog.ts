export type VoiceStatePacket = {
  t?: string;
  d?: {
    guild_id?: string;
    user_id?: string;
    channel_id?: string | null;
    session_id?: string;
  };
};

type VoiceWatchdogContext = {
  selfUserId?: string;
  guildId: string;
  expectedChannelId: string;
  activeSessionId?: string;
  attemptActive: boolean;
};

export type VoiceWatchdogResult =
  | { relevant: false }
  | {
      relevant: true;
      actualChannelId: string | null;
      restartReason?: string;
    };

export function inspectVoiceState(
  packet: VoiceStatePacket,
  context: VoiceWatchdogContext,
): VoiceWatchdogResult {
  if (packet.t !== "VOICE_STATE_UPDATE") return { relevant: false };
  if (!context.selfUserId || packet.d?.user_id !== context.selfUserId) {
    return { relevant: false };
  }
  if (packet.d.guild_id && packet.d.guild_id !== context.guildId) {
    return { relevant: false };
  }

  const actualChannelId = packet.d.channel_id ?? null;
  if (!context.attemptActive) return { relevant: true, actualChannelId };

  if (
    context.activeSessionId &&
    packet.d.session_id &&
    packet.d.session_id !== context.activeSessionId
  ) {
    return {
      relevant: true,
      actualChannelId,
      restartReason: "Discord replaced the active voice session",
    };
  }
  if (actualChannelId === context.expectedChannelId) {
    return { relevant: true, actualChannelId };
  }

  return {
    relevant: true,
    actualChannelId,
    restartReason: actualChannelId === null
      ? "Disconnected or kicked from the configured voice channel"
      : `Moved to unexpected voice channel ${actualChannelId}`,
  };
}
