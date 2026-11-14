"use client";
/**
 * The one transaction flow used by every action in the app:
 *   connect? -> right network? -> enough BTC for gas? -> approve exact amount if needed
 *   -> simulate (catches reverts before the wallet opens) -> sign -> pending toast with explorer link
 *   -> wait for receipt -> success / revert toast -> refresh every query.
 */
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { toast } from "sonner";
import { erc20Abi, formatUnits, type Abi, type Address, type Hash, type TransactionReceipt } from "viem";
import { useAccount, useConfig } from "wagmi";
import {
  getBalance,
  readContract,
  simulateContract,
  switchChain,
  waitForTransactionReceipt,
  writeContract,
} from "wagmi/actions";
import { activeChain, explorerTx } from "@/lib/chain";
import { formatAmount, formatBtc } from "@/lib/format";
import { decodeTxError, extraErrorsAbi, type ErrorContext } from "./tx-errors";

export interface ContractCall {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface Approval {
  token: Address;
  spender: Address;
  amount: bigint;
  symbol: string;
  decimals: number;
}

export interface TxRequest {
  /** Short verb phrase for toasts, e.g. "Deposit 100 MUSD". */
  label: string;
  call: ContractCall;
  approve?: Approval;
  errorContext?: ErrorContext;
  successMessage?: string;
  onSuccess?: (receipt: TransactionReceipt) => void;
}

export type TxPhase = "idle" | "connecting" | "switching" | "approving" | "signing" | "pending" | "success" | "error";

function TxLink({ hash, text = "View on explorer" }: { hash: Hash; text?: string }) {
  const href = explorerTx(hash);
  if (!href) return <span className="font-mono">{hash.slice(0, 10)}…</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
      {text}
    </a>
  );
}

export function useTx() {
  const config = useConfig();
  const qc = useQueryClient();
  const { address, chainId, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const [phase, setPhase] = useState<TxPhase>("idle");
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();

  const refresh = useCallback(() => {
    qc.invalidateQueries();
    // The index trails the chain by a couple of blocks; refresh API data again shortly after.
    setTimeout(() => qc.invalidateQueries({ queryKey: ["api"] }), 4000);
    setTimeout(() => qc.invalidateQueries({ queryKey: ["api"] }), 12000);
  }, [qc]);

  const run = useCallback(
    async (req: TxRequest): Promise<TransactionReceipt | null> => {
      const id = `tx-${Date.now()}`;
      const fail = (message: string, quiet = false) => {
        setPhase("error");
        setError(message);
        if (quiet) toast.dismiss(id);
        else toast.error(message, { id });
        return null;
      };
      setError(undefined);
      setHash(undefined);

      if (!isConnected || !address) {
        setPhase("connecting");
        openConnectModal?.();
        setPhase("idle");
        return null;
      }

      try {
        if (chainId !== activeChain.id) {
          setPhase("switching");
          toast.loading(`Switching to ${activeChain.name}`, { id });
          await switchChain(config, { chainId: activeChain.id });
        }

        const bal = await getBalance(config, { address, chainId: activeChain.id });
        const value = req.call.value ?? 0n;
        if (bal.value <= value) {
          return fail(
            value > 0n
              ? `Not enough BTC. You have ${formatBtc(bal.value)}, this needs ${formatBtc(value)} plus a small network fee.`
              : "Not enough BTC to pay the network fee. Add testnet BTC to this wallet and retry.",
          );
        }

        if (req.approve && req.approve.amount > 0n) {
          const a = req.approve;
          const tokenBal = await readContract(config, {
            address: a.token,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
            chainId: activeChain.id,
          });
          if (tokenBal < a.amount) {
            return fail(
              `Not enough ${a.symbol}. You have ${formatAmount(tokenBal, a.decimals)}, this needs ${formatAmount(a.amount, a.decimals)}.`,
            );
          }
          const allowance = await readContract(config, {
            address: a.token,
            abi: erc20Abi,
            functionName: "allowance",
            args: [address, a.spender],
            chainId: activeChain.id,
          });
          if (allowance < a.amount) {
            setPhase("approving");
            const human = formatUnits(a.amount, a.decimals);
            toast.loading(`Approve ${formatAmount(a.amount, a.decimals)} ${a.symbol} in your wallet`, {
              id,
              description: "Exact amount only. LiquidityX never asks for unlimited approval.",
            });
            const approveHash = await writeContract(config, {
              address: a.token,
              abi: erc20Abi,
              functionName: "approve",
              args: [a.spender, a.amount],
              chainId: activeChain.id,
            });
            toast.loading(`Approving ${human} ${a.symbol}`, { id, description: <TxLink hash={approveHash} /> });
            const r = await waitForTransactionReceipt(config, { hash: approveHash, chainId: activeChain.id });
            if (r.status !== "success") return fail(`The ${a.symbol} approval failed on chain.`);
          }
        }

        setPhase("signing");
        toast.loading(`${req.label}: confirm in your wallet`, { id, description: undefined });
        const abi = [...(req.call.abi as Abi), ...extraErrorsAbi] as Abi;
        const { request } = await simulateContract(config, {
          address: req.call.address,
          abi,
          functionName: req.call.functionName,
          args: req.call.args ?? [],
          value: req.call.value,
          account: address,
          chainId: activeChain.id,
        } as Parameters<typeof simulateContract>[1]);
        const txHash = await writeContract(config, request as Parameters<typeof writeContract>[1]);
        setHash(txHash);
        setPhase("pending");
        toast.loading(`${req.label}: waiting for the network`, { id, description: <TxLink hash={txHash} /> });

        const receipt = await waitForTransactionReceipt(config, { hash: txHash, chainId: activeChain.id });
        if (receipt.status !== "success") {
          // Re-run the call to recover the revert reason for the message.
          let reason = "The transaction reverted on chain.";
          try {
            await simulateContract(config, {
              address: req.call.address,
              abi,
              functionName: req.call.functionName,
              args: req.call.args ?? [],
              value: req.call.value,
              account: address,
              chainId: activeChain.id,
            } as Parameters<typeof simulateContract>[1]);
          } catch (e) {
            reason = decodeTxError(e, req.errorContext).message;
          }
          setPhase("error");
          setError(reason);
          toast.error(reason, { id, description: <TxLink hash={txHash} /> });
          refresh();
          return null;
        }

        setPhase("success");
        toast.success(req.successMessage ?? `${req.label}: done`, { id, description: <TxLink hash={txHash} /> });
        refresh();
        req.onSuccess?.(receipt);
        return receipt;
      } catch (e) {
        const d = decodeTxError(e, req.errorContext);
        if (d.kind === "rejected") {
          toast.message(d.message, { id });
          setPhase("idle");
          return null;
        }
        return fail(d.message);
      }
    },
    [address, chainId, config, isConnected, openConnectModal, refresh],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(undefined);
    setHash(undefined);
  }, []);

  const busy = phase === "switching" || phase === "approving" || phase === "signing" || phase === "pending";
  return { run, phase, busy, hash, error, reset };
}

export function phaseLabel(phase: TxPhase, idle: string): string {
  switch (phase) {
    case "switching":
      return "Switching network…";
    case "approving":
      return "Approving…";
    case "signing":
      return "Confirm in wallet…";
    case "pending":
      return "Confirming…";
    default:
      return idle;
  }
}
