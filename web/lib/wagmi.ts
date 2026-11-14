import { connectorsForWallets, type WalletList } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConfig, http, type Config, type CreateConfigParameters } from "wagmi";
import { activeChain, mezoTestnet } from "./chain";

/**
 * Wallet connection goes through Mezo Passport (built on RainbowKit):
 * - Bitcoin wallets (Unisat, OKX, Xverse) connect through a Mezo smart account that the BTC wallet controls.
 * - Ethereum wallets (Rabby, any injected/EIP-6963 wallet; MetaMask SDK + WalletConnect only when
 *   NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set) connect directly.
 *
 * Passport's Bitcoin connectors read `window` when created, and the package root pulls in a React 18-only
 * UI kit, so the Passport config is built in the browser only, from the deep `config` module. The server
 * render uses a connector-less config; `ssr: true` hydrates the connection on the client.
 *
 * Local development (NEXT_PUBLIC_CHAIN=local, anvil 31337) skips Passport: its smart accounts only exist on Mezo.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined;

const appInfo = {
  appName: "LiquidityX",
  appDescription: "Peer-to-peer fixed-rate loans backed by BTC.",
  appUrl: process.env.NEXT_PUBLIC_SITE_URL || "https://liquidityx.app",
};

const transports = {
  [activeChain.id]: http(activeChain.rpcUrls.default.http[0], { batch: true, retryCount: 3, retryDelay: 400 }),
};

const evmWallets = projectId ? [metaMaskWallet, rabbyWallet, walletConnectWallet, injectedWallet] : [rabbyWallet, injectedWallet];

type PassportConfigModule = typeof import("@mezo-org/passport/dist/src/config");

function serverConfig() {
  return createConfig({ chains: [activeChain], transports, connectors: [], ssr: true });
}

function localConfig(): Config {
  const connectors = connectorsForWallets([{ groupName: "Ethereum wallets", wallets: evmWallets }], {
    ...appInfo,
    projectId: projectId ?? "not-configured",
  });
  return createConfig({ chains: [activeChain], transports, connectors, ssr: true });
}

function passportConfig(): Config {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const passport = require("@mezo-org/passport/dist/src/config") as PassportConfigModule;
  const wallets: WalletList = [
    {
      groupName: "Bitcoin wallets",
      wallets: [passport.unisatWalletMezoTestnet, passport.okxWalletMezoTestnet, passport.xverseWalletMezoTestnet],
    },
    { groupName: "Ethereum wallets", wallets: evmWallets },
  ];
  return passport.getConfig({
    ...appInfo,
    mezoNetwork: "testnet",
    walletConnectProjectId: projectId ?? "not-configured",
    wallets,
    chains: [mezoTestnet],
    // Passport types this as Pick<CreateConfigParameters, "transports"> but spreads it into
    // RainbowKit's getDefaultConfig, which expects the transport map itself.
    transports: transports as unknown as Pick<CreateConfigParameters, "transports">,
    ssr: true,
  });
}

export const usesPassport = activeChain.id === mezoTestnet.id;

export const wagmiConfig: ReturnType<typeof serverConfig> =
  typeof window === "undefined"
    ? serverConfig()
    : ((usesPassport ? passportConfig() : localConfig()) as ReturnType<typeof serverConfig>);

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
