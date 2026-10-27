import type { OAuthClient } from "@guardbase/core/supabase/oauth";
import { TokenVault } from "@guardbase/core/vault/vault";
import { env } from "cloudflare:workers";

export function oauthClient(): OAuthClient {
  return {
    clientId: env.SUPABASE_OAUTH_CLIENT_ID,
    clientSecret: env.SUPABASE_OAUTH_CLIENT_SECRET,
    redirectUri: new URL("/api/supabase/callback", env.APP_URL).toString(),
  };
}

export function vault(): TokenVault {
  return TokenVault.fromEnv({ GUARDBASE_MASTER_KEYS: env.GUARDBASE_MASTER_KEYS });
}
