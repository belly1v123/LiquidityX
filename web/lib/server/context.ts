import "server-only";
import { createPublicClient, http, type Abi, type Address, type Chain, type PublicClient } from "viem";
import { activeChain, getDeployment, type Deployment } from "@/lib/chain";

/** The slice of viem's PublicClient the backend uses. Tests pass a mock implementing these. */
export type ChainClient = Pick<PublicClient, "getBlockNumber" | "getBlock" | "getLogs" | "readContract" | "multicall">;

let clientOverride: ChainClient | null = null;
let deploymentOverride: Deployment | null | undefined = undefined;
let chainOverride: Chain | null = null;
let client: ChainClient | null = null;

export function getChain(): Chain {
  return chainOverride ?? activeChain;
}

export function chainId(): number {
  return getDeployment0()?.chainId ?? getChain().id;
}

function getDeployment0(): Deployment | null {
  if (deploymentOverride !== undefined) return deploymentOverride;
  try {
    return getDeployment();
  } catch {
    return null;
  }
}

/** Deployment for the active chain, or null when the contracts are not deployed (every route must handle this). */
export function deployment(): Deployment | null {
  return getDeployment0();
}

export function rpcUrl(): string {
  return process.env.MEZO_RPC_URL || getChain().rpcUrls.default.http[0];
}

export function getClient(): ChainClient {
  if (clientOverride) return clientOverride;
  if (!client) {
    client = createPublicClient({
      chain: getChain(),
      // Retries are done by withRetry (3 tries with backoff) so they are visible and testable.
      transport: http(rpcUrl(), { retryCount: 0, timeout: 8_000 }),
    }) as unknown as ChainClient;
  }
  return client;
}

export function hasMulticall(): boolean {
  return Boolean(getChain().contracts?.multicall3?.address);
}

/** Tests only. */
export function setTestContext(opts: { client?: ChainClient | null; deployment?: Deployment | null; chain?: Chain | null }) {
  if ("client" in opts) clientOverride = opts.client ?? null;
  if ("deployment" in opts) deploymentOverride = opts.deployment;
  if ("chain" in opts) chainOverride = opts.chain ?? null;
}

export function resetTestContext() {
  clientOverride = null;
  deploymentOverride = undefined;
  chainOverride = null;
}

export type { Abi, Address, Deployment };
