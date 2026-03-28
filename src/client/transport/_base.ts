// Base transport interface for client-side transports

import type { Frame } from "../../types.ts";

export type FrameHandler = (frame: Frame) => void;
export type DisconnectHandler = () => void;

export interface ClientTransport {
  /** Send a frame to the server */
  send(frame: Frame): Promise<void>;

  /** Register a handler for incoming frames */
  onFrame(handler: FrameHandler): void;

  /** Register a handler for unexpected disconnects */
  onDisconnect(handler: DisconnectHandler): void;

  /** Close the transport */
  close(): void;
}
