// abi.js — canonical addresses, constants, selectors, events, and ABI for SLOW.
//
// Selectors and event topics below are computed from the signatures and were
// cross-checked against the deployed dapp's selector map (see codec.js).

// ---------------------------------------------------------------------------
// Deployment (Ethereum mainnet)
// ---------------------------------------------------------------------------

/** SLOW protocol contract. Same address on any chain it is deployed to (vanity CREATE2). */
export const SLOW_ADDRESS = '0x000000000000888741B254d37e1b27128AfEAaBC';

export const MAINNET_CHAIN_ID = 1;

/** Contract-level protocol constants (see SLOW.sol). */
export const GUARDIAN_CHANGE_DELAY = 86400;   // 1 day  — guardian-rotation veto window
export const CLAWBACK_GRACE = 2592000;         // 30 days — wait after expiry before clawback
export const ETH = '0x0000000000000000000000000000000000000000'; // token address for wrapped ETH

/** Handy delay presets (seconds) for building ids. */
export const DELAYS = {
  none: 0,
  '1h': 3600,
  '1d': 86400,
  '3d': 259200,
  '7d': 604800,
  '30d': 2592000,
};

/**
 * Curated mainnet ERC-20s people commonly wrap, with decimals. Any ERC-20
 * address works with the SDK directly — this map is only sugar for symbols.
 *
 * ⚠️ Rebasing / fee-on-transfer tokens break SLOW's 1:1 accounting. stETH is
 *    intentionally excluded; wrap to wstETH first. (See root README.)
 */
export const TOKENS = {
  ETH:    { address: ETH, symbol: 'ETH', decimals: 18 },
  // stablecoins
  USDC:   { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  USDT:   { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
  DAI:    { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
  USDe:   { address: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', symbol: 'USDe', decimals: 18 },
  crvUSD: { address: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', symbol: 'crvUSD', decimals: 18 },
  FRAX:   { address: '0x853d955aCEf822Db058eb8505911ED77F175b99e', symbol: 'FRAX', decimals: 18 },
  LUSD:   { address: '0x5f98805A4E8be255a32880FDeC7F6728C6568bA0', symbol: 'LUSD', decimals: 18 },
  sDAI:   { address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA', symbol: 'sDAI', decimals: 18 },
  // ETH & BTC derivatives (non-rebasing)
  WETH:   { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
  wstETH: { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18 },
  rETH:   { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18 },
  cbETH:  { address: '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', symbol: 'cbETH', decimals: 18 },
  WBTC:   { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8 },
  tBTC:   { address: '0x18084fbA666a33d37592fA2633fD49a74DD93a88', symbol: 'tBTC', decimals: 18 },
  // majors
  LINK:   { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', symbol: 'LINK', decimals: 18 },
  UNI:    { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', symbol: 'UNI', decimals: 18 },
  AAVE:   { address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', symbol: 'AAVE', decimals: 18 },
  MKR:    { address: '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', symbol: 'MKR', decimals: 18 },
  LDO:    { address: '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', symbol: 'LDO', decimals: 18 },
  CRV:    { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', symbol: 'CRV', decimals: 18 },
  COMP:   { address: '0xc00e94Cb662C3520282E6f5717214004A7f26888', symbol: 'COMP', decimals: 18 },
  ENS:    { address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', symbol: 'ENS', decimals: 18 },
  '1INCH':{ address: '0x111111111117dC0aa78b770fA6A738034120C302', symbol: '1INCH', decimals: 18 },
  PEPE:   { address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE', decimals: 18 },
  SHIB:   { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', symbol: 'SHIB', decimals: 18 },
};

// ---------------------------------------------------------------------------
// Name services (mirrors the on-chain dapp's resolution)
// ---------------------------------------------------------------------------

/** ENS registry (mainnet). */
export const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
/** WNS registry — resolves `.wei` names (single-registry resolver). */
export const WNS_REGISTRY = '0x0000000000696760E15f265e828DB644A0c242EB';

/** Selectors for name resolution (see names.js). */
export const NAME_SEL = {
  resolver:   '0x0178b8bf', // ENS registry resolver(bytes32)
  addr:       '0x3b3b57de', // resolver addr(bytes32) — also used by WNS
  name:       '0x691f3431', // reverse resolver name(bytes32)
  wnsReverse: '0x9af8b7aa', // WNS reverse lookup by address (selector per deployed dapp)
};

// ---------------------------------------------------------------------------
// Function selectors (4-byte). Used by the zero-dep client.
// ---------------------------------------------------------------------------

export const SEL = {
  // writes — SLOW
  depositTo:            '0x94eeaec9', // depositTo(address,address,uint256,uint96,bytes)
  depositToWithTip:     '0x75f92e42', // depositToWithTip(address,address,uint256,uint96,uint256,bytes)
  withdrawFrom:         '0xd4fdc309', // withdrawFrom(address,address,uint256,uint256)
  safeTransferFrom:     '0xf242432a', // safeTransferFrom(address,address,uint256,uint256,bytes)
  setApprovalForAll:    '0xa22cb465', // setApprovalForAll(address,bool)
  unlock:               '0x6198e339', // unlock(uint256)
  claim:                '0x379607f5', // claim(uint256)  (also SLOWGate.claim)
  reverse:              '0x97d15425', // reverse(uint256)
  clawback:             '0xfcc36bc9', // clawback(uint256)
  setGuardian:          '0x8a0dac4a', // setGuardian(address)
  commitGuardian:       '0xa952a15f', // commitGuardian(address)
  cancelGuardianChange: '0xdb6c927d', // cancelGuardianChange(address)
  approveTransfer:      '0xfa02c4b7', // approveTransfer(address,uint256)
  revokeApproval:       '0x47d07c4c', // revokeApproval(address,uint256)
  // writes — SLOWGate
  claimMany:            '0x925489a8', // claimMany(uint256[])
  refundTip:            '0xd27e1e72', // refundTip(uint256)
  // reads — SLOW
  balanceOf:                  '0x00fdd58e', // balanceOf(address,uint256)
  unlockedBalances:           '0x5b96484e', // unlockedBalances(address,uint256)
  isApprovedForAll:           '0xe985e9c5', // isApprovedForAll(address,address)
  guardians:                  '0x0633b14a', // guardians(address)
  pendingGuardians:           '0x2d1836f8', // pendingGuardians(address)
  nonces:                     '0x7ecebe00', // nonces(address)
  lastGuardianChange:         '0xc2a03613', // lastGuardianChange(address)
  pendingTransfers:           '0x6577b86a', // pendingTransfers(uint256)
  canReverseTransfer:         '0x0c980180', // canReverseTransfer(uint256)
  isGuardianApprovalNeeded:   '0xaade934f', // isGuardianApprovalNeeded(address,address,uint256,uint256)
  isWithdrawalApprovalNeeded: '0xabe616b8', // isWithdrawalApprovalNeeded(address,address,uint256,uint256)
  getInboundTransfers:        '0xe3993ee7', // getInboundTransfers(address)
  getOutboundTransfers:       '0xd40d4bc6', // getOutboundTransfers(address)
  inboundTransferCount:       '0xea712c4f', // inboundTransferCount(address)
  inboundTransferAt:          '0x8b40f4c5', // inboundTransferAt(address,uint256)
  outboundTransferCount:      '0x73bfdce5', // outboundTransferCount(address)
  outboundTransferAt:         '0xb5f8348b', // outboundTransferAt(address,uint256)
  encodeId:                   '0xfe18969a', // encodeId(address,uint96)
  decodeId:                   '0xdc20c6fa', // decodeId(uint256)
  uri:                        '0x0e89341c', // uri(uint256)
  html:                       '0x33c34ac3', // html()
  gate:                       '0x7a0ebc88', // gate()
  // reads — SLOWGate
  tips:                       '0xa5c68c59', // tips(uint256)
  // ERC-20 (for approving the wrapper to pull tokens on deposit)
  erc20approve:               '0x095ea7b3', // approve(address,uint256)
  erc20allowance:             '0xdd62ed3e', // allowance(address,address)
  erc20decimals:              '0x313ce567', // decimals()
  erc20symbol:                '0x95d89b41', // symbol()
};

// ---------------------------------------------------------------------------
// Event topic0 hashes (keccak of the signature). Used for log filtering.
// ---------------------------------------------------------------------------

export const EVENTS = {
  TransferPending:         '0xbe4e2e471955a7d7266810e536f577d91dd02b7afc866c7f584a7f816f173e4c',
  TransferClaimed:         '0xd710ef74a138fa0fee4846267ad2a86bd94b7fc0aafb0846408b8c34ebe96c57',
  TransferReversed:        '0xe65556f2455e8dfc2eb0746bce41c0fe3f9623da551c321f6c65b4561dcdca59',
  TransferClawedBack:      '0xc84cb948c386c9460be032f29fa63654fe7182610a5e95b8274c7b8fc48d1284',
  Unlocked:                '0x3f2f29fa02cc34566ac167b446be0be9e0254cac18eda93b2dfe6a7a7c8affb9',
  TransferApproved:        '0xeccbdf7c486b88cbffbd8100b22951057ab0de2b73f27f625cc468ccabc3d08a',
  TransferApprovalRevoked: '0xa93d8faaf77be926dbf32f49a43827236d7409659fab6420204e7128dea2bf2f',
  GuardianSet:             '0xc3ce29e3ab42e524b6f6f1b4d3674898d503ee3577a64ac87b555904ebc14138',
  GuardianChangeProposed:  '0x22ce31d4c85264ebfda0e789ba9ba94e6df4d6f9fd53c0a7e7f1eab9fc74d2ce',
  GuardianChangeCanceled:  '0xf1c57bea7cb5c15982374d06f07fbd1f0c723b8d26c33ba84da4b150d3a137ac',
  TransferSingle:          '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  ApprovalForAll:          '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  TipPosted:               '0xf5d6ce0c19323a14dfcae19c1a1447d8e5bac8f8e7c2b48bbf3b43f3c88b173c',
  TipRefunded:             '0x2890acc3461fcd77430e69b65e40988367cd1e27fe7db3c7d62df4ace9e9d36f',
  TipPaid:                 '0xebc91dbc6ccaee1496ea6a40c01450493eae1c3a22fba07a8885c9a28b5451ad',
};

// ---------------------------------------------------------------------------
// Human-readable ABI (viem `parseAbi` / wagmi compatible).
// The viem adapter (viem.js) parses this into a typed ABI object.
// ---------------------------------------------------------------------------

export const SLOW_ABI = [
  // --- metadata / ERC-1155 ---
  'function name() pure returns (string)',
  'function symbol() pure returns (string)',
  'function uri(uint256 id) view returns (string)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
  // --- id codec ---
  'function encodeId(address token, uint96 delay) pure returns (uint256 id)',
  'function decodeId(uint256 id) pure returns (address token, uint256 delay)',
  // --- balances ---
  'function unlockedBalances(address owner, uint256 id) view returns (uint256)',
  // --- deposit ---
  'function depositTo(address token, address to, uint256 amount, uint96 delay, bytes data) payable returns (uint256 transferId)',
  'function depositToWithTip(address token, address to, uint256 amount, uint96 delay, uint256 tip, bytes data) payable returns (uint256 transferId)',
  // --- withdraw ---
  'function withdrawFrom(address from, address to, uint256 id, uint256 amount)',
  // --- settle / recover ---
  'function unlock(uint256 transferId)',
  'function claim(uint256 transferId)',
  'function reverse(uint256 transferId)',
  'function clawback(uint256 transferId)',
  'function canReverseTransfer(uint256 transferId) view returns (bool canReverse, bytes4 reason)',
  // --- pending-transfer enumeration ---
  'function pendingTransfers(uint256 transferId) view returns (uint96 timestamp, address from, address to, uint256 id, uint256 amount)',
  'function getInboundTransfers(address user) view returns (uint256[])',
  'function getOutboundTransfers(address user) view returns (uint256[])',
  'function inboundTransferCount(address user) view returns (uint256)',
  'function inboundTransferAt(address user, uint256 index) view returns (uint256)',
  'function outboundTransferCount(address user) view returns (uint256)',
  'function outboundTransferAt(address user, uint256 index) view returns (uint256)',
  // --- guardian ---
  'function guardians(address user) view returns (address)',
  'function pendingGuardians(address user) view returns (address guardian, uint96 effectiveAt)',
  'function setGuardian(address newGuardian)',
  'function commitGuardian(address user)',
  'function cancelGuardianChange(address user)',
  'function approveTransfer(address from, uint256 transferId)',
  'function revokeApproval(address from, uint256 transferId)',
  'function isGuardianApprovalNeeded(address user, address to, uint256 id, uint256 amount) view returns (bool)',
  'function isWithdrawalApprovalNeeded(address user, address to, uint256 id, uint256 amount) view returns (bool)',
  'function nonces(address user) view returns (uint256)',
  'function lastGuardianChange(address user) view returns (uint256)',
  // --- gate / dapp ---
  'function gate() view returns (address)',
  'function html() view returns (string)',
  // --- events ---
  'event TransferPending(uint256 indexed transferId, uint256 indexed delay)',
  'event TransferClaimed(uint256 indexed transferId)',
  'event TransferReversed(uint256 indexed transferId)',
  'event TransferClawedBack(uint256 indexed transferId)',
  'event Unlocked(address indexed user, uint256 indexed id, uint256 indexed amount)',
  'event TransferApproved(address indexed from, address indexed to, uint256 id, uint256 amount)',
  'event TransferApprovalRevoked(address indexed from, address indexed to, uint256 id, uint256 amount)',
  'event GuardianSet(address indexed user, address indexed guardian)',
  'event GuardianChangeProposed(address indexed user, address indexed newGuardian, uint256 effectiveAt)',
  'event GuardianChangeCanceled(address indexed user)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 amount)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
];

/** SLOWGate ABI (the keeper-settlement + tip operator). */
export const GATE_ABI = [
  'function slow() view returns (address)',
  'function tips(uint256 transferId) view returns (uint96 amount, address sender)',
  'function claim(uint256 transferId)',
  'function claimMany(uint256[] transferIds)',
  'function refundTip(uint256 transferId)',
  'event TipPosted(uint256 indexed transferId, uint96 amount, address indexed sender, address indexed to)',
  'event TipRefunded(uint256 indexed transferId, uint96 amount, address indexed to)',
  'event TipPaid(uint256 indexed transferId, uint96 amount, address indexed to)',
];

/** Minimal ERC-20 ABI (approve the wrapper before an ERC-20 deposit). */
export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address owner) view returns (uint256)',
];

/** Custom-error selectors (bytes4). `canReverseTransfer` returns one of these as `reason`. */
export const ERRORS = {
  '0x49378211': 'TransferDoesNotExist',
  '0x7a6fcaa6': 'TimelockExpired',
  '0x2d193ecf': 'GuardianApprovalRequired',
  '0x9c8d2cd2': 'InvalidRecipient',
  '0xb2e532de': 'InvalidDeposit',
  '0x2c5211c6': 'InvalidAmount',
  '0x82b42900': 'Unauthorized',
  '0xc9252135': 'ClawbackNotReady',
};

/** Map a revert/reason selector (`0x…` 4-byte, or full revert data) to its error name. */
export function errorName(data) {
  if (!data || data === '0x') return 'ok';
  return ERRORS[data.slice(0, 10).toLowerCase()] || data.slice(0, 10);
}
