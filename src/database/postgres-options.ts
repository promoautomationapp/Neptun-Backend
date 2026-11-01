import type { ClientConfig } from "pg";

// URL channel_binding=require is not interpreted by node-postgres. This option
// enables SCRAM-SHA-256-PLUS when the TLS server offers it; certificate
// verification remains controlled by the connection's existing SSL settings.
export const POSTGRES_AUTH_OPTIONS = {
  enableChannelBinding: true,
} satisfies Pick<ClientConfig, "enableChannelBinding">;
