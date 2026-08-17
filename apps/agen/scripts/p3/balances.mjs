import { readFileSync } from "node:fs";
import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const key = readFileSync("/tmp/agen-p3/owner.key", "utf8").trim();
const owner = privateKeyToAccount(key);
const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });

const targets = {
  "owner (from key)": owner.address,
  "atlas agent wallet": "0xE8b599B85f6421a4a73609bc8463BcfE960860f0",
  "egent agent wallet": "0xB247e60412DfF55B7546b5CB97A383dC533A995C",
};
console.log("chain id:", await client.getChainId());
for (const [label, address] of Object.entries(targets)) {
  console.log(label.padEnd(20), address, formatEther(await client.getBalance({ address })), "ETH");
}
