/* =========================================================
   APEPIX mint dApp — static, GitHub Pages ready
   Contract: 0x27f699e4430e9b7C66c9Ac3C17aB377539041391
   Chain:    Robinhood Chain (default MAINNET — see ACTIVE below)
   ========================================================= */

const CONTRACT_ADDRESS = "0x27f699e4430e9b7C66c9Ac3C17aB377539041391";

/* ---------- RPC endpoints ----------
   Official endpoint first, then public mirrors (PublicNode, dRPC,
   OrdoFi, BlockMachine). ALL reads — stats, balances, gas, receipts —
   go through this pool with automatic failover. The wallet provider
   is ONLY used for signing/sending transactions. */
const RPCS = [
  { name: "Robinhood",    url: "https://rpc.mainnet.chain.robinhood.com" },
  { name: "PublicNode",   url: "https://robinhood-rpc.publicnode.com" },
  { name: "dRPC",         url: "https://robinhood.drpc.org" },
  { name: "OrdoFi",       url: "https://rpc.ordofi.network" },
  { name: "BlockMachine", url: "https://rpc-robinhood.blockmachine.io" },
];

const NETWORKS = {
  mainnet: {
    label: "Robinhood Chain",
    chainIdHex: "0x1237", // 4663
    rpcUrls: RPCS.map((r) => r.url), // wallets get every mirror too (their own failover)
    explorer: "https://robinhoodchain.blockscout.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
  testnet: {
    label: "Robinhood Chain Testnet",
    chainIdHex: "0xb626", // 46630
    rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
    explorer: "https://explorer.testnet.chain.robinhood.com",
    currency: { name: "Ether", symbol: "ETH", decimals: 18 },
  },
};
const ACTIVE = NETWORKS.mainnet; // ← change to NETWORKS.testnet for testnet
const ACTIVE_CHAIN_ID = parseInt(ACTIVE.chainIdHex, 16);

/* ---------- fee strategy (aggressive — block base-fee method) ----------
   Matches the reference calculation exactly:
     BASE    = baseFeePerGas of the latest block  (eth_getBlockByNumber "latest")
     MAX_FEE = BASE + BASE / 2                    (base fee + 50%)
   Transactions are sent with maxFeePerGas = MAX_FEE and priority fee 0
   (standard on Arbitrum Orbit chains). The same MAX_FEE powers the
   "Not enough ETH" affordability check => worst-case pricing. */
const FEE_TTL = 20000;              // re-read the latest block every 20s
const GAS_HEADROOM = 120;           // +20% gas units on estimateGas
const PAID_GAS_FALLBACK = 600000n;  // used when estimateGas reverts (e.g. paused)
const FREE_GAS_FALLBACK = 450000n;

/* Minimal human-readable ABI (mint site only) */
const ABI = [
  "function mint(uint256 _mintAmount) payable",
  "function claimFreeApepix()",
  "function maxSupply() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function paused() view returns (bool)",
  "function maxPaidMintAmountPerTx() view returns (uint8)",
  "function maxFreeMintPerWallet() view returns (uint8)",
  "function maxPaidMintPerWallet() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function freeMintsPerWallet(address) view returns (uint256)",
  "function paidMintsPerWallet(address) view returns (uint256)",
  "function freeNFTAlreadyMinted() view returns (uint256)",
  "function paidNFTAlreadyMinted() view returns (uint256)",
  "function FREE_MINT_SUPPLY() view returns (uint256)",
  "function PAID_MINT_SUPPLY() view returns (uint256)",
  "function freeMintDelay() view returns (uint256)",
  "function lastFreeMintTimestamp() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
];

/* ---------- state ---------- */
let wallet = null;   // { name, icon, eip1193 } — the injected wallet the user picked
let account = null;  // connected address
let IFACE = null;    // ethers Interface — created at boot once ethers is verified
let S = {
  maxSupply: 0n, totalSupply: 0n, cost: 0n, paused: false,
  maxPerTx: 1, maxFreeWallet: 0, maxPaidWallet: 0n,
  freeMinted: 0n, freeSupply: 0n, paidMinted: 0n, paidSupply: 0n,
  freeDelay: 0n, lastFreeTs: 0n,
  myFree: 0n, myPaid: 0n, myBalance: 0n,
  noEthPaid: false, noEthFree: false,
};

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const eth = (bn) => {
  const s = ethers.utils.formatEther(bn);
  return (Math.round(+s * 1e6) / 1e6).toString();
};
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* some wallets hand out lowercase/mixed-case addresses — ethers rejects
   non-EIP-55-checksummed ones on every contract call, so normalize once */
const normAddr = (a) => { try { return ethers.utils.getAddress(a); } catch { return a; } };

function toast(msg, type = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (type === "error" ? " error" : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function parseErr(e) {
  const m =
    e?.error?.message || e?.data?.message || e?.shortMessage || e?.message || "Transaction failed";
  if (/reject|denied/i.test(m)) return "You rejected the request in your wallet.";
  if (/insufficient funds/i.test(m)) return "Insufficient ETH balance for gas + cost.";
  if (/paused/i.test(m)) return "Minting is currently paused.";
  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

async function withTimeout(promise, ms = 6000) {
  let t;
  const to = new Promise((_, rej) => (t = setTimeout(() => rej(new Error("timeout")), ms)));
  const r = await Promise.race([promise, to]);
  clearTimeout(t);
  return r;
}

/* ---------- RPC pool with automatic failover ----------
   Each call starts at the last-known-good endpoint and walks the rest
   on failure. Endpoints that error, hang, or serve the wrong chain are
   benched for 45s. First healthy answer wins → the site keeps working
   even when the official RPC is down or rate-limited. */
const pool = RPCS.map((r) => ({ ...r, p: null, c: null, checked: false, downUntil: 0 }));
let pvIdx = 0;

function getP(i) {
  const e = pool[i];
  if (!e.p) {
    e.p = new ethers.providers.JsonRpcProvider(e.url, {
      name: ACTIVE.label, chainId: ACTIVE_CHAIN_ID,
    });
  }
  return e.p;
}

function roContract(p) {
  const e = pool.find((x) => x.p === p);
  if (!e.c) e.c = new ethers.Contract(CONTRACT_ADDRESS, ABI, p);
  return e.c;
}

/* Should this endpoint be benched for 45s?
   NO  → the node answered with a JSON-RPC application error over HTTP 200
         (e.g. an estimateGas revert "insufficient funds"): the endpoint is
         healthy, only THIS call failed.
   YES → transport trouble: timeout, network error, HTTP 429 rate-limit,
         HTTP 5xx, unparseable body, wrong chain. */
function endpointSick(err) {
  if (!err) return true;
  if (err.statusCode === 429 || (typeof err.statusCode === "number" && err.statusCode >= 500)) return true;
  if (err.error && typeof err.error.code === "number") return false;
  if (/timeout/i.test(err.message || "")) return true;
  return true;
}

async function pvCall(fn, timeout = 6000) {
  const order = [];
  for (let k = 0; k < pool.length; k++) order.push((pvIdx + k) % pool.length);
  const alive = order.filter((i) => pool[i].downUntil <= Date.now());
  const tryOrder = alive.length ? alive : order; // everything cooling down → retry anyway
  let lastErr = null;
  for (const i of tryOrder) {
    const e = pool[i];
    try {
      if (!e.checked) {
        // one-time sanity check: this endpoint must actually serve OUR chain
        const cid = await withTimeout(getP(i).send("eth_chainId", []), 5000);
        if (parseInt(cid, 16) !== ACTIVE_CHAIN_ID) throw new Error("wrong chainId " + cid);
        e.checked = true;
      }
      const r = await withTimeout(fn(getP(i)), timeout);
      if (pvIdx !== i) { pvIdx = i; renderRpc(); }
      e.downUntil = 0;
      return r;
    } catch (err) {
      lastErr = err;
      if (endpointSick(err)) {
        e.downUntil = Date.now() + 45000;
        console.warn("RPC failed:", e.name, err && err.message ? err.message : err);
      }
      // application error → endpoint stays healthy, just try the next one
    }
  }
  throw lastErr || new Error("all RPC endpoints failed");
}

const rd = (method, ...args) => pvCall((p) => roContract(p)[method](...args));

function renderRpc() {
  const el = $("rpcStatus");
  if (el) el.textContent = "RPC: " + pool[pvIdx].name;
}

/* ---------- aggressive fees + affordability ---------- */
let feeCache = { at: 0, mode: "none", base: 0n, maxFee: 0n, gasPrice: 0n };

/* BASE = baseFeePerGas of the latest block — identical to the reference calc:
   eth_getBlockByNumber("latest") → result.baseFeePerGas */
async function refreshFees(force = false) {
  const now = Date.now();
  if (!force && feeCache.at && now - feeCache.at < FEE_TTL) return feeCache;
  try {
    const blk = await pvCall((p) => p.getBlock("latest"), 9000);
    const base = blk && blk.baseFeePerGas ? BigInt(blk.baseFeePerGas) : 0n;
    if (base > 0n) {
      const maxFee = base + base / 2n; // BASE + BASE/2  →  base fee + 50%
      feeCache = { at: now, mode: "1559", base, maxFee, gasPrice: 0n };
      return feeCache;
    }
  } catch { /* fall through to legacy pricing */ }
  try {
    const gp = BigInt(await pvCall((p) => p.getGasPrice(), 9000));
    feeCache = { at: now, mode: "legacy", base: 0n, maxFee: 0n, gasPrice: gp + gp / 2n };
  } catch { /* keep previous cache */ }
  return feeCache;
}

function activeMaxFee() {
  return feeCache.mode === "1559" ? feeCache.maxFee : feeCache.gasPrice;
}

/* ---------- raw EIP-1193 send path (through the CHOSEN wallet) ----------
   Transactions are built EXACTLY like the reference calculation:
     maxFeePerGas = hex(BASE + BASE/2), maxPriorityFeePerGas = 0x0
   and sent via wallet.request("eth_sendTransaction") — no ethers signer
   wrapper (some injected-wallet bridges throw on it), full param control.
   ethers is still used for ABI encoding + all read calls. */
const hexWei = (v) => ethers.utils.hexValue(ethers.BigNumber.from(v)); // NOTE: BigNumber lives at ethers.BigNumber in the UMD build (NOT ethers.utils.BigNumber)

function isReject(e) {
  const m = (e && (e.message || (e.error && e.error.message))) || "";
  return /reject|denied/i.test(m);
}

/* send via the connected wallet; if it chokes on EIP-1559 fields, retry once with legacy gasPrice */
async function sendTx(tx) {
  if (!wallet || !wallet.eip1193) throw new Error("No wallet connected.");
  try {
    return await wallet.eip1193.request({ method: "eth_sendTransaction", params: [tx] });
  } catch (e) {
    if (isReject(e)) throw e;
    if (tx.maxFeePerGas) {
      const legacy = { ...tx };
      delete legacy.maxFeePerGas;
      delete legacy.maxPriorityFeePerGas;
      delete legacy.type;
      legacy.gasPrice = hexWei(activeMaxFee());
      try {
        return await wallet.eip1193.request({ method: "eth_sendTransaction", params: [legacy] });
      } catch (e2) {
        if (isReject(e2)) throw e2;
        throw e; // surface the original error
      }
    }
    throw e;
  }
}

/* poll the read pool for the receipt — wallet nodes can lag or shape oddly.
   true = mined ok · false = reverted · null = timed out */
async function waitForReceipt(hash) {
  for (let i = 0; i < 72; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const r = await pvCall((p) => p.send("eth_getTransactionReceipt", [hash]), 8000);
      if (r && r.blockNumber != null) {
        return r.status == null ? true : r.status === "0x1";
      }
    } catch { /* keep polling */ }
  }
  return null;
}

/* gas units per action — eth_estimateGas through the READ pool (cached 60s).
   Nodes balance-check estimates, so a `from` is required: before a wallet
   is connected we return the fallback constants instead. */
const unitsCache = new Map();
async function estimateUnits(kind, q = 1) {
  const key = kind + ":" + q;
  const hit = unitsCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.units;
  let units = 0n;
  if (account && IFACE) {
    try {
      const data = kind === "paid"
        ? IFACE.encodeFunctionData("mint", [BigInt(q)])
        : IFACE.encodeFunctionData("claimFreeApepix", []);
      const value = kind === "paid" ? hexWei(S.cost * BigInt(q)) : "0x0";
      const hex = await pvCall((p) => p.send("eth_estimateGas", [{
        from: account, to: CONTRACT_ADDRESS, data, value,
      }]), 9000);
      units = BigInt(hex);
    } catch { units = 0n; }
  }
  if (units > 0n) units = (units * BigInt(GAS_HEADROOM)) / 100n;
  else units = kind === "paid" ? PAID_GAS_FALLBACK : FREE_GAS_FALLBACK;
  unitsCache.set(key, { at: Date.now(), units });
  return units;
}

/* ---------- pre-flight balance check: can this wallet cover mint + aggressive gas? ---------- */
let affBusy = false;
async function updateAffordability() {
  if (affBusy) return;
  affBusy = true;
  try {
    await refreshFees();
    const r3 = (x) => Math.round(x * 1e6) / 1e6;
    const baseGwei = Number(feeCache.base) / 1e9;
    const maxGwei = Number(activeMaxFee()) / 1e9;
    $("gasLine").textContent = maxGwei > 0
      ? (baseGwei > 0
          ? `gas · base ${r3(baseGwei)} gwei → maxFee ${r3(maxGwei)} gwei (base + 50%)`
          : `gas · maxFee ${r3(maxGwei)} gwei (base + 50%)`)
      : "";

    if (!account) {
      S.noEthPaid = S.noEthFree = false;
      $("freeWarn").classList.add("hidden");
      $("paidWarn").classList.add("hidden");
      updateButtons();
      return;
    }
    const bal = S.myBalance;
    const fee = activeMaxFee();
    const q = Math.max(qty(), 1);

    // paid: mint price + gas
    const unitsPaid = await estimateUnits("paid", q);
    const gasPaid = unitsPaid * fee;
    const value = S.cost * BigInt(q);
    const needPaid = value + gasPaid;
    S.noEthPaid = bal < needPaid;
    const pw = $("paidWarn");
    if (S.noEthPaid) {
      pw.textContent = `Not enough ETH — need ~${eth(needPaid)} ETH (mint ${eth(value)} + gas ${eth(gasPaid)}), wallet has ${eth(bal)} ETH.`;
      pw.classList.remove("hidden");
    } else pw.classList.add("hidden");

    // free: gas only
    const unitsFree = await estimateUnits("free");
    const gasFree = unitsFree * fee;
    S.noEthFree = bal < gasFree;
    const fw = $("freeWarn");
    if (S.noEthFree) {
      fw.textContent = `Not enough ETH for gas — need ~${eth(gasFree)} ETH, wallet has ${eth(bal)} ETH.`;
      fw.classList.remove("hidden");
    } else fw.classList.add("hidden");

    updateButtons();
  } finally {
    affBusy = false;
  }
}

/* ---------- read-only stats (no wallet needed) ----------
   All 13 calls fire IN PARALLEL and each races across the RPC pool →
   boot is one round-trip instead of a 13-step sequential crawl. */
const STAT_SPECS = [
  ["maxSupply", "maxSupply", "b"],
  ["totalSupply", "totalSupply", "b"],
  ["cost", "cost", "b"],
  ["paused", "paused", "r"],
  ["maxPaidMintAmountPerTx", "maxPerTx", "n"],
  ["maxFreeMintPerWallet", "maxFreeWallet", "n"],
  ["maxPaidMintPerWallet", "maxPaidWallet", "b"],
  ["freeNFTAlreadyMinted", "freeMinted", "b"],
  ["FREE_MINT_SUPPLY", "freeSupply", "b"],
  ["paidNFTAlreadyMinted", "paidMinted", "b"],
  ["PAID_MINT_SUPPLY", "paidSupply", "b"],
  ["freeMintDelay", "freeDelay", "b"],
  ["lastFreeMintTimestamp", "lastFreeTs", "b"],
];

async function loadStats() {
  const res = await Promise.allSettled(STAT_SPECS.map(([m]) => withTimeout(rd(m), 16000)));
  let ok = 0;
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") return;
    ok++;
    const [, field, type] = STAT_SPECS[i];
    try {
      // ethers v5 returns BigNumber objects — normalize EVERYTHING to native
      // BigInt/Number so arithmetic below never mixes the two.
      if (type === "b") S[field] = BigInt(r.value);
      else if (type === "n") S[field] = Number(r.value);
      else S[field] = r.value;
    } catch { /* keep previous value */ }
  });
  renderStats();
  if (ok === 0) {
    $("freeInfo").textContent = "RPC unreachable — retrying…";
    setTimeout(loadStats, 15000);
  }
}

function renderStats() {
  $("statTotal").textContent = S.totalSupply ? fmt(S.totalSupply) : "—";
  $("statMax").textContent = S.maxSupply ? fmt(S.maxSupply) : "—";
  $("statPrice").textContent = S.cost ? eth(S.cost) + " ETH" : "—";
  $("statFreeLeft").textContent = S.freeSupply ? fmt(S.freeSupply - S.freeMinted) : "—";

  if (S.maxSupply) {
    const pct = Number((S.totalSupply * 10000n) / S.maxSupply) / 100;
    $("supplyText").textContent = `${fmt(S.totalSupply)} / ${fmt(S.maxSupply)}`;
    $("supplyBar").style.width = Math.min(pct, 100) + "%";
  }
  updateTotalCost();
  updateButtons();
  updatePaidInfo();
}

function updatePaidInfo() {
  if (!S.cost) return;
  const left = S.paidSupply ? Number(S.paidSupply - S.paidMinted) : null;
  let t = `${eth(S.cost)} ETH each · max ${S.maxPerTx}/tx`;
  if (left !== null) t += ` · ${fmt(left)} left`;
  if (S.paused) t += " · PAUSED";
  $("paidInfo").textContent = t;
}

/* free-mint status ticker (cooldown countdown, wallet caps) */
setInterval(() => {
  if (!S.freeSupply) return;
  const readyAt = Number(S.lastFreeTs + S.freeDelay) * 1000;
  const now = Date.now();
  const myLeft = S.maxFreeWallet ? S.maxFreeWallet - Number(S.myFree) : null;
  const globalLeft = Number(S.freeSupply - S.freeMinted);

  if (globalLeft <= 0) {
    $("freeInfo").textContent = "Free mint sold out";
  } else if (myLeft !== null && myLeft <= 0) {
    $("freeInfo").textContent = `Wallet limit reached (${S.maxFreeWallet})`;
  } else if (now < readyAt) {
    const s = Math.ceil((readyAt - now) / 1000);
    $("freeInfo").textContent =
      `Next free mint in ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  } else {
    $("freeInfo").textContent =
      `Available · ${fmt(globalLeft)} left` + (myLeft !== null ? ` · ${myLeft} for you` : "");
  }
  updateButtons();
}, 1000);

/* refresh fees + affordability every 20s (covers balance/fee changes,
   and keeps the gas line fresh even before a wallet is connected) */
setInterval(() => updateAffordability(), 20000);

/* ---------- multi-wallet discovery (EIP-6963 + legacy injection) ----------
   EIP-6963: MetaMask, Phantom, Coinbase, Rabby, Trust, OKX, Brave… all
   announce themselves via `eip6963:announceProvider` when asked. Legacy
   window.XXX detection covers older wallet builds. The user picks one
   from the picker modal — no more hard-coded window.ethereum. */
const eip6963Wallets = new Map(); // uuid → { name, icon, rdns, eip1193 }
window.addEventListener("eip6963:announceProvider", (e) => {
  if (!e.detail || !e.detail.info || !e.detail.provider) return;
  eip6963Wallets.set(e.detail.info.uuid, {
    name: e.detail.info.name || "Wallet",
    icon: e.detail.info.icon || "",
    rdns: e.detail.info.rdns || "",
    eip1193: e.detail.provider,
  });
});
function requestWalletAnnounce() {
  try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch { /* old wallets */ }
}
requestWalletAnnounce(); // wallets announce as soon as they see this

const EMOJI = {
  MetaMask: "🦊", Phantom: "👻", "Coinbase Wallet": "🔵", Rabby: "🐰",
  "Trust Wallet": "🛡️", "Brave Wallet": "🦁", "OKX Wallet": "⛓️", Taho: "🐢",
  Zerion: "🌀", Frame: "🖼️", "Bitget Wallet": "🟡", TokenPocket: "🔵", MathWallet: "🧮",
};
const emojiFor = (name) => EMOJI[name] || "👛";

function legacyWallets() {
  const out = [];
  const push = (name, icon, eip) => {
    if (eip && !out.some((w) => w.eip1193 === eip)) out.push({ name, icon, rdns: "", eip1193: eip });
  };
  const nameOf = (p) => {
    if (p.isRabby) return "Rabby";
    if (p.isTrust || p.isTrustWallet) return "Trust Wallet";
    if (p.isCoinbaseWallet) return "Coinbase Wallet";
    if (p.isPhantom) return "Phantom";
    if (p.isBraveWallet) return "Brave Wallet";
    if (p.isBitKeep) return "Bitget Wallet";
    if (p.isTokenPocket) return "TokenPocket";
    if (p.isMathWallet) return "MathWallet";
    if (p.isCoin98) return "Coin98";
    if (p.isFrame) return "Frame";
    if (p.isTally || p.isTaho) return "Taho";
    if (p.isZerion) return "Zerion";
    if (p.isMetaMask) return "MetaMask";
    return "Browser Wallet";
  };
  const em = window.ethereum;
  if (em) {
    if (Array.isArray(em.providers)) em.providers.forEach((p) => push(nameOf(p), emojiFor(nameOf(p)), p));
    else push(nameOf(em), emojiFor(nameOf(em)), em);
  }
  push("Phantom", "👻", window.phantom && window.phantom.ethereum);
  push("OKX Wallet", "⛓️", window.okxwallet);
  push("Coinbase Wallet", "🔵", window.coinbaseWalletExtension);
  return out;
}

function discoveredWallets() {
  requestWalletAnnounce();
  const list = [];
  const add = (w) => {
    if (!w || !w.eip1193) return;
    if (list.some((x) => x.eip1193 === w.eip1193)) return;
    if (list.some((x) =>
      (x.rdns && w.rdns && x.rdns === w.rdns) ||
      x.name.toLowerCase() === w.name.toLowerCase())) return;
    list.push(w);
  };
  eip6963Wallets.forEach(add);
  legacyWallets().forEach(add);
  return list;
}

const INSTALL_LINKS = [
  { name: "MetaMask", icon: "🦊", url: "https://metamask.io/download/" },
  { name: "Phantom", icon: "👻", url: "https://phantom.app/download" },
  { name: "Coinbase Wallet", icon: "🔵", url: "https://www.coinbase.com/wallet/downloads" },
  { name: "Rabby", icon: "🐰", url: "https://rabby.io/" },
];

function renderWalletList() {
  const found = discoveredWallets();
  const box = $("walletList");
  box.innerHTML = "";
  found.forEach((w) => {
    const b = document.createElement("button");
    b.className = "wallet-item";
    b.innerHTML =
      `<span class="wi-icon"><i>${escapeHtml(emojiFor(w.name))}</i>${w.icon ? `<img src="${w.icon}" alt="" onerror="this.remove()" />` : ""}</span>` +
      `<span class="wi-name">${escapeHtml(w.name)}</span><span class="wi-state">Detected</span>`;
    b.onclick = () => pickWallet(w);
    box.appendChild(b);
  });
  INSTALL_LINKS.forEach((l) => {
    if (found.some((w) => w.name.toLowerCase() === l.name.toLowerCase())) return;
    const a = document.createElement("a");
    a.className = "wallet-item wallet-missing";
    a.href = l.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML =
      `<span class="wi-icon"><i>${l.icon}</i></span>` +
      `<span class="wi-name">${l.name}</span><span class="wi-state">Not installed ↗</span>`;
    box.appendChild(a);
  });
  if (!found.length) {
    const p = document.createElement("p");
    p.className = "sub";
    p.textContent = "No wallet detected. Install one below — or open this site inside your wallet app's built-in browser on mobile.";
    box.appendChild(p);
  }
}

function openWalletPicker() {
  if (typeof ethers === "undefined") {
    toast("ethers.js failed to load — check your connection and refresh.", "error");
    return;
  }
  renderWalletList();
  $("walletModal").classList.remove("hidden");
}

/* ---------- connect / switch / events ---------- */
let walletHandlers = null;
function detachWalletEvents() {
  if (!walletHandlers) return;
  try {
    if (walletHandlers.eip.removeListener) {
      walletHandlers.eip.removeListener("accountsChanged", walletHandlers.onAcc);
      walletHandlers.eip.removeListener("chainChanged", walletHandlers.onChain);
    }
  } catch { /* ignore */ }
  walletHandlers = null;
}

function attachWalletEvents(eip) {
  detachWalletEvents();
  const onAcc = async (accs) => {
    if (!accs || !accs.length) {
      resetWalletUi();
      toast("Wallet disconnected.");
      return;
    }
    if (accs[0] === account) return;
    account = normAddr(accs[0]);
    try { await onConnected(); } catch (e) { toast(parseErr(e), "error"); }
  };
  const onChain = () => location.reload(); // covers manual switches + our switchNetwork
  try {
    if (eip.on) { eip.on("accountsChanged", onAcc); eip.on("chainChanged", onChain); }
    walletHandlers = { eip, onAcc, onChain };
  } catch { /* wallet without event support */ }
}

function resetWalletUi() {
  account = null;
  $("connectBtn").textContent = "Connect Wallet";
  $("connectBtn").title = "";
  $("connectBtn").classList.remove("btn-ghost");
  $("walletAddr").textContent = "";
  S.myFree = S.myPaid = S.myBalance = 0n;
  S.noEthPaid = S.noEthFree = false;
  $("freeWarn").classList.add("hidden");
  $("paidWarn").classList.add("hidden");
  updateButtons();
}

async function pickWallet(w) {
  $("walletModal").classList.add("hidden");
  try {
    const accs = await w.eip1193.request({ method: "eth_requestAccounts" });
    if (!accs || !accs.length) throw new Error("No account authorized.");
    wallet = { name: w.name, icon: w.icon || "", eip1193: w.eip1193 };
    account = normAddr(accs[0]);
    attachWalletEvents(wallet.eip1193);
    const cid = await wallet.eip1193.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== ACTIVE_CHAIN_ID) {
      const ok = await switchNetwork();
      if (!ok) { resetWalletUi(); return; }
    }
    await onConnected();
    checkPill();
  } catch (e) {
    if (isReject(e)) toast("Connection rejected in " + (w.name || "wallet") + ".", "error");
    else toast(parseErr(e), "error");
  }
}

async function switchNetwork() {
  const eip = wallet ? wallet.eip1193 : window.ethereum;
  if (!eip) { toast("No wallet connected.", "error"); return false; }
  try {
    await eip.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ACTIVE.chainIdHex }],
    });
    return true;
  } catch (e) {
    if (e.code === 4902 || /Unrecognized chain|not been added/i.test(e?.message || "")) {
      try {
        await eip.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: ACTIVE.chainIdHex,
            chainName: ACTIVE.label,
            rpcUrls: ACTIVE.rpcUrls, // includes every public mirror for the wallet's own failover
            nativeCurrency: ACTIVE.currency,
            blockExplorerUrls: [ACTIVE.explorer],
          }],
        });
        return true;
      } catch (e2) {
        toast(parseErr(e2), "error");
        return false;
      }
    }
    toast(parseErr(e), "error");
    return false;
  }
}

async function onConnected() {
  const nm = wallet && wallet.name ? wallet.name.split(" ")[0] : "Wallet";
  $("connectBtn").textContent = nm + " · " + short(account);
  $("connectBtn").title = (wallet && wallet.name ? wallet.name + " — click to switch" : "");
  $("connectBtn").classList.add("btn-ghost");
  $("walletAddr").textContent = "Connected: " + account;
  await loadWalletData();
  toast("Wallet connected: " + short(account) + " · " + nm);
}

async function loadWalletData() {
  if (!account) return;
  const [f, pd, bal] = await Promise.allSettled([
    rd("freeMintsPerWallet", account),
    rd("paidMintsPerWallet", account),
    pvCall((p) => p.getBalance(account)),
  ]);
  if (f.status === "fulfilled") S.myFree = BigInt(f.value);
  if (pd.status === "fulfilled") S.myPaid = BigInt(pd.value);
  if (bal.status === "fulfilled") S.myBalance = BigInt(bal.value);
  $("walletAddr").textContent = `Connected: ${account} · ${eth(S.myBalance)} ETH`;
  renderStats();
  await updateAffordability();
}

/* ---------- button state ---------- */
function updateButtons() {
  const connected = !!account;
  if (!connected) {
    $("freeMintBtn").disabled = false;
    $("freeMintBtn").textContent = "Connect";
    $("paidMintBtn").disabled = false;
    $("paidMintBtn").textContent = "Connect to mint";
    return;
  }
  const freeReady = !S.paused && !S.noEthFree &&
    S.freeSupply > S.freeMinted &&
    (S.maxFreeWallet ? Number(S.myFree) < S.maxFreeWallet : true);
  const paidReady = !S.paused && !S.noEthPaid && S.cost > 0n && S.paidSupply > S.paidMinted && qty() > 0;

  $("freeMintBtn").disabled = !freeReady;
  $("freeMintBtn").textContent =
    S.paused ? "Paused" : (S.noEthFree ? "Not enough ETH" : "Claim");
  $("paidMintBtn").disabled = !paidReady;
  $("paidMintBtn").textContent =
    S.paused ? "Paused" : (S.noEthPaid ? "Not enough ETH" : "Mint");
}

/* ---------- qty / cost ---------- */
function qty() {
  const v = parseInt($("qtyInput").value, 10);
  return isNaN(v) ? 0 : Math.max(v, 0);
}
function clampQty(v) {
  let max = S.maxPerTx || 1;
  if (S.maxPaidWallet > 0n) {
    const left = Number(S.maxPaidWallet - S.myPaid);
    if (left > 0) max = Math.min(max, left);
  }
  if (S.paidSupply) max = Math.min(max, Number(S.paidSupply - S.paidMinted));
  max = Math.max(1, max);
  // balance-aware MAX: leave room for aggressive gas before dividing by price
  if (S.cost > 0n && S.myBalance > 0n && activeMaxFee() > 0n) {
    const gasReserve = PAID_GAS_FALLBACK * activeMaxFee();
    const affordable = (S.myBalance - gasReserve) / S.cost;
    if (affordable >= 1n) max = Math.min(max, Number(affordable));
  }
  return Math.max(1, Math.min(v, max));
}
function updateTotalCost() {
  const q = qty();
  $("totalCost").textContent = (S.cost && q ? eth(S.cost * BigInt(q)) : "—") + " ETH";
}

/* ---------- tx modal ---------- */
function showPending(msg) {
  $("txSpinner").classList.remove("hidden");
  $("txCheck").classList.add("hidden");
  $("txClose").classList.add("hidden");
  $("txLink").classList.add("hidden");
  $("txTitle").textContent = "Transaction pending…";
  $("txMsg").textContent = msg || "Confirm the transaction in your wallet.";
  $("txModal").classList.remove("hidden");
}
function showDone(hash) {
  $("txSpinner").classList.add("hidden");
  $("txCheck").classList.remove("hidden");
  $("txClose").classList.remove("hidden");
  $("txTitle").textContent = "Mint successful!";
  $("txMsg").textContent = "Your APEPIX is on the way.";
  if (hash) {
    $("txLink").href = `${ACTIVE.explorer}/tx/${hash}`;
    $("txLink").classList.remove("hidden");
  }
}
function showSettled(title, msg, hash) {
  $("txSpinner").classList.add("hidden");
  $("txCheck").classList.remove("hidden");
  $("txClose").classList.remove("hidden");
  $("txTitle").textContent = title;
  $("txMsg").textContent = msg;
  if (hash) {
    $("txLink").href = `${ACTIVE.explorer}/tx/${hash}`;
    $("txLink").classList.remove("hidden");
  }
}
function showError(msg) {
  $("txSpinner").classList.add("hidden");
  $("txCheck").classList.add("hidden");
  $("txClose").classList.remove("hidden");
  $("txTitle").textContent = "Transaction failed";
  $("txMsg").textContent = msg;
}
$("txClose").onclick = () => $("txModal").classList.add("hidden");
$("txModal").addEventListener("click", (e) => {
  if (e.target === $("txModal")) $("txModal").classList.add("hidden");
});

/* ---------- mint actions ----------
   Gas is estimated through the read pool; the tx itself is signed by
   whichever wallet the user picked in the picker. */
async function paidMint() {
  if (!account) return openWalletPicker();
  await refreshFees(true);
  await updateAffordability();
  if (S.noEthPaid) return showError($("paidWarn").textContent);
  if (!IFACE) return showError("ethers.js failed to load — refresh the page.");
  const q = clampQty(qty());
  const valueBn = ethers.BigNumber.from(S.cost).mul(q);
  const fee = activeMaxFee();
  if (!fee) return showError("Gas fee unavailable — please retry in a moment.");
  showPending(`Minting ${q} APEPIX for ${eth(valueBn)} ETH…`);
  try {
    const units = await estimateUnits("paid", q); // estimate +20%, or fallback constant
    const tx = {
      from: account,
      to: CONTRACT_ADDRESS,
      chainId: ethers.utils.hexValue(ACTIVE_CHAIN_ID),
      value: hexWei(valueBn),
      data: IFACE.encodeFunctionData("mint", [BigInt(q)]),
      gas: hexWei(units),
      type: "0x2",
      maxFeePerGas: hexWei(fee),
      maxPriorityFeePerGas: "0x0",
    };
    const hash = await sendTx(tx);
    if (!hash || typeof hash !== "string") throw new Error("Wallet returned no transaction hash.");
    $("txMsg").textContent = "Waiting for confirmation…";
    const ok = await waitForReceipt(hash);
    if (ok === false) return showError("Transaction reverted on-chain — check the explorer for details.");
    if (ok === null) return showSettled("Still processing…", "The transaction hasn't confirmed yet — follow it on the explorer.", hash);
    showDone(hash);
    toast(`Successfully minted ${q} APEPIX!`);
    await Promise.all([loadStats(), loadWalletData()]);
  } catch (e) {
    showError(parseErr(e));
  }
}

async function freeMint() {
  if (!account) return openWalletPicker();
  await refreshFees(true);
  await updateAffordability();
  if (S.noEthFree) return showError($("freeWarn").textContent);
  if (!IFACE) return showError("ethers.js failed to load — refresh the page.");
  const fee = activeMaxFee();
  if (!fee) return showError("Gas fee unavailable — please retry in a moment.");
  showPending("Claiming your free APEPIX…");
  try {
    const units = await estimateUnits("free"); // estimate +20%, or fallback constant
    const tx = {
      from: account,
      to: CONTRACT_ADDRESS,
      chainId: ethers.utils.hexValue(ACTIVE_CHAIN_ID),
      value: "0x0",
      data: IFACE.encodeFunctionData("claimFreeApepix", []),
      gas: hexWei(units),
      type: "0x2",
      maxFeePerGas: hexWei(fee),
      maxPriorityFeePerGas: "0x0",
    };
    const hash = await sendTx(tx);
    if (!hash || typeof hash !== "string") throw new Error("Wallet returned no transaction hash.");
    $("txMsg").textContent = "Waiting for confirmation…";
    const ok = await waitForReceipt(hash);
    if (ok === false) return showError("Transaction reverted on-chain — check the explorer for details.");
    if (ok === null) return showSettled("Still processing…", "The transaction hasn't confirmed yet — follow it on the explorer.", hash);
    showDone(hash);
    toast("Free APEPIX claimed!");
    await Promise.all([loadStats(), loadWalletData()]);
  } catch (e) {
    showError(parseErr(e));
  }
}

/* ---------- pixel ape canvas ---------- */
const APE_MAP = [
"................",
"...oooooooooo...",
"..obbbbbbbbbbo..",
".obbbbbbbbbbbbo.",
".obbooooooooobbo",
"oobffffffffffboo",
"oobfeepffpeefboo",
"oobfeepffpeefboo",
"oobffffffffffboo",
"oobfffnnffnnfboo",
".obffffffffffbo.",
".obffmmmmmmffbo.",
"..obffffffffbo..",
"..oobbbbbbbboo..",
"....oooooooo....",
"................",
];
const BASE_PALETTE = {
  o: "#181008", b: "#8a5a2b", f: "#eec387",
  e: "#ffffff", p: "#0a0a0a", n: "#c2803f", m: "#8a3f14",
};

function drawApe() {
  const cv = $("apeCanvas"), ctx = cv.getContext("2d");
  // subtle random fur tint per page load
  const pal = { ...BASE_PALETTE };
  const hue = Math.floor(Math.random() * 360);
  pal.b = `hsl(${hue} 42% 36%)`;
  pal.f = `hsl(${(hue + 20) % 360} 60% 74%)`;
  ctx.clearRect(0, 0, 16, 16);
  APE_MAP.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      ctx.fillStyle = pal[ch];
      ctx.fillRect(x, y, 1, 1);
    });
  });
}

/* Show square.png inside the art frame. If the file is missing/broken,
   fall back to the procedurally drawn pixel ape so the frame is never empty. */
function loadArt() {
  const img = $("apeArt"), cv = $("apeCanvas");
  const useImg = () => {
    img.classList.remove("hidden");
    cv.classList.add("hidden");
    // small pixel art → keep crisp nearest-neighbor upscaling;
    // larger images → smooth scaling instead of a crunchy downscale
    img.style.imageRendering = img.naturalWidth > 0 && img.naturalWidth <= 208 ? "pixelated" : "auto";
  };
  const useFallback = () => {
    img.classList.add("hidden");
    cv.classList.remove("hidden");
    drawApe();
  };
  if (img.complete) (img.naturalWidth > 0 ? useImg : useFallback)();
  else { img.onload = useImg; img.onerror = useFallback; }
}

/* ---------- UI wiring ---------- */
$("connectBtn").onclick = openWalletPicker;
$("freeMintBtn").onclick = freeMint;
$("paidMintBtn").onclick = paidMint;
$("walletClose").onclick = () => $("walletModal").classList.add("hidden");
$("walletModal").addEventListener("click", (e) => {
  if (e.target === $("walletModal")) $("walletModal").classList.add("hidden");
});
$("networkPill").onclick = async () => {
  if (!wallet && !window.ethereum) return toast("No wallet found — install MetaMask or Phantom.", "error");
  if (!account) return openWalletPicker();
  const ok = await switchNetwork();
  if (ok) {
    toast("Switched to " + ACTIVE.label);
    checkPill();
  }
};
$("rpcStatus").onclick = () => {
  pvIdx = (pvIdx + 1) % pool.length;
  pool.forEach((e) => { e.downUntil = 0; });
  renderRpc();
  toast("RPC endpoint → " + pool[pvIdx].name);
  refreshFees(true).then(() => updateAffordability());
  loadStats();
};
$("qtyMinus").onclick = () => { $("qtyInput").value = Math.max(1, qty() - 1); updateTotalCost(); updateAffordability(); };
$("qtyPlus").onclick  = () => { $("qtyInput").value = clampQty(qty() + 1); updateTotalCost(); updateAffordability(); };
$("qtyMax").onclick   = () => { $("qtyInput").value = clampQty(999999); updateTotalCost(); updateAffordability(); };
$("qtyInput").oninput = () => { updateTotalCost(); updateButtons(); updateAffordability(); };

async function checkPill() {
  const eip = wallet ? wallet.eip1193 : window.ethereum;
  if (!eip) {
    $("networkPill").textContent = "NO WALLET";
    $("networkPill").className = "pill pill-wrong";
    return;
  }
  try {
    const chainId = await eip.request({ method: "eth_chainId" });
    if (parseInt(chainId, 16) === ACTIVE_CHAIN_ID) {
      $("networkPill").textContent = ACTIVE.label.toUpperCase() + " ✓";
      $("networkPill").className = "pill pill-ok";
    } else {
      $("networkPill").textContent = "WRONG NETWORK — SWITCH";
      $("networkPill").className = "pill pill-wrong";
    }
  } catch { /* ignore */ }
}

/* ---------- boot ---------- */
(async function init() {
  loadArt();
  if (typeof ethers === "undefined") {
    $("freeInfo").textContent = "Failed to load ethers.js — check your connection and refresh.";
    return;
  }
  IFACE = new ethers.utils.Interface(ABI);
  $("contractLink").textContent = short(CONTRACT_ADDRESS);
  $("contractLink").href = `${ACTIVE.explorer}/address/${CONTRACT_ADDRESS}`;
  $("footerContract").textContent = "Contract: " + CONTRACT_ADDRESS;
  renderRpc();
  loadStats();                        // parallel reads via the RPC pool — no wallet needed
  checkPill();
  updateButtons();
  updateAffordability();              // live gas line even before a wallet is connected
  setTimeout(updateAffordability, 10000); // retry — first RPC hit can be slow (cold connection)
})();
