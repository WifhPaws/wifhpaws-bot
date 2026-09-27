import { ethers } from 'ethers';

// ─── Treasury Wallet (project funds, airdrops) ────────────────────────────────

/**
 * Resolves the Treasury wallet address from env vars.
 * Priority: TREASURY_WALLET_ADDRESS → derived from TREASURY_PRIVATE_KEY.
 */
export function getTreasuryWalletAddress(): string {
  if (process.env.TREASURY_WALLET_ADDRESS) {
    return process.env.TREASURY_WALLET_ADDRESS;
  }
  if (process.env.TREASURY_PRIVATE_KEY) {
    try {
      return new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY).address;
    } catch {
      return '';
    }
  }
  return '';
}

// ─── Dev Wallet (fee accumulation, dev revenue streams) ──────────────────────

/**
 * Resolves the dedicated Dev Wallet address from env vars.
 * Priority: DEV_WALLET_ADDRESS → derived from DEV_WALLET_PRIVATE_KEY.
 * Falls back to the Treasury address if neither is configured, so existing
 * deployments without the new env vars keep working.
 */
export function getDevWalletAddress(): string {
  if (process.env.DEV_WALLET_ADDRESS) {
    return process.env.DEV_WALLET_ADDRESS;
  }
  if (process.env.DEV_WALLET_PRIVATE_KEY) {
    try {
      return new ethers.Wallet(process.env.DEV_WALLET_PRIVATE_KEY).address;
    } catch {
      return '';
    }
  }
  // Graceful fallback: use treasury so fees aren't lost on old deployments
  return getTreasuryWalletAddress();
}

// ─── Fee Calculation ──────────────────────────────────────────────────────────

/**
 * Calculates the 1% transaction fee and splits the amount.
 * Returns `userAmount` (99%) and `feeAmount` (1%).
 */
export function calculateAndRouteFee(transferAmount: bigint): {
  userAmount: bigint;
  feeAmount: bigint;
} {
  const feeAmount = (transferAmount * BigInt(100)) / BigInt(10000); // 1%
  const userAmount = transferAmount - feeAmount;
  return { userAmount, feeAmount };
}

// ─── Fee Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatches the collected 1% micro-fee to the **Dev Wallet**.
 * An optional `devAddressOverride` lets callers supply an explicit address
 * (e.g. the already-resolved signer address) without re-reading env vars.
 */
export async function dispatchFeesToDevWallet(
  feeAmount: bigint,
  tokenContract: ethers.Contract,
  signer: ethers.Signer,
  devAddressOverride?: string
): Promise<string | null> {
  try {
    if (feeAmount <= BigInt(0)) return null;

    const targetAddress = devAddressOverride || getDevWalletAddress();
    if (!targetAddress) {
      console.warn(
        '[FeeService] Dev wallet address not configured. Skipping fee dispatch.'
      );
      return null;
    }

    const connectedContract = tokenContract.connect(signer) as any;
    const tx = await connectedContract.transfer(targetAddress, feeAmount);
    await tx.wait();

    console.log(
      `[FeeService] Routed 1% fee (${ethers.formatUnits(feeAmount, 18)} WIFH) → Dev Wallet (${targetAddress})`
    );
    return tx.hash;
  } catch (error) {
    console.error('[FeeService] Failed to route fee to Dev Wallet:', error);
    return null;
  }
}

/**
 * @deprecated Use `dispatchFeesToDevWallet` instead.
 * Kept for backward compatibility; routes to the Dev Wallet (not Treasury).
 */
export async function dispatchFeesToTreasury(
  feeAmount: bigint,
  tokenContract: ethers.Contract,
  signer: ethers.Signer,
  addressOverride?: string
): Promise<string | null> {
  return dispatchFeesToDevWallet(feeAmount, tokenContract, signer, addressOverride);
}
