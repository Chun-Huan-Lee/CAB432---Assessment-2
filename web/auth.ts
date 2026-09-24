/**
 * Cognito sign-in for the chat client.
 *
 * The browser calls the Cognito user pool API directly over HTTPS
 * (USER_PASSWORD_AUTH), so the password never passes through our own server.
 * Only the resulting ID token is sent to the agent, which verifies it before
 * accepting the WebSocket.
 */
export interface PublicConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  repository: string;
  authDisabled?: boolean;
}

interface StoredToken {
  idToken: string;
  expiresAt: number;
  email: string;
}

const TOKEN_KEY = "custodian-id-token";

export async function loadPublicConfig(): Promise<PublicConfig | null> {
  try {
    const response = await fetch("/config.json", { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as PublicConfig;
  } catch {
    return null;
  }
}

export function storedToken(): StoredToken | null {
  try {
    const raw = window.sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const token = JSON.parse(raw) as StoredToken;
    return token.expiresAt > Date.now() + 30_000 ? token : null;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

export async function signIn(config: PublicConfig, email: string, password: string): Promise<StoredToken> {
  const response = await fetch(`https://cognito-idp.${config.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.clientId,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }),
  });
  const payload = (await response.json()) as {
    AuthenticationResult?: { IdToken: string; ExpiresIn: number };
    ChallengeName?: string;
    message?: string;
  };
  if (!response.ok) throw new Error(payload.message ?? "Sign-in failed");
  if (!payload.AuthenticationResult) throw new Error(`Unsupported sign-in challenge: ${payload.ChallengeName ?? "unknown"}`);
  const token: StoredToken = {
    idToken: payload.AuthenticationResult.IdToken,
    expiresAt: Date.now() + payload.AuthenticationResult.ExpiresIn * 1000,
    email,
  };
  try {
    window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  } catch {
    // Token still works for this page load.
  }
  return token;
}
