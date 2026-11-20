import { AccessToken, TrackSource } from "livekit-server-sdk";

/**
 * Short-lived LiveKit participant credentials for the token-scoped WebRTC
 * room. Only microphone publishing is granted — camera/recording media is
 * never an AI input (ADR-005). The project secret stays on the server.
 */
export interface LiveKitTokenInput {
  room: string;
  identity: string;
  displayName: string;
  url: string;
  metadata?: string;
}

export interface LiveKitCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface LiveKitSession {
  url: string;
  token: string;
}

interface TokenBuilder {
  addGrant(grant: {
    roomJoin: boolean;
    room: string;
    canPublish: boolean;
    canSubscribe: boolean;
    canPublishSources: TrackSource[];
  }): void;
  toJwt(): Promise<string>;
}

export interface LiveKitTokenDeps {
  createToken?: (
    credentials: LiveKitCredentials,
    input: LiveKitTokenInput,
  ) => TokenBuilder;
}

const TOKEN_TTL_SECONDS = 15 * 60;

export async function mintParticipantToken(
  input: LiveKitTokenInput,
  credentials: LiveKitCredentials,
  deps: LiveKitTokenDeps = {},
): Promise<LiveKitSession> {
  const create =
    deps.createToken ??
    ((creds: LiveKitCredentials, details: LiveKitTokenInput) =>
      new AccessToken(creds.apiKey, creds.apiSecret, {
        identity: details.identity,
        name: details.displayName,
        ttl: TOKEN_TTL_SECONDS,
        metadata: details.metadata,
      }) as unknown as TokenBuilder);

  const token = create(credentials, input);
  token.addGrant({
    roomJoin: true,
    room: input.room,
    canPublish: true,
    canSubscribe: true,
    canPublishSources: [TrackSource.MICROPHONE],
  });
  return { url: input.url, token: await token.toJwt() };
}
