import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const factories: ChannelFactory[] = [];

export function registerChannel(_name: string, factory: ChannelFactory): void {
  factories.push(factory);
}

export function createChannels(opts: ChannelOpts): Channel[] {
  const channels: Channel[] = [];
  for (const factory of factories) {
    const ch = factory(opts);
    if (ch) channels.push(ch);
  }
  return channels;
}
