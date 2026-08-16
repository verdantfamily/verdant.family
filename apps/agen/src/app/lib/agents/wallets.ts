/**
 * Isolated signing identities for agents.
 *
 * Each agent gets its own random secp256k1 key. The key is encrypted at rest with a
 * wrapping key derived for *that agent alone*, so a blob stolen from disk is useless
 * without the master secret, and a key extracted from memory for one agent cannot
 * unwrap another.
 *
 * The master secret (`AGENT_WALLET_MASTER_KEY`) never touches the database. Private
 * keys never leave this module except as an in-memory `Hex` handed to the signer for
 * the duration of one transaction, and they are never returned through an API.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";

import { AgentError } from "./errors";
import type { AgentWalletRecord } from "./types";

const INFO_PREFIX = "agen.agent.wallet.v1:";

export function masterKeyBytes(): Buffer {
  const raw = process.env["AGENT_WALLET_MASTER_KEY"]?.trim();
  if (raw === undefined || raw === "") {
    throw new AgentError(
      "CONFIG_MISSING",
      "Agent wallets cannot be created: AGENT_WALLET_MASTER_KEY is not set.",
    );
  }

  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new AgentError(
      "CONFIG_MISSING",
      "AGENT_WALLET_MASTER_KEY must be 32 bytes of hex.",
    );
  }

  return Buffer.from(hex, "hex");
}

function wrappingKey(agentId: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKeyBytes(), salt, `${INFO_PREFIX}${agentId}`, 32));
}

export function createIsolatedWallet(agentId: string): {
  readonly record: AgentWalletRecord;
  readonly address: `0x${string}`;
} {
  const privateKey = randomBytes(32);
  const account = privateKeyToAccount(`0x${privateKey.toString("hex")}` as Hex);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = wrappingKey(agentId, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
  const tag = cipher.getAuthTag();

  privateKey.fill(0);

  const now = Math.floor(Date.now() / 1000);
  return {
    address: account.address,
    record: {
      agentId,
      address: account.address,
      ciphertext: Buffer.concat([ciphertext, tag]).toString("hex"),
      nonce: nonce.toString("hex"),
      salt: salt.toString("hex"),
      createdAt: now,
    },
  };
}

/**
 * Decrypt one agent's key. The caller must not persist, log, or return the result.
 */
export function unlockWallet(record: AgentWalletRecord): Hex {
  const salt = Buffer.from(record.salt, "hex");
  const nonce = Buffer.from(record.nonce, "hex");
  const packed = Buffer.from(record.ciphertext, "hex");
  if (packed.length < 17) {
    throw new AgentError("CONFIG_MISSING", "That agent wallet record is corrupted.");
  }

  const ciphertext = packed.subarray(0, packed.length - 16);
  const tag = packed.subarray(packed.length - 16);
  const key = wrappingKey(record.agentId, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);

  try {
    const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const hex = `0x${privateKey.toString("hex")}` as Hex;
    privateKey.fill(0);
    return hex;
  } catch {
    throw new AgentError(
      "CONFIG_MISSING",
      "That agent wallet could not be unlocked. The wrapping key may have changed.",
    );
  }
}

export function addressOf(record: AgentWalletRecord): `0x${string}` {
  return record.address;
}
