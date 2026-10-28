import type { OAuthClient } from "@supahound/core/supabase/oauth";
import { TokenVault } from "@supahound/core/vault/vault";
import { env } from "cloudflare:workers";

export function oauthClient(): OAuthClient {
  return {
    clientId: env.SUPABASE_OAUTH_CLIENT_ID,
    clientSecret: env.SUPABASE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/api/supabase/callback", env.APP_URL).toString(),
  };
}

export function vault(): TokenVault {
  return TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: env.SUPAHOUND_MASTER_KEYS });
}
