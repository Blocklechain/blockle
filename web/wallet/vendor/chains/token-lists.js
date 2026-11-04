// chains/token-lists.js — KEYLESS token discovery data: a well-known ERC-20 list
// per EVM network (probed with batched eth_call balanceOf when no indexer key is
// configured), the DexScreener / CoinGecko id maps the price feed uses, and the
// native-coin metadata for every supported network.
//
// Addresses only need to be RIGHT, not complete: a token missing here is still
// found through an indexer (Alchemy / Blockscout) when one is configured, and a
// wrong address simply reads as a zero balance (never imported — autoimport only
// persists a real positive balance). Decimals/symbol/name of anything with a
// positive balance are re-read ON-CHAIN by the adapter, so this list is a hint.
//
// Global `TokenLists`; module.exports for tests.
(function (global) {
  'use strict';

  // native coin per network id (registry ids). `cg` = CoinGecko id for pricing.
  const NATIVE = {
    block:     { symbol: 'BLOCK', decimals: 8,  name: 'Blockle' },
    bitcoin:   { symbol: 'BTC',   decimals: 8,  name: 'Bitcoin',   cg: 'bitcoin' },
    litecoin:  { symbol: 'LTC',   decimals: 8,  name: 'Litecoin',  cg: 'litecoin' },
    dogecoin:  { symbol: 'DOGE',  decimals: 8,  name: 'Dogecoin',  cg: 'dogecoin' },
    solana:    { symbol: 'SOL',   decimals: 9,  name: 'Solana',    cg: 'solana' },
    ethereum:  { symbol: 'ETH',   decimals: 18, name: 'Ethereum',  cg: 'ethereum' },
    base:      { symbol: 'ETH',   decimals: 18, name: 'Base',      cg: 'ethereum' },
    arbitrum:  { symbol: 'ETH',   decimals: 18, name: 'Arbitrum',  cg: 'ethereum' },
    optimism:  { symbol: 'ETH',   decimals: 18, name: 'Optimism',  cg: 'ethereum' },
    unichain:  { symbol: 'ETH',   decimals: 18, name: 'Unichain',  cg: 'ethereum' },
    linea:     { symbol: 'ETH',   decimals: 18, name: 'Linea',     cg: 'ethereum' },
    scroll:    { symbol: 'ETH',   decimals: 18, name: 'Scroll',    cg: 'ethereum' },
    polygon:   { symbol: 'POL',   decimals: 18, name: 'Polygon',   cg: 'polygon-ecosystem-token' },
    bnb:       { symbol: 'BNB',   decimals: 18, name: 'BNB Chain', cg: 'binancecoin' },
    opbnb:     { symbol: 'BNB',   decimals: 18, name: 'opBNB',     cg: 'binancecoin' },
    avalanche: { symbol: 'AVAX',  decimals: 18, name: 'Avalanche', cg: 'avalanche-2' },
    gnosis:    { symbol: 'XDAI',  decimals: 18, name: 'Gnosis',    cg: 'xdai' },
    mantle:    { symbol: 'MNT',   decimals: 18, name: 'Mantle',    cg: 'mantle' },
    celo:      { symbol: 'CELO',  decimals: 18, name: 'Celo',      cg: 'celo' },
    cronos:    { symbol: 'CRO',   decimals: 18, name: 'Cronos',    cg: 'crypto-com-chain' },
    sonic:     { symbol: 'S',     decimals: 18, name: 'Sonic',     cg: 'sonic-3' },
    berachain: { symbol: 'BERA',  decimals: 18, name: 'Berachain', cg: 'berachain-bera' },
    sei:       { symbol: 'SEI',   decimals: 18, name: 'Sei',       cg: 'sei-network' },
  };

  // CoinGecko ids by SYMBOL for the majors + liquid blue chips (price feed).
  const COINGECKO_IDS = {
    BTC: 'bitcoin', WBTC: 'wrapped-bitcoin', CBBTC: 'coinbase-wrapped-btc', BTCB: 'bitcoin',
    ETH: 'ethereum', WETH: 'weth', STETH: 'staked-ether', WSTETH: 'wrapped-steth', RETH: 'rocket-pool-eth', CBETH: 'coinbase-wrapped-staked-eth', METH: 'mantle-staked-ether',
    SOL: 'solana', WSOL: 'solana', JUP: 'jupiter-exchange-solana', BONK: 'bonk', WIF: 'dogwifcoin', RAY: 'raydium', JTO: 'jito-governance-token', PYTH: 'pyth-network',
    BNB: 'binancecoin', WBNB: 'binancecoin', CAKE: 'pancakeswap-token', FLOKI: 'floki', TWT: 'trust-wallet-token',
    DOGE: 'dogecoin', LTC: 'litecoin', XRP: 'ripple', ADA: 'cardano', TRX: 'tron',
    POL: 'polygon-ecosystem-token', MATIC: 'matic-network', WMATIC: 'matic-network', AVAX: 'avalanche-2', WAVAX: 'avalanche-2', SAVAX: 'benqi-liquid-staked-avax',
    XDAI: 'xdai', WXDAI: 'xdai', GNO: 'gnosis', MNT: 'mantle', WMNT: 'mantle', CELO: 'celo', CRO: 'crypto-com-chain', WCRO: 'crypto-com-chain',
    S: 'sonic-3', WS: 'sonic-3', BERA: 'berachain-bera', WBERA: 'berachain-bera', HONEY: 'honey-3', SEI: 'sei-network', WSEI: 'sei-network',
    LINK: 'chainlink', UNI: 'uniswap', AAVE: 'aave', MKR: 'maker', LDO: 'lido-dao', CRV: 'curve-dao-token', COMP: 'compound-governance-token', SNX: 'havven', GRT: 'the-graph',
    ENS: 'ethereum-name-service', FET: 'fetch-ai', ONDO: 'ondo-finance', WLD: 'worldcoin-wld', RENDER: 'render-token', PENDLE: 'pendle', GMX: 'gmx', MAGIC: 'magic',
    ARB: 'arbitrum', OP: 'optimism', SCR: 'scroll', AERO: 'aerodrome-finance', VELO: 'velodrome-finance', DEGEN: 'degen-base', BRETT: 'based-brett', VIRTUAL: 'virtual-protocol', TOSHI: 'toshi',
    PEPE: 'pepe', SHIB: 'shiba-inu', SAND: 'the-sandbox', JOE: 'joe', VVS: 'vvs-finance', EURC: 'euro-coin', CUSD: 'celo-dollar', CEUR: 'celo-euro',
  };

  // DexScreener chain ids by registry network id (token price/metadata by address).
  const DEXSCREENER_CHAIN = {
    ethereum: 'ethereum', base: 'base', arbitrum: 'arbitrum', optimism: 'optimism', polygon: 'polygon',
    bnb: 'bsc', bsc: 'bsc', avalanche: 'avalanche', linea: 'linea', scroll: 'scroll', gnosis: 'gnosischain',
    mantle: 'mantle', celo: 'celo', cronos: 'cronos', sonic: 'sonic', berachain: 'berachain', unichain: 'unichain',
    opbnb: 'opbnb', sei: 'seiv2', solana: 'solana',
  };

  // Well-known ERC-20s per network — the keyless balanceOf probe set.
  const ERC20 = {
    ethereum: [
      ['WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18], ['WBTC', '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 8],
      ['DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18], ['LINK', '0x514910771AF9Ca656af840dff83E8264EcF986CA', 18],
      ['UNI', '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 18], ['AAVE', '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 18],
      ['PEPE', '0x6982508145454Ce325dDbE47a25d4ec3d2311933', 18], ['SHIB', '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', 18],
      ['MKR', '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2', 18], ['LDO', '0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32', 18],
      ['CRV', '0xD533a949740bb3306d119CC777fa900bA034cd52', 18], ['STETH', '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 18],
      ['WSTETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 18], ['RETH', '0xae78736Cd615f374D3085123A210448E74Fc6393', 18],
      ['ENS', '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72', 18], ['COMP', '0xc00e94Cb662C3520282E6f5717214004A7f26888', 18],
      ['SNX', '0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F', 18], ['GRT', '0xc944E90C64B2c07662A292be6244BDf05Cda44a7', 18],
      ['FET', '0xaea46A60368A7bD060eec7DF8CBa43b7EF41Ad85', 18], ['ONDO', '0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3', 18],
      ['WLD', '0x163f8C2467924be0ae7B5347228CABF260318753', 18], ['USDE', '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 18],
      ['PYUSD', '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 6], ['FDUSD', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 18],
      ['TUSD', '0x0000000000085d4780B73119b644AE5ecd22b376', 18], ['CBBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8],
      ['RENDER', '0x6De037ef9aD2725EB40118Bb1702EBb27e4Aeb24', 18], ['MATIC', '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', 18],
      ['POL', '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6', 18], ['ARB', '0xB50721BCf8d664c30412Cfbc6cf7a15145234ad1', 18],
    ],
    base: [
      ['WETH', '0x4200000000000000000000000000000000000006', 18], ['USDBC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 6],
      ['USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6], ['DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 18],
      ['CBETH', '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', 18], ['CBBTC', '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8],
      ['AERO', '0x940181a94A35A4569E4529A3CDfB74e38FD98631', 18], ['DEGEN', '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', 18],
      ['BRETT', '0x532f27101965dd16442E59d40670FaF5eBB142E4', 18], ['VIRTUAL', '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', 18],
      ['TOSHI', '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', 18], ['WSTETH', '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', 18],
      ['EURC', '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42', 6],
    ],
    arbitrum: [
      ['WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18], ['ARB', '0x912CE59144191C1204E64559FE8253a0e49E6548', 18],
      ['USDC.E', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6], ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18],
      ['WBTC', '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', 8], ['GMX', '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a', 18],
      ['LINK', '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4', 18], ['UNI', '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0', 18],
      ['PENDLE', '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', 18], ['MAGIC', '0x539bdE0d7Dbd336b79148AA742883198BBF60342', 18],
      ['WSTETH', '0x5979D7b546E38E414F7E9822514be443A4800529', 18],
    ],
    optimism: [
      ['WETH', '0x4200000000000000000000000000000000000006', 18], ['OP', '0x4200000000000000000000000000000000000042', 18],
      ['DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18], ['WBTC', '0x68f180fcCe6836688e9084f035309E29Bf0A2095', 8],
      ['USDC.E', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6], ['LINK', '0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6', 18],
      ['SNX', '0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4', 18], ['WSTETH', '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', 18],
      ['VELO', '0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db', 18],
    ],
    polygon: [
      ['WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18], ['WBTC', '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', 8],
      ['DAI', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 18], ['USDC.E', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6],
      ['WMATIC', '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', 18], ['LINK', '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39', 18],
      ['AAVE', '0xD6DF932A45C0f255f85145f286eA0b292B21C90B', 18], ['UNI', '0xb33EaAd8d922B1083446DC23f610c2567fB5180f', 18],
      ['SAND', '0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683', 18], ['CRV', '0x172370d5Cd63279eFa6d502DAB29171933a610AF', 18],
    ],
    bnb: [
      ['WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', 18], ['BUSD', '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', 18],
      ['ETH', '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', 18], ['BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', 18],
      ['CAKE', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', 18], ['DAI', '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', 18],
      ['XRP', '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', 18], ['DOGE', '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', 8],
      ['ADA', '0x3EE2200Efb3400fAbB9AaCf31297cBdD1d435D47', 18], ['LINK', '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', 18],
      ['FDUSD', '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', 18], ['FLOKI', '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E', 9],
      ['TWT', '0x4B0F1812e5Df2A09796481Ff14017e6005508003', 18],
    ],
    avalanche: [
      ['WAVAX', '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', 18], ['USDC.E', '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', 6],
      ['USDT.E', '0xc7198437980c041c805A1EDcbA50c1Ce5db95118', 6], ['WETH.E', '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', 18],
      ['WBTC.E', '0x50b7545627a5162F82A992c33b87aDc75187B218', 8], ['DAI.E', '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', 18],
      ['JOE', '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd', 18], ['LINK.E', '0x5947BB275c521040051D82396192181b413227A3', 18],
      ['SAVAX', '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', 18], ['BTC.B', '0x152b9d0FdC40C096757F570A51E494bd4b943E50', 8],
    ],
    linea: [
      ['WETH', '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', 18], ['USDC', '0x176211869cA2b568f2A7D4EE941E073a821EE1ff', 6],
      ['USDT', '0xA219439258ca9da29E9Cc4cE5596924745e12B93', 6], ['WBTC', '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4', 8],
      ['DAI', '0x4AF15ec2A0BD43Db75dd04E62FAA3B8EF36b00d5', 18],
    ],
    scroll: [
      ['WETH', '0x5300000000000000000000000000000000000004', 18], ['USDC', '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', 6],
      ['USDT', '0xf55BEC9cafDbE8730f096Aa55dad6D22d44099Df', 6], ['WBTC', '0x3C1BCa5a656e69edCD0D4E36BEbb3FcDAcA60Cf1', 8],
      ['DAI', '0xcA77eB3fEFe3725Dc33bccB54eDEFc3D9f764f97', 18], ['SCR', '0xd29687c813D741E2F938F4aC377128810E217b1b', 18],
    ],
    gnosis: [
      ['WXDAI', '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 18], ['USDC', '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', 6],
      ['USDT', '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', 6], ['WETH', '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', 18],
      ['GNO', '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb', 18], ['USDC.E', '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0', 6],
      ['WBTC', '0x8e5bBbb09Ed1ebdE8674Cda39A0c169401db4252', 8],
    ],
    mantle: [
      ['WMNT', '0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8', 18], ['USDC', '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', 6],
      ['USDT', '0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE', 6], ['WETH', '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111', 18],
      ['METH', '0xcDA86A272531e8640cD7F1a92c01839911B90bb0', 18],
    ],
    celo: [
      ['CELO', '0x471EcE3750Da237f93B8E339c536989b8978a438', 18], ['CUSD', '0x765DE816845861e75A25fCA122bb6898B8B1282a', 18],
      ['CEUR', '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73', 18], ['USDC', '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', 6],
      ['USDT', '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', 6],
    ],
    cronos: [
      ['WCRO', '0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23', 18], ['USDC', '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59', 6],
      ['USDT', '0x66e428c3f67a68878562e79A0234c1F83c208770', 6], ['WETH', '0xe44Fd7fCb2b1581822D0c862B68222998a0c299a', 18],
      ['WBTC', '0x062E66477Faf219F25De04EC9d9CE64a40ab9bd9', 8], ['VVS', '0x2D03bECE6747ADC00E1a131BBA1469C15fD11e03', 18],
    ],
    sonic: [
      ['WS', '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38', 18], ['USDC', '0x29219dd400f2Bf60E5a23d13Be72B486D4038894', 6],
    ],
    berachain: [
      ['WBERA', '0x6969696969696969696969696969696969696969', 18], ['HONEY', '0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce', 18],
      ['WETH', '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590', 18],
    ],
    unichain: [
      ['WETH', '0x4200000000000000000000000000000000000006', 18], ['USDC', '0x078D782b760474a361dDA0AF3839290b0EF57AD6', 6],
      ['UNI', '0x8f187aA05619a017077f5308904739877ce9eA21', 18],
    ],
    opbnb: [
      ['WBNB', '0x4200000000000000000000000000000000000006', 18], ['USDT', '0x9e5AAC1Ba1a2e6aEd6b32689DFcF62A509Ca96f3', 18],
      ['ETH', '0xE7798f023fC62146e8Aa1b36Da45fb70855a77Ea', 18],
    ],
    sei: [
      ['WSEI', '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7', 18], ['USDC', '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1', 6],
      ['USDT', '0xB75D0B03c06A926e488e2659DF1A861F860bD3d1', 6], ['WETH', '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8', 18],
    ],
  };

  // The well-known list for a network as AssetRefs (never includes the default
  // USDC/USDT rows the registry already shows — those are probed separately).
  function forChain(id) {
    const rows = ERC20[id] || [];
    return rows.map((r) => ({ chain: id, kind: 'erc20', symbol: r[0], address: r[1], decimals: r[2] }));
  }
  function nativeOf(id) { return NATIVE[id] || null; }
  function coingeckoId(symbol) { return COINGECKO_IDS[String(symbol || '').toUpperCase()] || null; }
  function dexscreenerChain(id) { return DEXSCREENER_CHAIN[String(id || '').toLowerCase()] || null; }
  function chains() { return Object.keys(ERC20); }

  const API = { ERC20, NATIVE, COINGECKO_IDS, DEXSCREENER_CHAIN, forChain, nativeOf, coingeckoId, dexscreenerChain, chains };
  global.TokenLists = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
