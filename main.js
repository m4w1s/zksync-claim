import { readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { gotScraping } from 'got-scraping';

const rpcUrl = 'https://zksync.drpc.org';
const gasPrice = {
  claim: {
    maxFeePerGas: ethers.parseUnits('0.25', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.15', 'gwei'),
  },
  withdraw: {
    maxFeePerGas: ethers.parseUnits('0.25', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('0.15', 'gwei'),
  },
};

const provider = new ethers.JsonRpcProvider(rpcUrl);
const allocations = readAllocations();
const wallets = readWallets();
const startTime = 1718606700000;

Promise
  .allSettled(
    wallets.map((wallet) => processWallet(wallet.wallet, wallet.withdrawAddress, wallet.proxy))
  )
  .then(() => {
    console.log('All wallets processed!');
  });

async function processWallet(wallet, withdrawAddress, proxy) {
  const allocation = await getAllocation(wallet.address, proxy);

  console.log(`[${wallet.address}] Allocation of ${ethers.formatUnits(allocation.tokenAmount, 18)} ZK loaded!`);

  if (Date.now() < startTime) {
    console.log(`[${wallet.address}] Waiting for claim to start...`);
    console.log();

    await waitUntil(startTime);
  }

  await claim(wallet, allocation);

  if (withdrawAddress) {
    await withdraw(wallet, withdrawAddress);
  }
}

async function withdraw(wallet, withdrawAddress) {
  const contract = getTokenContract(wallet);
  const balance = await contract.balanceOf.staticCall(wallet.address);

  if (balance <= 0n) {
    console.log(`[${wallet.address}] Nothing to withdraw!`);

    return;
  }

  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await wallet.getNonce();
      }

      const transaction = await contract.transfer(withdrawAddress, balance, {
        ...gasPrice.withdraw,
        nonce,
      });

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Withdraw error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Withdrawn ${ethers.formatUnits(balance, 18)} ZK to ${withdrawAddress} successfully!\x1b[0m`);
}

async function claim(wallet, allocation) {
  const contract = getClaimContract(allocation.contractAddress, wallet);
  const isClaimed = await contract.isClaimed.staticCall(allocation.merkleIndex);

  if (isClaimed) {
    console.log(`[${wallet.address}] Already claimed!`);

    return;
  }

  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await wallet.getNonce();
      }

      const transaction = await contract.claim(allocation.merkleIndex, allocation.tokenAmount, allocation.merkleProof, {
        ...gasPrice.claim,
        nonce,
      });

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Claim error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Claimed ${ethers.formatUnits(allocation.tokenAmount, 18)} ZK successfully!\x1b[0m`);
}

async function getAllocation(address, proxy) {
  address = address.toLowerCase();

  let allocation = allocations.find((alloc) => alloc.address.toLowerCase() === address);

  if (allocation) {
    return allocation;
  }

  try {
    const body = await gotScraping.get({
      url: 'https://api.zknation.io/eligibility',
      searchParams: {
        id: ethers.getAddress(address),
      },
      headers: {
        'Referer': 'https://claim.zknation.io/',
        'X-Api-Key': '46001d8f026d4a5bb85b33530120cd38',
      },
      proxyUrl: proxy,
      throwHttpErrors: true,
      resolveBodyOnly: true,
      responseType: 'json',
    });

    if (!Array.isArray(body.allocations) || !body.allocations.length) {
      console.error(`\x1b[31m[${ethers.getAddress(address)}] Not eligible!\x1b[0m`);

      const err = new Error('Not eligible!');
      err.silent = true;

      throw err;
    }

    allocation = {
      address,
      contractAddress: body.allocations[0].airdrop.contractAddress,
      tokenAmount: body.allocations[0].tokenAmount,
      merkleIndex: body.allocations[0].merkleIndex,
      merkleProof: body.allocations[0].merkleProof,
    };

    if (!allocation.contractAddress || !allocation.tokenAmount || !allocation.merkleIndex || !allocation.merkleProof) {
      throw new Error('Malformed eligibility response: ' + body);
    }
  } catch (e) {
    if (!e.silent) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${ethers.getAddress(address)}] Allocation loading error\x1b[0m`);
      console.log();
    }

    throw e;
  }

  allocations.push(allocation);
  writeAllocations();

  return allocation;
}

function readWallets() {
  const wallets = readFileSync(new URL('./data/wallets.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);
  const proxies = readFileSync(new URL('./data/proxies.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);

  return wallets.map((wallet, index) => {
    const [privateKey, withdrawAddress] = wallet.trim().split(':');
    let proxy = proxies[index]?.trim() || undefined;

    if (proxy) {
      if (!proxy.includes('@')) {
        const [host, port, username, password] = proxy.split(':');

        proxy = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
      }

      if (!proxy.includes('://')) {
        proxy = 'http://' + proxy;
      }

      proxy = new URL(proxy).href.replace(/\/$/, '');
    }

    return {
      wallet: new ethers.Wallet(privateKey, provider),
      withdrawAddress: ethers.isAddress(withdrawAddress) ? withdrawAddress : undefined,
      proxy,
    };
  });

  function isNonEmptyLine(line) {
    line = line.trim();

    return line && !line.startsWith('#');
  }
}

function readAllocations() {
  try {
    const data = readFileSync(new URL('./data/allocations.json', import.meta.url), 'utf8');
    const json = JSON.parse(data);

    if (Array.isArray(json)) {
      return json;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('\x1b[33mwarn!\x1b[0m \x1b[34m[reading data/allocations.json]\x1b[0m', e.message);
    }
  }

  return [];
}

function writeAllocations() {
  const data = JSON.stringify(allocations, null, 2);

  writeFileSync(new URL('./data/allocations.json', import.meta.url), data, 'utf8');
}

async function waitUntil(timestamp) {
  while (Date.now() < timestamp) {
    await sleep(Math.min(60_000, timestamp - Date.now()));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTokenContract(wallet) {
  const CONTRACT_ADDRESS = '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E';
  const ABI = JSON.parse('[{"inputs":[{"internalType":"uint256","name":"expiry","type":"uint256"}],"name":"DelegateSignatureExpired","type":"error"},{"inputs":[],"name":"DelegateSignatureIsInvalid","type":"error"},{"inputs":[],"name":"ERC6372InconsistentClock","type":"error"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"delegator","type":"address"},{"indexed":true,"internalType":"address","name":"fromDelegate","type":"address"},{"indexed":true,"internalType":"address","name":"toDelegate","type":"address"}],"name":"DelegateChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"delegate","type":"address"},{"indexed":false,"internalType":"uint256","name":"previousBalance","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"newBalance","type":"uint256"}],"name":"DelegateVotesChanged","type":"event"},{"anonymous":false,"inputs":[],"name":"EIP712DomainChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint8","name":"version","type":"uint8"}],"name":"Initialized","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"bytes32","name":"previousAdminRole","type":"bytes32"},{"indexed":true,"internalType":"bytes32","name":"newAdminRole","type":"bytes32"}],"name":"RoleAdminChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"address","name":"sender","type":"address"}],"name":"RoleGranted","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"address","name":"sender","type":"address"}],"name":"RoleRevoked","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[],"name":"BURNER_ADMIN_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"BURNER_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"CLOCK_MODE","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DEFAULT_ADMIN_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DELEGATION_TYPEHASH","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DOMAIN_SEPARATOR","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MINTER_ADMIN_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MINTER_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"_from","type":"address"},{"internalType":"uint256","name":"_amount","type":"uint256"}],"name":"burn","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint32","name":"pos","type":"uint32"}],"name":"checkpoints","outputs":[{"components":[{"internalType":"uint32","name":"fromBlock","type":"uint32"},{"internalType":"uint224","name":"votes","type":"uint224"}],"internalType":"struct ERC20VotesUpgradeable.Checkpoint","name":"","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"clock","outputs":[{"internalType":"uint48","name":"","type":"uint48"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"subtractedValue","type":"uint256"}],"name":"decreaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"delegatee","type":"address"}],"name":"delegate","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"delegatee","type":"address"},{"internalType":"uint256","name":"nonce","type":"uint256"},{"internalType":"uint256","name":"expiry","type":"uint256"},{"internalType":"uint8","name":"v","type":"uint8"},{"internalType":"bytes32","name":"r","type":"bytes32"},{"internalType":"bytes32","name":"s","type":"bytes32"}],"name":"delegateBySig","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_signer","type":"address"},{"internalType":"address","name":"_delegatee","type":"address"},{"internalType":"uint256","name":"_expiry","type":"uint256"},{"internalType":"bytes","name":"_signature","type":"bytes"}],"name":"delegateOnBehalf","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"delegates","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"eip712Domain","outputs":[{"internalType":"bytes1","name":"fields","type":"bytes1"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"version","type":"string"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"address","name":"verifyingContract","type":"address"},{"internalType":"bytes32","name":"salt","type":"bytes32"},{"internalType":"uint256[]","name":"extensions","type":"uint256[]"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"timepoint","type":"uint256"}],"name":"getPastTotalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"timepoint","type":"uint256"}],"name":"getPastVotes","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"}],"name":"getRoleAdmin","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"getVotes","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"grantRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"hasRole","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"addedValue","type":"uint256"}],"name":"increaseAllowance","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_admin","type":"address"},{"internalType":"address","name":"_mintReceiver","type":"address"},{"internalType":"uint256","name":"_mintAmount","type":"uint256"}],"name":"initialize","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_to","type":"address"},{"internalType":"uint256","name":"_amount","type":"uint256"}],"name":"mint","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"nonces","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"numCheckpoints","outputs":[{"internalType":"uint32","name":"","type":"uint32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"uint256","name":"deadline","type":"uint256"},{"internalType":"uint8","name":"v","type":"uint8"},{"internalType":"bytes32","name":"r","type":"bytes32"},{"internalType":"bytes32","name":"s","type":"bytes32"}],"name":"permit","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"renounceRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"revokeRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes4","name":"interfaceId","type":"bytes4"}],"name":"supportsInterface","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"amount","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
}

function getClaimContract(contractAddress, wallet) {
  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"_admin","type":"address"},{"internalType":"contract IMintableAndDelegatable","name":"_token","type":"address"},{"internalType":"bytes32","name":"_merkleRoot","type":"bytes32"},{"internalType":"uint256","name":"_maximumTotalClaimable","type":"uint256"},{"internalType":"uint256","name":"_windowStart","type":"uint256"},{"internalType":"uint256","name":"_windowEnd","type":"uint256"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[{"internalType":"address","name":"account","type":"address"},{"internalType":"uint256","name":"currentNonce","type":"uint256"}],"name":"InvalidAccountNonce","type":"error"},{"inputs":[],"name":"InvalidShortString","type":"error"},{"inputs":[{"internalType":"string","name":"str","type":"string"}],"name":"StringTooLong","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__AlreadyClaimed","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__ClaimAmountExceedsMaximum","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__ClaimWindowNotOpen","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__ClaimWindowNotYetClosed","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__ExpiredSignature","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__InvalidProof","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__InvalidSignature","type":"error"},{"inputs":[],"name":"ZkMerkleDistributor__SweepAlreadyDone","type":"error"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"ZkMerkleDistributor__Unauthorized","type":"error"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint256","name":"index","type":"uint256"},{"indexed":false,"internalType":"address","name":"account","type":"address"},{"indexed":false,"internalType":"uint256","name":"amount","type":"uint256"}],"name":"Claimed","type":"event"},{"anonymous":false,"inputs":[],"name":"EIP712DomainChanged","type":"event"},{"inputs":[],"name":"ADMIN","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"DOMAIN_SEPARATOR","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MAXIMUM_TOTAL_CLAIMABLE","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"MERKLE_ROOT","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"TOKEN","outputs":[{"internalType":"contract IMintableAndDelegatable","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"WINDOW_END","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"WINDOW_START","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"ZK_CLAIM_AND_DELEGATE_TYPEHASH","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"ZK_CLAIM_TYPEHASH","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint256","name":"_index","type":"uint256"},{"internalType":"uint256","name":"_amount","type":"uint256"},{"internalType":"bytes32[]","name":"_merkleProof","type":"bytes32[]"}],"name":"claim","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_index","type":"uint256"},{"internalType":"uint256","name":"_amount","type":"uint256"},{"internalType":"bytes32[]","name":"_merkleProof","type":"bytes32[]"},{"components":[{"internalType":"address","name":"delegatee","type":"address"},{"internalType":"uint256","name":"expiry","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"internalType":"struct ZkMerkleDistributor.DelegateInfo","name":"_delegateInfo","type":"tuple"}],"name":"claimAndDelegate","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_index","type":"uint256"},{"internalType":"uint256","name":"_amount","type":"uint256"},{"internalType":"bytes32[]","name":"_merkleProof","type":"bytes32[]"},{"components":[{"internalType":"address","name":"claimant","type":"address"},{"internalType":"uint256","name":"expiry","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"internalType":"struct ZkMerkleDistributor.ClaimSignatureInfo","name":"_claimSignatureInfo","type":"tuple"},{"components":[{"internalType":"address","name":"delegatee","type":"address"},{"internalType":"uint256","name":"expiry","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"internalType":"struct ZkMerkleDistributor.DelegateInfo","name":"_delegateInfo","type":"tuple"}],"name":"claimAndDelegateOnBehalf","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_index","type":"uint256"},{"internalType":"uint256","name":"_amount","type":"uint256"},{"internalType":"bytes32[]","name":"_merkleProof","type":"bytes32[]"},{"components":[{"internalType":"address","name":"claimant","type":"address"},{"internalType":"uint256","name":"expiry","type":"uint256"},{"internalType":"bytes","name":"signature","type":"bytes"}],"internalType":"struct ZkMerkleDistributor.ClaimSignatureInfo","name":"_claimSignatureInfo","type":"tuple"}],"name":"claimOnBehalf","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"eip712Domain","outputs":[{"internalType":"bytes1","name":"fields","type":"bytes1"},{"internalType":"string","name":"name","type":"string"},{"internalType":"string","name":"version","type":"string"},{"internalType":"uint256","name":"chainId","type":"uint256"},{"internalType":"address","name":"verifyingContract","type":"address"},{"internalType":"bytes32","name":"salt","type":"bytes32"},{"internalType":"uint256[]","name":"extensions","type":"uint256[]"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"invalidateNonce","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint256","name":"_index","type":"uint256"}],"name":"isClaimed","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"nonces","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"_unclaimedReceiver","type":"address"}],"name":"sweepUnclaimed","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"totalClaimed","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}]');

  return new ethers.Contract(contractAddress, ABI, wallet);
}
