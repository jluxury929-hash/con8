const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════════
// CON2 PRODUCTION BACKEND - REAL ETH TRANSACTIONS + FULL API
// All GET endpoints + POST conversion/withdrawal with REAL on-chain transactions
// ═══════════════════════════════════════════════════════════════════════════════

// CONFIGURATION
const TREASURY_PRIVATE_KEY = process.env.TREASURY_PRIVATE_KEY || '0x25603d4c315004b7c56f437493dc265651a8023793f01dc57567460634534c08';
const BACKEND_WALLET = '0x89226Fc817904c6E745dF27802d0c9D4c94573F1';
const FEE_RECIPIENT = BACKEND_WALLET;

// Live ETH Price
let ETH_PRICE = 3500;
let lastPriceUpdate = 0;

// RPC Endpoints (FREE PUBLIC FIRST)
const RPC_ENDPOINTS = [
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://eth.llamarpc.com',
  'https://cloudflare-eth.com',
  'https://eth-mainnet.g.alchemy.com/v2/j6uyDNnArwlEpG44o93SqZ0JixvE20Tq'
];

// Etherscan API
const ETHERSCAN_API_KEY = 'ZJJ7F4VVHUUSTMSIJ2PPYC3ARC4GYDE37N';

// Minimum backend balance for operations
const MIN_BACKEND_ETH = 0.01;
const GAS_RESERVE = 0.003;

// Cached balance
let cachedBalance = 0;
let lastBalanceCheck = 0;
let connectedRpc = 'none';

// Transaction history (in-memory)
const transactions = [];
let txIdCounter = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE FETCHING - Multiple sources with fallback
// ═══════════════════════════════════════════════════════════════════════════════

const PRICE_SOURCES = [
  { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', parse: (d) => parseFloat(d.price) },
  { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', parse: (d) => d.ethereum?.usd },
  { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', parse: (d) => parseFloat(d.data?.amount) },
];

async function fetchLiveEthPrice() {
  for (const source of PRICE_SOURCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(source.url, { 
        headers: { 'Accept': 'application/json', 'User-Agent': 'MEV-Backend/3.0' },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json();
        const price = source.parse(data);
        if (price && price > 100 && price < 100000) {
          ETH_PRICE = price;
          lastPriceUpdate = Date.now();
          console.log(`📊 ETH: $${ETH_PRICE.toFixed(2)} (${source.name})`);
          return;
        }
      }
    } catch (e) { continue; }
  }
}

fetchLiveEthPrice();
setInterval(fetchLiveEthPrice, 30000);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER & WALLET
// ═══════════════════════════════════════════════════════════════════════════════

async function getProvider() {
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      await provider.getBlockNumber();
      connectedRpc = rpc.split('//')[1].split('/')[0].split('.')[0];
      return provider;
    } catch (e) { continue; }
  }
  throw new Error('All RPC endpoints failed');
}

async function getWallet() {
  const provider = await getProvider();
  return new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
}

async function getBalanceViaEtherscan(address) {
  try {
    const url = `https://api.etherscan.io/api?module=account&action=balance&address=${address}&tag=latest&apikey=${ETHERSCAN_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === '1') return parseFloat(data.result) / 1e18;
  } catch (e) {}
  return null;
}

async function checkBalance() {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    cachedBalance = parseFloat(ethers.utils.formatEther(balance));
    lastBalanceCheck = Date.now();
    console.log(`💰 Balance: ${cachedBalance.toFixed(6)} ETH`);
  } catch (e) {
    const etherscanBal = await getBalanceViaEtherscan(BACKEND_WALLET);
    if (etherscanBal !== null) cachedBalance = etherscanBal;
  }
}

setTimeout(checkBalance, 2000);
setInterval(checkBalance, 30000);

// ═══════════════════════════════════════════════════════════════════════════════
// GET ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    version: '3.0.0',
    name: 'CON2 Production Backend',
    wallet: BACKEND_WALLET,
    ethPrice: ETH_PRICE,
    balance: cachedBalance,
    features: ['Real ETH transactions', 'Multi-RPC fallback', 'Live price feed']
  });
});

app.get('/status', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    res.json({
      status: 'online',
      wallet: wallet.address,
      balance: balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastPriceUpdate: new Date(lastPriceUpdate).toISOString(),
      rpc: connectedRpc,
      canTrade: balanceETH >= MIN_BACKEND_ETH,
      canWithdraw: balanceETH >= MIN_BACKEND_ETH,
      transactionCount: transactions.length
    });
  } catch (e) {
    res.json({ status: 'online', error: e.message, cachedBalance });
  }
});

app.get('/health', (req, res) => {
  res.json({ healthy: true, timestamp: Date.now(), ethPrice: ETH_PRICE });
});

app.get('/balance', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    res.json({
      address: wallet.address,
      balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      ethPrice: ETH_PRICE,
      lastUpdated: new Date().toISOString(),
      network: 'Mainnet'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/wallet/balance', async (req, res) => {
  try {
    const wallet = await getWallet();
    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    res.json({
      address: wallet.address,
      balanceETH,
      balanceUSD: balanceETH * ETH_PRICE,
      lastUpdated: new Date().toISOString(),
      network: 'Mainnet'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/eth-price', (req, res) => {
  res.json({ price: ETH_PRICE, lastUpdate: lastPriceUpdate, source: 'Multi-API' });
});

app.get('/transactions', (req, res) => {
  res.json({ count: transactions.length, data: transactions.slice(-50).reverse() });
});

app.get('/transactions/:id', (req, res) => {
  const tx = transactions.find(t => t.id === parseInt(req.params.id));
  if (tx) res.json(tx);
  else res.status(404).json({ error: 'Transaction not found' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST ENDPOINTS - REAL ETH TRANSACTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleConvert(req, res) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('💸 CONVERT/WITHDRAW REQUEST');

  try {
    const { to, toAddress, amount, amountETH, amountUSD, percentage, treasury } = req.body;
    const destination = to || toAddress || treasury || BACKEND_WALLET;

    console.log('📍 Destination:', destination);

    if (!destination || !destination.startsWith('0x') || destination.length !== 42) {
      return res.status(400).json({ error: 'Invalid destination address' });
    }

    // Calculate amount
    let ethAmount = parseFloat(amountETH || amount || 0);
    if (!ethAmount && amountUSD) {
      ethAmount = amountUSD / ETH_PRICE;
      console.log(`📊 Converted $${amountUSD} → ${ethAmount.toFixed(6)} ETH @ $${ETH_PRICE}`);
    }

    if (!ethAmount || ethAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    console.log('💰 Requested:', ethAmount.toFixed(6), 'ETH');

    // Get wallet
    const wallet = await getWallet();
    console.log('📡 RPC:', connectedRpc);
    console.log('👛 From:', wallet.address);

    const balance = await wallet.getBalance();
    const balanceETH = parseFloat(ethers.utils.formatEther(balance));
    console.log('💰 Balance:', balanceETH.toFixed(6), 'ETH');

    // Handle percentage
    if (percentage) {
      ethAmount = (balanceETH - GAS_RESERVE) * (percentage / 100);
      console.log(`📊 ${percentage}% = ${ethAmount.toFixed(6)} ETH`);
    }

    // Get gas price
    const gasPrice = await wallet.provider.getGasPrice();
    const gasCostWei = gasPrice.mul(21000).mul(2);
    const gasCostETH = parseFloat(ethers.utils.formatEther(gasCostWei));
    console.log('⛽ Gas estimate:', gasCostETH.toFixed(6), 'ETH');

    const totalNeeded = ethAmount + gasCostETH;
    if (totalNeeded > balanceETH) {
      const maxWithdrawable = Math.max(0, balanceETH - gasCostETH - 0.0005);
      console.log('❌ INSUFFICIENT BALANCE');
      return res.status(400).json({
        error: 'Insufficient balance (need amount + gas)',
        available: balanceETH,
        requested: ethAmount,
        gasEstimate: gasCostETH,
        totalNeeded,
        maxWithdrawable,
        ethPrice: ETH_PRICE
      });
    }

    // SEND REAL TRANSACTION
    console.log('📤 Sending transaction...');
    const tx = await wallet.sendTransaction({
      to: destination,
      value: ethers.utils.parseEther(ethAmount.toFixed(18)),
      maxFeePerGas: gasPrice.mul(2),
      maxPriorityFeePerGas: ethers.utils.parseUnits('2', 'gwei'),
      gasLimit: 21000
    });

    console.log('⏳ TX submitted:', tx.hash);
    const receipt = await tx.wait(1);
    const gasUsedETH = parseFloat(ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice)));

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ TRANSACTION CONFIRMED');
    console.log('💸 Sent:', ethAmount.toFixed(6), 'ETH');
    console.log('📍 To:', destination);
    console.log('🔗 TX:', tx.hash);
    console.log('📦 Block:', receipt.blockNumber);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Log transaction
    const txRecord = {
      id: txIdCounter++,
      type: 'Withdrawal',
      amountETH: ethAmount,
      amountUSD: ethAmount * ETH_PRICE,
      destination,
      status: 'Confirmed',
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: gasUsedETH,
      timestamp: new Date().toISOString()
    };
    transactions.push(txRecord);

    res.json({
      success: true,
      txHash: tx.hash,
      amount: ethAmount,
      amountUSD: ethAmount * ETH_PRICE,
      ethPrice: ETH_PRICE,
      to: destination,
      gasUsed: gasUsedETH,
      blockNumber: receipt.blockNumber,
      confirmed: true
    });
  } catch (e) {
    console.log('❌ ERROR:', e.message);
    
    // Log failed transaction
    transactions.push({
      id: txIdCounter++,
      type: 'Withdrawal',
      status: 'Failed',
      error: e.message,
      timestamp: new Date().toISOString()
    });

    res.status(500).json({ error: e.message, code: e.code });
  }
}

// Main conversion endpoint
app.post('/convert', handleConvert);

// Alias endpoints - all use handleConvert
app.post('/withdraw', (req, res) => {
  req.body.to = req.body.to || req.body.toAddress;
  handleConvert(req, res);
});

app.post('/send-eth', (req, res) => {
  const { to, amount, treasury } = req.body;
  req.body.to = to || treasury;
  req.body.amountETH = amount;
  handleConvert(req, res);
});

app.post('/coinbase-withdraw', handleConvert);
app.post('/send-to-coinbase', handleConvert);
app.post('/backend-to-coinbase', handleConvert);
app.post('/treasury-to-coinbase', handleConvert);
app.post('/fund-from-earnings', handleConvert);
app.post('/transfer', handleConvert);

// ═══════════════════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 CON2 PRODUCTION BACKEND - REAL ETH TRANSACTIONS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`👛 Wallet: ${BACKEND_WALLET}`);
  console.log(`💰 ETH Price: $${ETH_PRICE}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('GET ENDPOINTS:');
  console.log('  /              - Server status');
  console.log('  /status        - Detailed status + balance');
  console.log('  /health        - Health check');
  console.log('  /balance       - Wallet balance');
  console.log('  /wallet/balance - Wallet balance (alt)');
  console.log('  /eth-price     - Live ETH price');
  console.log('  /transactions  - Transaction history');
  console.log('  /transactions/:id - Single transaction');
  console.log('');
  console.log('POST ENDPOINTS (REAL ETH TX):');
  console.log('  /convert       - Convert/withdraw ETH');
  console.log('  /withdraw      - Withdraw ETH');
  console.log('  /send-eth      - Send ETH to address');
  console.log('  /coinbase-withdraw - To Coinbase');
  console.log('  /fund-from-earnings - Recycle earnings');
  console.log('═══════════════════════════════════════════════════════════════');
});
