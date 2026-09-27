import { ethers } from 'ethers';

const TREASURY_WALLET_ADDRESS = process.env.TREASURY_WALLET_ADDRESS || '';

/**
 * Resolves the treasury wallet address from TREASURY_WALLET_ADDRESS or derives it from TREASURY_PRIVATE_KEY.
 */
export function getTreasuryWalletAddress(): string {
  if (TREASURY_WALLET_ADDRESS) {
    return TREASURY_WALLET_ADDRESS;
  }
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

/**
 * Calculates the 1% transaction fee and splits the amount.
 */
export function calculateAndRouteFee(transferAmount: bigint): { userAmount: bigint; feeAmount: bigint } {
  const feeAmount = (transferAmount * BigInt(100)) / BigInt(10000); // 1% equivalent
  const userAmount = transferAmount - feeAmount;

  return { userAmount, feeAmount };
}

/**
 * Dispatches the collected 1% micro-fees to the secure treasury wallet.
 */
export async function dispatchFeesToTreasury(
  feeAmount: bigint,
  tokenContract: ethers.Contract,
  signer: ethers.Signer,
  treasuryAddressOverride?: string
): Promise<string | null> {
  try {
    if (feeAmount <= BigInt(0)) return null;

    const targetAddress = treasuryAddressOverride || getTreasuryWalletAddress();
    if (!targetAddress) {
      console.warn('[FeeService] Warning: Treasury wallet address not configured. Skipping fee dispatch.');
      return null;
    }

    const connectedContract = tokenContract.connect(signer) as any;
    const tx = await connectedContract.transfer(targetAddress, feeAmount);
    await tx.wait();

    console.log(`Successfully routed 1% fee to treasury: ${ethers.formatUnits(feeAmount, 18)} WIFH`);
    return tx.hash;
  } catch (error) {
    console.error('Failed to route fee to treasury:', error);
    return null;
  }
}
