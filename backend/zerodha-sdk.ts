/** Backend-only SDK boundary. HTTP callers must enforce session ownership and one-use login state. */
import { KiteConnect, type Connect } from "kiteconnect";
import { z } from "zod";

type Client = Pick<
  Connect,
  "getLoginURL" | "generateSession" | "setAccessToken" | "getProfile"
>;
const credential = z.string().trim().min(1).max(256);
const profile = z.object({
  user_id: z.string().min(1).max(64),
  user_name: z.string().max(160),
});

/** Factory never shares authenticated SDK instances between users or exposes raw SDK responses. */
export function createZerodhaSdk(
  env: NodeJS.ProcessEnv,
  factory: (key: string) => Client = (key) =>
    new KiteConnect({ api_key: key, debug: false, timeout: 10000 }),
) {
  const key = credential.parse(env.ZERODHA_API_KEY);
  const secret = credential.parse(env.ZERODHA_API_SECRET);
  return {
    loginUrl(state: string) {
      z.string()
        .regex(/^[A-Za-z0-9_-]{43,128}$/)
        .parse(state);
      const url = new URL(factory(key).getLoginURL());
      if (
        url.protocol !== "https:" ||
        !["kite.zerodha.com", "kite.trade"].includes(url.hostname)
      ) {
        throw new Error("Unexpected Kite login destination.");
      }
      url.searchParams.set(
        "redirect_params",
        new URLSearchParams({ state }).toString(),
      );
      return url.toString();
    },
    async exchange(requestToken: string) {
      credential.parse(requestToken);
      const client = factory(key);
      try {
        const session = await client.generateSession(requestToken, secret);
        const account = profile.parse(session);
        client.setAccessToken(credential.parse(session.access_token));
        return {
          account,
          async verify() {
            try {
              const current = profile.parse(await client.getProfile());
              if (current.user_id !== account.user_id) {
                throw new Error("Account changed");
              }
              return current;
            } catch {
              throw new Error(
                "Zerodha session verification failed. Reconnect your account.",
              );
            }
          },
        };
      } catch {
        // SDK errors can include authorization headers; never propagate raw errors.
        throw new Error(
          "Zerodha login failed. Start a new login from Broker connections.",
        );
      }
    },
  };
}
