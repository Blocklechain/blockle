// exchange_client.dart — the in-app client for exchange.blockle.org.
//
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// The exchange is CUSTODIAL and it is a separate pot of money from the wallet.
// The wallet on this device holds keys; the exchange holds a balance for your
// Blockle account. Nothing here moves coins between the two by itself: to
// trade, you send coins from the wallet to the deposit address this client
// asks for, exactly as you would to any other venue. That separation is the
// product decision, not an implementation gap — a wallet that silently swept
// self-custodied coins into a custodial venue would be the single worst thing
// this app could do.
//
// This file replaces a NEUTERED stub. The in-app exchange was removed on
// 2026-11-06 ("strip the features that don't pull their weight") when it was
// thin, and the stub kept the type surface alive so bots and portfolio would
// still compile while every read returned empty. That removal left a known
// hole, recorded in its own commit message: "the exchange relay was also the
// live price oracle for the portfolio + bot marks — a replacement price source
// is still to be wired". Restoring this client closes that too.
//
// AUTHENTICATION. Public reads — markets, tickers, the order book, the trade
// tape — need no account. Everything about YOUR money (balances, orders,
// deposit addresses) is authenticated with the Blockle accounts session as a
// Bearer token, because a SameSite=Lax cookie does not ride a cross-site fetch
// from a phone. The venue has no accounts of its own.
//
// HONESTY ABOUT THE GATE. The venue publishes /status with `live`,
// `mainnetEnabled` and `legalReviewCompleted`. This client surfaces that
// verbatim rather than interpreting it, so the UI can say what is actually
// true instead of implying live trading.
import 'dart:convert';
import 'dart:math';

import 'transports.dart';

/// Default ORIGIN — no path. Overridable for tests and for a staging venue.
///
/// THE VENUE HAS TWO SURFACES AND THEY ARE NOT INTERCHANGEABLE:
///
///   /public/*  read-only market data, no credential ever sent
///   /v1/*      the account: balances, orders, deposits, withdrawals
///
/// This used to be a single base of `…/org/v1` with paths like `/status` hung
/// off it, which 404'd every public read. The visible symptom was the Exchange
/// tab reporting "unavailable" on iOS: `status()` threw, the controller stored
/// a null status, and `tradable` correctly refused to assume a venue it could
/// not reach was open. The gate was fine; the URL was wrong.
///
/// So the surface is now part of each call site rather than baked into the
/// base, because "which half of the API is this?" is not something a reader
/// should have to infer.
const String kExchangeBase = 'https://exchange.blockle.org';

/// Normalise whatever a caller passed into a bare origin.
///
/// Strips a trailing slash, and strips a trailing `/v1` or `/public` so that a
/// caller still holding the OLD convention — where the base included the
/// surface — lands on the right URLs instead of requesting
/// `…/v1/public/status`. That is the exact shape of the bug this replaced, so
/// it is worth absorbing rather than leaving as a trap.
String _origin(String base) {
  var b = base.trim();
  while (b.endsWith('/')) {
    b = b.substring(0, b.length - 1);
  }
  for (final suffix in const ['/v1', '/public']) {
    if (b.endsWith(suffix)) {
      b = b.substring(0, b.length - suffix.length);
      break;
    }
  }
  return b;
}

/// Read-only market data. Never carries a credential.
const String _kPublic = '/public';

/// The account surface. Everything here needs a session or an API key.
const String _kV1 = '/v1';

/// A signed challenge (kept: older callers still reference the type).
class SignedChallenge {
  const SignedChallenge({
    required this.address,
    required this.publicKey,
    required this.signature,
    required this.nonce,
  });
  final String address;
  final String publicKey;
  final String signature;
  final String nonce;
}

typedef MessageSigner = Future<({String signature, String publicKey})> Function(
    String message);

class ExchangeMarket {
  const ExchangeMarket({
    required this.id,
    required this.base,
    required this.quote,
    this.baseDecimals = 8,
    this.quoteDecimals = 8,
    this.priceDecimals = 0,
    int? priceScale,
    this.last,
    this.bid,
    this.ask,
    this.change24h,
    this.volume24h,
    this.minBase,
    this.minNotional,
    this.closed,
    this.caveat,
    this.listedAt,
    this.lastText,
    this.bidText,
    this.askText,
  }) : _priceScale = priceScale;
  final String id;
  final String base;
  final String quote;
  final int baseDecimals;

  /// Decimals for a quote-asset AMOUNT (the notional, the capital, a balance).
  /// NOT for a price — see [priceScale].
  final int quoteDecimals;

  /// Extra decimal places a PRICE on this market carries beyond the quote's own.
  ///
  /// Zero for every market that predates the quote expansion, which is why the
  /// distinction went unnoticed: `quoteDecimals` was enough while nothing had a
  /// `priceDecimals`. It no longer is. A price is quote base-units per whole
  /// unit of base times 10^priceDecimals, so a client that formats or validates
  /// a price with `quoteDecimals` alone is wrong by that power of ten —
  /// rendering a PERBUG-BTC price 10,000 times too large and submitting one
  /// 10,000 times too small.
  final int priceDecimals;
  final int? _priceScale;

  /// The number of decimal places a PRICE on this market may carry.
  ///
  /// Published by the venue (`/public/markets.priceScale`) precisely because a
  /// client cannot derive it from anything else it holds; the fallback below is
  /// the server's own definition (`priceScale()` in venue.ts) for the case where
  /// an older venue omits the field.
  int get priceScale => _priceScale ?? (quoteDecimals + priceDecimals);

  /// Last traded price, or NULL when the market has never traded.
  ///
  /// Null is not zero. "No market yet" and "the market is at zero" are
  /// different claims and only one of them is true before the first fill; the
  /// venue is careful about this and so is the UI that reads it.
  final num? last;
  final num? bid;
  final num? ask;
  final num? change24h;
  final num? volume24h;

  /// The smallest order SIZE, in base units, as the venue's decimal string.
  final String? minBase;

  /// The smallest order VALUE, in the quote asset. A SECOND floor, additional
  /// to [minBase]: an order that clears the size minimum and not this one is
  /// still refused (`venue.ts:1096`). Quote-asset AMOUNT, so [quoteDecimals].
  final String? minNotional;

  /// Why this market refuses new orders, or null when it takes them.
  ///
  /// A closed market KEEPS its symbol, its book, its history and its cancels —
  /// it is not delisted and it is not hidden. The venue returns this sentence
  /// and a 409 to any order placed on it, so a client that does not read the
  /// field offers a button that cannot work and then shows the refusal as if it
  /// were a surprise.
  final String? closed;

  /// "Open, with a known gap." NOT the opposite of [closed] and not a weaker
  /// form of it: a caveated market takes orders and settles them, while one leg
  /// of its plumbing is manual or conditional. Every BLOCK market carries one,
  /// because BLOCK deposits depend on our own node and its withdrawals are
  /// released by an operator. Hiding it would present it as the same
  /// proposition as BTC-USDT, which it is not.
  final String? caveat;
  final String? listedAt;

  /// True when the venue will accept an order here. Derived from the venue's
  /// own field rather than from the absence of one.
  bool get open => closed == null;

  /// The venue's own decimal STRINGS for the three prices.
  ///
  /// [last], [bid] and [ask] exist for arithmetic (the price oracle, a spread
  /// percentage). These exist for DISPLAY, because `fmt()` on the server has
  /// already decided how many places this asset shows and a round trip through
  /// a Dart `num` reformats `0.00012300` as `0.000123` — a different-looking
  /// figure from the one the web shows for the same market. Null still means
  /// "never traded", and the UI renders an em dash for it, never a zero.
  final String? lastText;
  final String? bidText;
  final String? askText;

  String get pair => '$base/$quote';

  /// Bid/ask spread as a percentage of the mid, or null when the book is not
  /// two-sided. A one-sided book has no spread, and inventing one from the
  /// single side would be a made-up number.
  double? get spreadPct {
    final b = bid, a = ask;
    if (b == null || a == null || b <= 0 || a <= 0) return null;
    final mid = (a + b) / 2;
    if (mid <= 0) return null;
    return ((a - b) / mid) * 100;
  }
}

class OrderLevel {
  const OrderLevel(this.price, this.size, {this.priceText, this.sizeText});
  final num price;
  final num size;

  /// The venue's decimal strings, for the ladder. See [ExchangeMarket.lastText].
  final String? priceText;
  final String? sizeText;
}

class OrderBook {
  const OrderBook(this.bids, this.asks);
  final List<OrderLevel> bids;
  final List<OrderLevel> asks;

  bool get isEmpty => bids.isEmpty && asks.isEmpty;

  /// Mid price, or null when either side is empty — a one-sided book has no
  /// mid, and inventing one from the single side would be a made-up number.
  ///
  /// NOT FOR DISPLAY AS A PRICE. This is a `double`, and a market with a wide
  /// `priceScale` has no double precision left at its own tick size: DINGO-BTC
  /// quotes around 1e-16 at `priceScale` 16, where this average is a float
  /// artefact that renders to sixteen decimal places and looks like
  /// information. Use `exBookMid()` (services/exchange_amount.dart) for
  /// anything a user reads or acts on; this remains for ratios — a spread
  /// percentage to two places is a summary, not a figure about money.
  num? get mid =>
      (bids.isEmpty || asks.isEmpty) ? null : (bids.first.price + asks.first.price) / 2;
}

class OpenOrder {
  const OpenOrder({
    required this.id,
    required this.market,
    required this.side,
    required this.price,
    required this.size,
    this.filled,
    this.status,
    this.priceText,
    this.sizeText,
    this.filledText,
    this.createdAt,
  });
  final String id;
  final String market;
  final String side;
  final num price;
  final num size;
  final num? filled;
  final String? status;

  /// Decimal strings as the venue sent them, for display.
  final String? priceText;
  final String? sizeText;
  final String? filledText;

  /// When it was placed. `GET /v1/orders` has always returned this; the app's
  /// mapper used to throw it away, which is why there was no order history.
  final String? createdAt;

  /// True while the order can still fill — the only state a cancel button
  /// belongs on. The venue's states are exactly `open` / `filled` /
  /// `cancelled` (venue.ts:205); anything else it may add later is treated as
  /// not-open rather than offered a cancel that would 400.
  bool get open => status == 'open';
}

/// One asset's balance on the venue — three figures, not one.
class ExchangeBalance {
  const ExchangeBalance({
    required this.asset,
    required this.total,
    required this.reserved,
    required this.available,
    required this.decimals,
  });
  final String asset;
  final String total;

  /// Held against open orders. Shown beside the total because "available"
  /// alone cannot explain why a visible balance will not place an order.
  final String reserved;
  final String available;
  final int decimals;
}

/// A deposit address, or the venue's explanation of why there isn't one.
///
/// CARRIES THE MEMO. `GET /v1/deposit-address` answers with `memo` and
/// `memoRequired` (publicapi.ts:777 -> describeDeposit, deposits.ts:275), and
/// this class used to have neither field while reading a `note` key the route
/// has never emitted. On a memo chain — XRP's destination tag, carried through
/// bitgodeposits.ts precisely because "the tag is NOT optional" — that dropped
/// the one value without which the deposit cannot be attributed:
/// `Deposits.ownerOfAddress` matches on address + asset + network and ignores
/// the memo, so a tagless transfer to the pooled address is parked in
/// `__unattributed__` or credited to whoever else shares the row. The plural
/// route's model ([DepositAddressRow]) always had these fields, so the two
/// deposit surfaces in this app disagreed about the same account.
class DepositTarget {
  const DepositTarget({
    this.address,
    this.network,
    this.memo,
    this.memoRequired = false,
    this.reason,
    this.alternatives = const [],
  });
  final String? address;
  final String? network;

  /// The destination tag / memo this chain needs, when it needs one.
  final String? memo;

  /// A memo that EXISTS is never optional — the chains that use them cannot
  /// credit a deposit without it. The server sets this from `memo !== undefined`
  /// rather than leaving the client to infer it.
  final bool memoRequired;

  /// Why no address was issued. A deposit to a wrong address is unrecoverable
  /// by anyone, so the venue returns an explanation rather than a guess, and
  /// this client passes it through rather than showing a blank field.
  final String? reason;

  /// Other chains for the same asset that DO have an address. The server offers
  /// them so a refusal can name a way forward instead of being a dead end.
  final List<String> alternatives;

  bool get ready => address != null && address!.isNotEmpty;
}

/// The venue's own view of whether it is open for business.
class ExchangeStatus {
  const ExchangeStatus({
    required this.live,
    required this.mainnetEnabled,
    required this.legalReviewCompleted,
    required this.network,
    this.ledgerPresent = false,
    this.faucetAvailable = false,
  });
  final bool live;
  final bool mainnetEnabled;
  final bool legalReviewCompleted;
  final String network;
  final bool ledgerPresent;

  /// PERMANENTLY FALSE on the live venue. The testnet faucet was deleted
  /// server-side — not gated — after an authenticated scanner minted 1.39e12
  /// base units of USDT the venue did not hold. The field is read rather than
  /// assumed because a client treating `undefined` as truthy would render a
  /// button for a route that no longer exists.
  final bool faucetAvailable;

  /// True only when the venue says every gate is open. The UI must not infer
  /// readiness from anything else.
  bool get tradable => live && mainnetEnabled && legalReviewCompleted;
}

/// Who the venue thinks you are. `GET /v1/me`.
class ExchangeMe {
  const ExchangeMe({required this.accountId, this.email, this.twoFactor});
  final String accountId;
  final String? email;

  /// NULL MEANS "NOT REPORTED", NOT "OFF". The accounts service may decline to
  /// say; a UI that rendered that as "two-factor: off" would be stating
  /// something it does not know about the security of someone's money.
  final bool? twoFactor;
}

/// Trading fees. `GET /public/fees` — flat and symmetric, no tiers.
class ExchangeFees {
  const ExchangeFees({
    required this.makerPct,
    required this.takerPct,
    required this.makerBps,
    required this.takerBps,
    required this.note,
  });
  final String makerPct;
  final String takerPct;
  final int makerBps;
  final int takerBps;
  final String note;

  /// The spread at which a maker breaks even: they pay the SAME fee as a taker
  /// with no rebate, so a round trip costs the maker fee twice.
  int get breakEvenBps => makerBps * 2;
}

/// One published withdrawal fee. `GET /public/withdrawal-fees`.
class WithdrawalFee {
  const WithdrawalFee({
    required this.asset,
    required this.network,
    required this.fee,
    required this.minimum,
    required this.gasAsset,
    required this.available,
    this.plusBps,
    this.note,
  });
  final String asset;
  final String? network;
  final String fee;
  final String minimum;

  /// The asset the NETWORK fee is paid in, which is often not the asset being
  /// withdrawn — sending ERC-20 USDT costs ETH.
  final String gasAsset;
  final bool available;
  final int? plusBps;
  final String? note;
}

/// What the venue owes against what it holds, per asset. `GET /public/reserves`.
class ReserveRow {
  const ReserveRow({
    required this.asset,
    required this.owed,
    required this.held,
    required this.fullyBacked,
  });
  final String asset;
  final String owed;
  final String held;
  final bool fullyBacked;
}

class ReservesDisclosure {
  const ReservesDisclosure({required this.disclaimer, required this.assets, this.note});

  /// The venue's own words. Carried VERBATIM: these are self-reported figures
  /// from its own ledger, not an audit, and summarising that away is exactly
  /// the overstatement the disclaimer exists to prevent.
  final String disclaimer;
  final List<ReserveRow> assets;
  final String? note;
}

/// One chain's withdrawable depth, from `/public/liquidity` or
/// `/v1/withdrawal-options`.
class ChainDepth {
  const ChainDepth({
    required this.network,
    required this.label,
    required this.available,
    required this.open,
    this.native = false,
    this.note,
  });

  /// The chain id to send back as `network` — EXCEPT when [native] is true.
  final String network;
  final String label;
  final String available;
  final bool open;

  /// A SINGLE-CHAIN ASSET'S "network" IS A LABEL, NOT A CHAIN ID.
  ///
  /// When this is true the caller must omit the network parameter entirely.
  /// Sending the symbol back as a chain id 400s every single-chain asset, which
  /// is what broke deposit-address issuance for all of them.
  final bool native;

  /// Why the chain is shut, when it is. Never blank in place of a reason.
  final String? note;

  /// The value to put in a `network=` parameter: empty for a native chain.
  String get param => native ? '' : network;
}

class AssetDepth {
  const AssetDepth({
    required this.asset,
    required this.decimals,
    required this.networks,
    required this.maxSingleWithdrawal,
    this.updatedAt,
  });
  final String asset;
  final int decimals;
  final List<ChainDepth> networks;
  final String maxSingleWithdrawal;
  final String? updatedAt;

  /// The first chain that can actually pay, or null when none can.
  ChainDepth? get firstOpen {
    for (final n in networks) {
      if (n.open) return n;
    }
    return null;
  }
}

/// One asset × chain deposit address, or the venue's reason there is none.
class DepositAddressRow {
  const DepositAddressRow({
    required this.asset,
    this.network,
    this.address,
    this.memo,
    this.memoRequired = false,
    this.open = true,
    this.reason,
  });
  final String asset;
  final String? network;
  final String? address;
  final String? memo;

  /// A memo that EXISTS is never optional — the chains that use them cannot
  /// credit a deposit without it.
  final bool memoRequired;
  final bool open;
  final String? reason;

  bool get ready => (address ?? '').isNotEmpty;
}

class DepositAddresses {
  const DepositAddresses({required this.rows, required this.note});
  final List<DepositAddressRow> rows;
  final String note;

  int get openCount => rows.where((r) => r.ready).length;
}

/// A deposit the chain has shown but the venue has not necessarily credited.
class DepositInFlight {
  const DepositInFlight({
    required this.asset,
    this.network,
    required this.amount,
    required this.txid,
    required this.confirmations,
    required this.outcome,
    this.detail,
    this.firstSeen,
  });
  final String asset;
  final String? network;
  final String amount;
  final String txid;
  final int confirmations;

  /// The venue's raw outcome: `credited`, `pending`, `unattributed`,
  /// `unreadable`. Kept raw so an outcome added later is shown rather than
  /// silently bucketed into something it is not.
  final String outcome;

  /// Carries "N of M confirmations" while pending, which is more use than the
  /// bare count.
  final String? detail;
  final String? firstSeen;

  bool get waiting => outcome == 'pending';
}

/// A server-computed withdrawal quote. The fee is WITHHELD from the amount.
class WithdrawalQuote {
  const WithdrawalQuote({
    required this.asset,
    this.network,
    required this.amount,
    required this.fee,
    required this.youReceive,
    required this.minimum,
    required this.gasAsset,
    required this.note,
    this.pricedAt,
    this.priceSource,
  });
  final String asset;
  final String? network;
  final String amount;
  final String fee;
  final String youReceive;
  final String minimum;
  final String gasAsset;
  final String note;
  final String? pricedAt;
  final String? priceSource;
}

/// A withdrawal in progress. The route returns all of this; the web renders
/// four of the fields and drops the rest, including the reason a payout stalled.
class WithdrawalRow {
  const WithdrawalRow({
    required this.id,
    required this.asset,
    this.network,
    required this.amount,
    required this.fee,
    required this.youReceive,
    required this.address,
    required this.state,
    this.reason,
    this.createdAt,
  });
  final String id;
  final String asset;
  final String? network;
  final String amount;
  final String fee;
  final String youReceive;
  final String address;
  final String state;
  final String? reason;
  final String? createdAt;
}

/// One allowlisted withdrawal destination.
class AllowlistEntry {
  const AllowlistEntry({
    required this.asset,
    required this.address,
    required this.addedAt,
    required this.usableAt,
    required this.usable,
  });
  final String asset;
  final String address;
  final String addedAt;

  /// 24 hours after it was added. The delay is the control: it is what stops
  /// someone who has taken over a session adding their own address and
  /// emptying the account before the owner notices.
  final String usableAt;
  final bool usable;
}

class AllowlistView {
  const AllowlistView({
    required this.entries,
    required this.cooldownHours,
    required this.required,
    required this.note,
  });
  final List<AllowlistEntry> entries;
  final int cooldownHours;

  /// Whether the venue REFUSES a destination that is not on this list. It is
  /// true on the live venue, which is why a withdrawal UI without an allowlist
  /// panel cannot complete a single withdrawal.
  final bool required;
  final String note;

  List<AllowlistEntry> forAsset(String asset) =>
      entries.where((e) => e.asset.toUpperCase() == asset.toUpperCase()).toList();
}

/// A programmatic trading key. The secret is NOT here — it is shown once, by
/// [ExchangeClient.createApiKey], and never again.
class ApiKeyRow {
  const ApiKeyRow({
    required this.keyId,
    required this.label,
    required this.scopes,
    required this.ratePerMin,
    this.createdAt,
    this.lastUsedAt,
    this.revokedAt,
  });
  final String keyId;
  final String label;
  final List<String> scopes;
  final int ratePerMin;
  final String? createdAt;
  final String? lastUsedAt;
  final String? revokedAt;

  bool get revoked => (revokedAt ?? '').isNotEmpty;
}

class ApiKeyList {
  const ApiKeyList({required this.keys, this.algorithm, this.stringToSign, this.cannotWithdraw = true});
  final List<ApiKeyRow> keys;
  final String? algorithm;
  final String? stringToSign;

  /// The venue says this on the route that LISTS keys, not just in its docs:
  /// no key can withdraw, and the scope cannot be added.
  final bool cannotWithdraw;

  int get liveCount => keys.where((k) => !k.revoked).length;
}

/// A freshly minted key. [secret] is the only copy there will ever be.
class NewApiKey {
  const NewApiKey({
    required this.keyId,
    required this.secret,
    required this.scopes,
    required this.ratePerMin,
    required this.warning,
  });
  final String keyId;
  final String secret;
  final List<String> scopes;
  final int ratePerMin;
  final String warning;
}

/// A priced maker ladder, before it is placed.
class LadderQuote {
  const LadderQuote({
    required this.market,
    required this.breakEvenBps,
    required this.loses,
    required this.note,
    required this.baseNeeded,
    required this.quoteNeeded,
    required this.bidCount,
    required this.askCount,
  });
  final String market;
  final int breakEvenBps;

  /// True when the chosen spread is inside break-even, i.e. the ladder loses
  /// money on every round trip. The only thing that may set `acceptLoss`.
  final bool loses;
  final String note;
  final String baseNeeded;
  final String quoteNeeded;
  final int bidCount;
  final int askCount;
}

class LadderPosition {
  const LadderPosition({
    required this.id,
    required this.market,
    required this.state,
    required this.mid,
    required this.spreadBps,
    required this.rungs,
    required this.orders,
    required this.filled,
    required this.resting,
    this.createdAt,
  });
  final String id;
  final String market;
  final String state;
  final String mid;
  final int spreadBps;
  final int rungs;
  final int orders;
  final String filled;
  final String resting;
  final String? createdAt;

  bool get open => state == 'open';
}

/// One question on the listing application, as the SERVER defines it.
///
/// THE FIELDS ARE `key` AND `max`. `/public/listing-questions` serialises
/// `QUESTIONS` verbatim (listings.ts:82-88), whose members are
/// `{key, label, hint, required, max}` — there is no `id` and no `maxLength`.
/// This mapper read `id`, so every question arrived with an EMPTY id: the form
/// built one shared text controller for all thirteen fields, posted
/// `{"": "…"}`, and the server — which validates by `q.key` — answered "Project
/// name is required" to every application anyone ever sent. A listing enquiry
/// that reaches nobody is the worst outcome a form has, and it is the one this
/// had.
class ListingQuestion {
  const ListingQuestion({
    required this.id,
    required this.label,
    required this.required,
    this.maxLength,
    this.hint,
  });
  final String id;
  final String label;
  final bool required;
  final int? maxLength;
  final String? hint;

  /// Long answers get a multi-line field. The threshold is the server's own
  /// maxLength, so the form shape follows the question rather than a guess.
  bool get multiline => (maxLength ?? 0) > 200;
}

class ExchangeException implements Exception {
  ExchangeException(this.message, {this.status});
  final String message;
  final int? status;
  @override
  String toString() => 'ExchangeException($status): $message';
}

class ExchangeClient {
  ExchangeClient({
    String base = kExchangeBase,
    HttpSend? send,
    String? Function()? bearer,
  })  : _base = _origin(base),
        _send = send ?? httpSend,
        _bearer = bearer;

  final String _base;
  final HttpSend _send;
  final String? Function()? _bearer;

  String? lastError;

  /// Whether an account session is available for the authenticated routes.
  bool get signedIn {
    final t = _bearer?.call();
    return t != null && t.isNotEmpty;
  }

  Map<String, String> _headers({
    bool auth = false,
    bool json = false,
    Map<String, String>? extra,
  }) {
    final h = <String, String>{'accept': 'application/json'};
    if (json) h['content-type'] = 'application/json';
    if (extra != null) h.addAll(extra);
    if (auth) {
      final t = _bearer?.call();
      if (t == null || t.isEmpty) {
        throw ExchangeException(
          'Sign in to your Blockle account to see your exchange balance.',
          status: 401,
        );
      }
      h['authorization'] = 'Bearer $t';
    }
    return h;
  }

  Future<dynamic> _req(
    String method,
    String path, {
    bool auth = false,
    Object? body,
    Map<String, String>? extra,
  }) async {
    final req = HttpReq(
      method,
      '$_base$path',
      headers: _headers(auth: auth, json: body != null, extra: extra),
      body: body == null ? null : jsonEncode(body),
    );
    final HttpReply r;
    try {
      r = await _send(req);
    } catch (e) {
      lastError = 'the exchange is unreachable';
      throw ExchangeException('the exchange is unreachable: $e');
    }
    dynamic decoded;
    if (r.body.isNotEmpty) {
      try {
        decoded = jsonDecode(r.body);
      } catch (_) {
        // A proxy error page, or a plain-text txid. Keep the text.
        decoded = r.body;
      }
    }
    if (r.status < 200 || r.status >= 300) {
      final msg = decoded is Map && decoded['error'] != null
          ? decoded['error'].toString()
          : 'HTTP ${r.status}';
      lastError = msg;
      throw ExchangeException(msg, status: r.status);
    }
    lastError = null;
    return decoded;
  }

  // ------------------------------------------------------------ public reads

  Future<ExchangeStatus> status() async {
    final j = await _req('GET', '$_kPublic/status') as Map<String, dynamic>;
    return ExchangeStatus(
      live: j['live'] == true,
      mainnetEnabled: j['mainnetEnabled'] == true,
      legalReviewCompleted: j['legalReviewCompleted'] == true,
      network: (j['network'] ?? 'unknown').toString(),
      ledgerPresent: j['ledgerPresent'] == true,
      faucetAvailable: j['faucetAvailable'] == true,
    );
  }

  /// The trading fee schedule. Flat, symmetric, no tiers.
  ///
  /// The app has never called this, which is why the order ticket could not
  /// show an estimated fee and the maker-ladder screen could not state a
  /// break-even.
  Future<ExchangeFees> fees() async {
    final j = await _req('GET', '$_kPublic/fees') as Map<String, dynamic>;
    return ExchangeFees(
      makerPct: (j['makerPct'] ?? '—').toString(),
      takerPct: (j['takerPct'] ?? '—').toString(),
      makerBps: (j['makerBps'] as num?)?.toInt() ?? 0,
      takerBps: (j['takerBps'] as num?)?.toInt() ?? 0,
      note: (j['note'] ?? '').toString(),
    );
  }

  /// The published withdrawal fee schedule, with the note that explains it.
  Future<({List<WithdrawalFee> fees, String note})> withdrawalFeeSchedule() async {
    final j = await _req('GET', '$_kPublic/withdrawal-fees') as Map<String, dynamic>;
    final rows = (j['fees'] is List ? j['fees'] as List : const [])
        .whereType<Map<String, dynamic>>()
        .map((f) => WithdrawalFee(
              asset: (f['asset'] ?? '').toString(),
              network: _str(f['network']),
              fee: (f['fee'] ?? '—').toString(),
              minimum: (f['minimum'] ?? '—').toString(),
              gasAsset: (f['gasAsset'] ?? '').toString(),
              available: f['available'] == true,
              plusBps: (f['plusBps'] as num?)?.toInt(),
              note: _str(f['note']),
            ))
        .toList();
    return (fees: rows, note: (j['note'] ?? '').toString());
  }

  /// Owed vs held, per asset, with the venue's own disclaimer.
  Future<ReservesDisclosure> reserves() async {
    final j = await _req('GET', '$_kPublic/reserves') as Map<String, dynamic>;
    return ReservesDisclosure(
      disclaimer: (j['disclaimer'] ??
              'Self-reported figures from our own ledger. Not an independent '
                  'audit or attestation.')
          .toString(),
      note: _str(j['note']),
      assets: (j['assets'] is List ? j['assets'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((a) => ReserveRow(
                asset: (a['asset'] ?? '').toString(),
                owed: (a['owed'] ?? '—').toString(),
                held: (a['held'] ?? '—').toString(),
                fullyBacked: a['fullyBacked'] == true,
              ))
          .toList(),
    );
  }

  /// What can be withdrawn right now, per asset per chain. Public: this is the
  /// figure index.html publishes and the trading app never showed.
  Future<List<AssetDepth>> publicLiquidity() async {
    final j = await _req('GET', '$_kPublic/liquidity') as Map<String, dynamic>;
    return (j['assets'] is List ? j['assets'] as List : const [])
        .whereType<Map<String, dynamic>>()
        .map(_assetDepth)
        .toList();
  }

  /// The listing application's question set, as the server defines it.
  ///
  /// GENERATED, NOT HARDCODED: a question that exists in the UI but not in this
  /// list is answered by the applicant and received by nobody, which is the
  /// worst failure a form has.
  Future<List<ListingQuestion>> listingQuestions() async {
    final j = await _req('GET', '$_kPublic/listing-questions') as Map<String, dynamic>;
    return (j['questions'] is List ? j['questions'] as List : const [])
        .whereType<Map<String, dynamic>>()
        // `key` first, because that is what the server both sends and reads.
        // The aliases stay as a courtesy to an older or newer venue; they are
        // not what the live one sends.
        .map((q) => ListingQuestion(
              id: (q['key'] ?? q['id'] ?? q['name'] ?? '').toString(),
              label: (q['label'] ?? '').toString(),
              required: q['required'] == true,
              maxLength:
                  (q['max'] as num?)?.toInt() ?? (q['maxLength'] as num?)?.toInt(),
              hint: _str(q['hint']),
            ))
        // A question with no key cannot be submitted under any key the server
        // would read, so it is dropped rather than rendered as a field whose
        // answer goes nowhere.
        .where((q) => q.id.isNotEmpty)
        .toList();
  }

  /// Submit a listing application. No account needed, deliberately.
  Future<Map<String, dynamic>> applyForListing(Map<String, String> answers) async {
    final j = await _req('POST', '$_kPublic/listing-apply', body: answers);
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  /// Markets merged with their tickers, so one call feeds a market list.
  ///
  /// EVERY FIELD `/public/markets` PUBLISHES IS CARRIED. The route grew four
  /// concepts with the 25→40 market expansion and this mapper read none of
  /// them, which is a silent failure in each case:
  ///
  ///   * `closed`        — six markets refuse orders right now. Without it the
  ///                       app offered a ticket that answers 409 every time.
  ///   * `caveat`        — "open, with a known gap", which every BLOCK market
  ///                       carries. The venue COMPUTED that sentence and
  ///                       nothing carried it, so clients read a bare "open".
  ///   * `priceScale`    — a client cannot derive it, and `quoteDecimals`
  ///                       alone is wrong by 10^priceDecimals.
  ///   * `minNotional`   — a second floor, so an order over `minBase` can
  ///                       still be refused with no field to explain why.
  Future<List<ExchangeMarket>> getMarkets() async {
    final mkts = await _req('GET', '$_kPublic/markets') as List<dynamic>;
    // Tickers are a nicety: a market list is still correct without prices, so
    // a ticker failure must not blank the whole screen.
    List<dynamic> ticks = const [];
    try {
      ticks = await _req('GET', '$_kPublic/tickers') as List<dynamic>;
    } catch (_) {}
    final byMarket = <String, Map<String, dynamic>>{
      for (final t in ticks)
        if (t is Map<String, dynamic> && t['market'] != null)
          t['market'].toString(): t,
    };
    return mkts.whereType<Map<String, dynamic>>().map((m) {
      final sym = (m['symbol'] ?? '').toString();
      final t = byMarket[sym];
      return ExchangeMarket(
        id: sym,
        base: (m['base'] ?? '').toString(),
        quote: (m['quote'] ?? '').toString(),
        baseDecimals: (m['baseDecimals'] as num?)?.toInt() ?? 8,
        quoteDecimals: (m['quoteDecimals'] as num?)?.toInt() ?? 8,
        priceDecimals: (m['priceDecimals'] as num?)?.toInt() ?? 0,
        priceScale: (m['priceScale'] as num?)?.toInt(),
        minBase: m['minBase']?.toString(),
        minNotional: _str(m['minNotional']),
        // `state` is derivable from `closed`, so the SENTENCE is what is kept:
        // "closed" with no reason is the half of the answer nobody can act on.
        closed: _str(m['closed']),
        caveat: _str(m['caveat']),
        listedAt: _str(m['listedAt']),
        last: _num(t?['last']),
        bid: _num(t?['bid']),
        ask: _num(t?['ask']),
        change24h: _num(t?['change24h']),
        volume24h: _num(t?['volume24h']),
        lastText: t?['last']?.toString(),
        bidText: t?['bid']?.toString(),
        askText: t?['ask']?.toString(),
      );
    }).toList();
  }

  Future<OrderBook?> getBook(String market) async {
    final j = await _req('GET', '$_kPublic/book/${Uri.encodeComponent(market)}');
    if (j is! Map<String, dynamic>) return null;
    // `base`, NOT `amount`.
    //
    // THE WEB IS WRONG HERE AND THIS IS RIGHT. `GET /public/book` returns each
    // level's size under `base` (publicapi.ts:1930-1931); exchange.js reads
    // `r.amount`, so the live web ladder's size column renders an em dash and
    // every cumulative-depth bar computes to zero width. Do not "fix" this to
    // match the web.
    List<OrderLevel> side(Object? raw) => (raw is List ? raw : const [])
        .whereType<Map<String, dynamic>>()
        .map((l) => OrderLevel(
              _num(l['price']) ?? 0,
              _num(l['base']) ?? 0,
              priceText: l['price']?.toString(),
              sizeText: l['base']?.toString(),
            ))
        .where((l) => l.price > 0)
        .toList();
    return OrderBook(side(j['bids']), side(j['asks']));
  }

  Future<List<Map<String, dynamic>>> getTrades(String market) async {
    final j = await _req('GET', '$_kPublic/trades/${Uri.encodeComponent(market)}');
    return (j is List ? j : const []).whereType<Map<String, dynamic>>().toList();
  }

  // ------------------------------------------------------- the account's money

  Future<List<ExchangeBalance>> getBalances() async {
    final j = await _req('GET', '$_kV1/balances', auth: true);
    return (j is List ? j : const [])
        .whereType<Map<String, dynamic>>()
        .map((b) => ExchangeBalance(
              asset: (b['asset'] ?? '').toString(),
              total: (b['total'] ?? '0').toString(),
              reserved: (b['reserved'] ?? '0').toString(),
              available: (b['available'] ?? '0').toString(),
              decimals: (b['decimals'] as num?)?.toInt() ?? 8,
            ))
        .toList();
  }

  /// Where to send coins from the wallet to trade them here.
  ///
  /// THIS IS THE ONLY BRIDGE between the two pots, and the user drives it: the
  /// app shows the address and they send to it like any other withdrawal.
  Future<DepositTarget> depositAddress(String asset, {String? network}) async {
    final q = StringBuffer('?asset=${Uri.encodeComponent(asset)}');
    if (network != null && network.isNotEmpty) {
      q.write('&network=${Uri.encodeComponent(network)}');
    }
    final j = await _req('GET', '$_kV1/deposit-address$q', auth: true);
    if (j is! Map<String, dynamic>) {
      throw ExchangeException('the venue returned no deposit information');
    }
    // EVERY FIELD THE ROUTE SENDS. `describeDeposit` returns asset, network,
    // address, memo, memoRequired, reason and alternatives — and no `note`,
    // which is a field on the PLURAL route's envelope. Reading `note` here
    // produced a permanent null and dropped the memo, which is the one value a
    // memo-chain deposit cannot arrive without.
    return DepositTarget(
      address: _str(j['address']),
      network: _str(j['network']),
      memo: _str(j['memo']),
      // Trust the server's own flag, then fall back to "a memo exists" — which
      // is the rule the server itself applies — so an older venue that sends
      // only `memo` still shows it as required rather than as optional.
      memoRequired: j['memoRequired'] == true || _str(j['memo']) != null,
      reason: _str(j['reason'] ?? j['error']),
      alternatives: (j['alternatives'] is List ? j['alternatives'] as List : const [])
          .map((a) => a.toString())
          .where((a) => a.isNotEmpty)
          .toList(),
    );
  }

  /// Every order this account has placed, newest first — not just the open
  /// ones. `GET /v1/orders` is the full history and the state field is what
  /// separates working from done.
  ///
  /// THE SIZE FIELD IS `total`. This mapper read `base`, which `GET /v1/orders`
  /// has never returned (publicapi.ts:826), so every order in the app showed a
  /// size of 0 — a resting order for 1,000 RTM rendered as "SELL 0 RTM-USDT".
  /// `base` is the key on the BOOK and the TAPE, not on an order; the two
  /// shapes are different and conflating them is what caused this.
  Future<List<OpenOrder>> getOpenOrders() async {
    final j = await _req('GET', '$_kV1/orders', auth: true);
    final rows = j is List ? j : (j is Map ? (j['orders'] as List? ?? const []) : const []);
    return rows.whereType<Map<String, dynamic>>().map((o) {
      final total = o['total'] ?? o['base'] ?? o['size'];
      return OpenOrder(
        id: (o['id'] ?? o['orderId'] ?? '').toString(),
        market: (o['market'] ?? '').toString(),
        side: (o['side'] ?? '').toString(),
        price: _num(o['price']) ?? 0,
        size: _num(total) ?? 0,
        filled: _num(o['filled']),
        status: o['state']?.toString() ?? o['status']?.toString(),
        priceText: o['price']?.toString(),
        sizeText: total?.toString(),
        filledText: o['filled']?.toString(),
        createdAt: o['createdAt']?.toString(),
      );
    }).toList();
  }

  /// Place an order. Amounts are STRINGS end to end.
  ///
  /// Never a double: a price or size that has been through a JSON number has
  /// already lost its last digits for anything above 2^53 base units, and an
  /// order is a claim on real money. The venue parses decimal strings.
  ///
  /// THE FIELD IS `amount`, AND THERE IS NO `type`.
  ///
  /// This used to post `{market, side, type, base, price}`. `POST /v1/orders`
  /// reads `str(b, "amount")` (publicapi.ts:800) and `str()` THROWS on a
  /// missing key, so the venue answered 400 to every order the app ever sent —
  /// the order form was decorative. There is no `type` field at all because the
  /// venue has only limit orders; sending one was harmless but misleading, so
  /// it is gone from the wire while [type] stays in the signature to keep the
  /// agent and bot call sites compiling and to keep enforcing "a limit order
  /// needs a price" on this side of the network.
  Future<Map<String, dynamic>> placeOrder({
    required String market,
    required String side,
    required String type,
    required String size,
    String? price,
  }) async {
    if (price == null || price.isEmpty) {
      throw ExchangeException(
        type == 'limit'
            ? 'a limit order needs a price'
            : 'this venue has limit orders only, so a price is required',
      );
    }
    final j = await _req('POST', '$_kV1/orders', auth: true, body: {
      'market': market,
      'side': side,
      'amount': size,
      'price': price,
    });
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  Future<Map<String, dynamic>> cancelOrder(String orderId) async {
    final j = await _req(
      'POST',
      '$_kV1/orders/${Uri.encodeComponent(orderId)}/cancel',
      auth: true,
    );
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  // ------------------------------------------------------------ the account

  /// Who the venue thinks you are. Also the 503-vs-401 discriminator: an
  /// unreachable accounts service is a 503, which is a different instruction to
  /// the customer than "sign in" and must not be flattened into a sign-in loop
  /// that cannot succeed.
  Future<ExchangeMe> me() async {
    final j = await _req('GET', '$_kV1/me', auth: true) as Map<String, dynamic>;
    return ExchangeMe(
      accountId: (j['accountId'] ?? '').toString(),
      email: _str(j['email']),
      twoFactor: j['twoFactor'] is bool ? j['twoFactor'] as bool : null,
    );
  }

  // ------------------------------------------------------------- deposits

  /// EVERY deposit address for this account, provisioned on sight.
  ///
  /// A customer should not have to discover that their account HAS a Bitcoin
  /// address by finding the right dropdown. A closed chain comes back with a
  /// null address and the reason rather than being skipped, because "no address
  /// shown" and "this chain is shut until its gas float is funded" look
  /// identical on a screen and only one of them is worth waiting out.
  Future<DepositAddresses> depositAddresses() async {
    final j = await _req('GET', '$_kV1/deposit-addresses', auth: true)
        as Map<String, dynamic>;
    return DepositAddresses(
      note: (j['note'] ?? '').toString(),
      rows: (j['addresses'] is List ? j['addresses'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((a) => DepositAddressRow(
                asset: (a['asset'] ?? '').toString(),
                network: _str(a['network']),
                address: _str(a['address']),
                memo: _str(a['memo']),
                memoRequired: a['memoRequired'] == true,
                open: a['open'] != false,
                reason: _str(a['reason']),
              ))
          .toList(),
    );
  }

  /// Deposits the chain has shown us. This is what makes "where is my deposit"
  /// answerable without a support ticket.
  Future<List<DepositInFlight>> deposits() async {
    final j = await _req('GET', '$_kV1/deposits', auth: true);
    final rows = j is Map ? (j['deposits'] as List? ?? const []) : const [];
    return rows
        .whereType<Map<String, dynamic>>()
        .map((d) => DepositInFlight(
              asset: (d['asset'] ?? '').toString(),
              network: _str(d['network']),
              amount: (d['amount'] ?? '—').toString(),
              txid: (d['txid'] ?? '').toString(),
              confirmations: (d['confirmations'] as num?)?.toInt() ?? 0,
              outcome: (d['outcome'] ?? '').toString(),
              detail: _str(d['detail']),
              firstSeen: _str(d['firstSeen']),
            ))
        .toList();
  }

  // ------------------------------------------------------------ withdrawals

  /// The chains an asset can leave on, with live availability.
  ///
  /// Also the ONLY way to enumerate chains for a deposit: the deposit-address
  /// route takes a network but cannot list them.
  Future<AssetDepth> withdrawalOptions(String asset) async {
    final j = await _req(
      'GET',
      '$_kV1/withdrawal-options?asset=${Uri.encodeComponent(asset)}',
      auth: true,
    ) as Map<String, dynamic>;
    return _assetDepth(j);
  }

  /// The exact fee, minimum and net, computed by the same code that prices the
  /// real withdrawal. A preview computed by different code is a preview that
  /// will eventually disagree with the charge.
  Future<WithdrawalQuote> withdrawalQuote({
    required String asset,
    String? network,
    required String amount,
  }) async {
    final q = StringBuffer('?asset=${Uri.encodeComponent(asset)}'
        '&amount=${Uri.encodeComponent(amount)}');
    // OMITTED, not empty, for a native chain — see [ChainDepth.native].
    if (network != null && network.isNotEmpty) {
      q.write('&network=${Uri.encodeComponent(network)}');
    }
    final j = await _req('GET', '$_kV1/withdrawal-quote$q', auth: true)
        as Map<String, dynamic>;
    return WithdrawalQuote(
      asset: (j['asset'] ?? asset).toString(),
      network: _str(j['network']),
      amount: (j['amount'] ?? amount).toString(),
      fee: (j['fee'] ?? '—').toString(),
      youReceive: (j['youReceive'] ?? '—').toString(),
      minimum: (j['minimum'] ?? '—').toString(),
      gasAsset: (j['gasAsset'] ?? '').toString(),
      note: (j['note'] ?? '').toString(),
      pricedAt: _str(j['pricedAt']),
      priceSource: _str(j['priceSource']),
    );
  }

  /// Request a withdrawal.
  ///
  /// THREE GATES, NONE OF WHICH THIS CLIENT MAY BYPASS, and all of them live on
  /// the server:
  ///
  ///   1. SESSION ONLY. An API key is refused outright. This client sends a
  ///      Bearer session and no `x-blockle-key`, so it qualifies.
  ///   2. A SECOND FACTOR, ON THIS REQUEST. The code rides the
  ///      `x-blockle-totp` HEADER and is spent server-side, so one code cannot
  ///      buy a window in which an unattended session keeps withdrawing. There
  ///      is no code path here that omits it.
  ///   3. AN ALLOWLISTED DESTINATION, with a 24h cooling-off period. Enforced
  ///      by `Withdrawals.request`; see [allowlist].
  ///
  /// [requestId] is the idempotency key, so a double-tap is one withdrawal.
  Future<WithdrawalRow> requestWithdrawal({
    required String asset,
    String? network,
    required String amount,
    required String address,
    required String totpCode,
    required String requestId,
  }) async {
    if (totpCode.trim().isEmpty) {
      // Refused here rather than sent: an empty header would come back as the
      // venue's "not enrolled" 403, which is a different and misleading
      // message from "you did not type your code".
      throw ExchangeException(
        'Enter the 6-digit code from your authenticator. Every withdrawal '
        'needs one — a code is spent on the single request it authorises.',
      );
    }
    final j = await _req(
      'POST',
      '$_kV1/withdrawals',
      auth: true,
      extra: {'x-blockle-totp': totpCode.trim()},
      body: {
        'asset': asset,
        if (network != null && network.isNotEmpty) 'network': network,
        'amount': amount,
        'address': address,
        'requestId': requestId,
      },
    ) as Map<String, dynamic>;
    return WithdrawalRow(
      id: (j['id'] ?? '').toString(),
      asset: (j['asset'] ?? asset).toString(),
      network: _str(j['network']),
      amount: (j['amount'] ?? amount).toString(),
      fee: (j['fee'] ?? '—').toString(),
      youReceive: (j['youReceive'] ?? '—').toString(),
      address: (j['address'] ?? address).toString(),
      state: (j['state'] ?? 'requested').toString(),
    );
  }

  Future<List<WithdrawalRow>> withdrawals() async {
    final j = await _req('GET', '$_kV1/withdrawals', auth: true);
    return (j is List ? j : const [])
        .whereType<Map<String, dynamic>>()
        .map((w) => WithdrawalRow(
              id: (w['id'] ?? '').toString(),
              asset: (w['asset'] ?? '').toString(),
              network: _str(w['network']),
              amount: (w['amount'] ?? '—').toString(),
              fee: (w['fee'] ?? '—').toString(),
              youReceive: (w['youReceive'] ?? '—').toString(),
              address: (w['address'] ?? '').toString(),
              state: (w['state'] ?? '').toString(),
              reason: _str(w['reason']),
              createdAt: _str(w['createdAt']),
            ))
        .toList();
  }

  /// A fresh idempotency key for a withdrawal. Generated on the CLIENT so that
  /// a double-tap sends the same key twice and the venue answers with the one
  /// withdrawal it already made.
  static String newRequestId() {
    final r = Random.secure();
    final b = List<int>.generate(9, (_) => r.nextInt(256));
    return 'app-${DateTime.now().millisecondsSinceEpoch}-'
        '${b.map((x) => x.toRadixString(16).padLeft(2, '0')).join()}';
  }

  // -------------------------------------------------- the withdrawal allowlist

  /// The destinations this account may withdraw to.
  ///
  /// THE SINGLE MOST IMPORTANT ROUTE IN THIS FILE. `WD_REQUIRE_ALLOWLIST` is
  /// true on the live venue, so `Withdrawals.request` refuses any destination
  /// that is not on this list — and there is no allowlist UI anywhere in the
  /// web front-end. Withdrawals were therefore impossible from every shipped
  /// surface: every attempt failed with "is not an allowlisted <ASSET>
  /// destination" and no screen could add one. This is the fix.
  Future<AllowlistView> allowlist() async {
    final j = await _req('GET', '$_kV1/allowlist', auth: true) as Map<String, dynamic>;
    return AllowlistView(
      cooldownHours: (j['cooldownHours'] as num?)?.toInt() ?? 24,
      required: j['required'] == true,
      note: (j['note'] ?? '').toString(),
      entries: (j['addresses'] is List ? j['addresses'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((a) => AllowlistEntry(
                asset: (a['asset'] ?? '').toString(),
                address: (a['address'] ?? '').toString(),
                addedAt: (a['addedAt'] ?? '').toString(),
                usableAt: (a['usableAt'] ?? '').toString(),
                usable: a['usable'] == true,
              ))
          .toList(),
    );
  }

  /// Add a destination. NEEDS THE SECOND FACTOR: if a session alone could add
  /// one, an attacker holding a session would add their own and the allowlist
  /// would have cost them a single extra request.
  Future<AllowlistEntry> addToAllowlist({
    required String asset,
    required String address,
    required String totpCode,
  }) async {
    if (totpCode.trim().isEmpty) {
      throw ExchangeException(
        'Adding a withdrawal address needs the 6-digit code from your '
        'authenticator — it is the control that stops someone else adding one.',
      );
    }
    final j = await _req(
      'POST',
      '$_kV1/allowlist',
      auth: true,
      extra: {'x-blockle-totp': totpCode.trim()},
      body: {'asset': asset, 'address': address},
    ) as Map<String, dynamic>;
    return AllowlistEntry(
      asset: (j['asset'] ?? asset).toString(),
      address: (j['address'] ?? address).toString(),
      addedAt: DateTime.now().toUtc().toIso8601String(),
      usableAt: (j['usableAt'] ?? '').toString(),
      usable: false,
    );
  }

  /// Remove a destination. NO CODE, deliberately — removal only ever narrows
  /// what can be paid, and a control that is hard to loosen but easy to tighten
  /// is the right way round. Someone who suspects trouble should not be hunting
  /// for their phone to take an address OFF the list.
  Future<bool> removeFromAllowlist({
    required String asset,
    required String address,
  }) async {
    final j = await _req('POST', '$_kV1/allowlist/remove', auth: true, body: {
      'asset': asset,
      'address': address,
    });
    return j is Map && j['removed'] == true;
  }

  // ------------------------------------------------------- the second factor

  /// Whether an authenticator is armed. Throws rather than returning false on
  /// a failed read — "we could not check" must never render as "it is off".
  Future<bool> twoFactorEnrolled() async {
    final j = await _req('GET', '$_kV1/2fa', auth: true) as Map<String, dynamic>;
    return j['enrolled'] == true;
  }

  /// Begin enrolment. The secret is shown EXACTLY ONCE, here.
  ///
  /// [currentCode] is only consulted when one is already confirmed: replacing a
  /// live authenticator requires proving you hold it.
  ///
  /// `uri` is the otpauth:// URI, which the web ignores. On a phone it is the
  /// whole ergonomic win — a QR to scan, or a one-tap handoff to the
  /// authenticator app that is already on this device.
  Future<({String secret, String uri, String note})> beginTwoFactor({
    String? currentCode,
  }) async {
    final j = await _req('POST', '$_kV1/2fa/begin', auth: true, body: {
      if (currentCode != null && currentCode.isNotEmpty) 'currentCode': currentCode,
    }) as Map<String, dynamic>;
    return (
      secret: (j['secret'] ?? '').toString(),
      uri: (j['uri'] ?? '').toString(),
      note: (j['note'] ?? '').toString(),
    );
  }

  /// Arm it. Until a code is confirmed the enrolment protects nothing.
  Future<void> confirmTwoFactor(String code) =>
      _req('POST', '$_kV1/2fa/confirm', auth: true, body: {'code': code});

  /// Turn it off. Needs a current code, and the caller must say out loud that
  /// withdrawals stop working until a new one is set up.
  Future<void> disableTwoFactor(String code) =>
      _req('POST', '$_kV1/2fa/disable', auth: true, body: {'code': code});

  // ------------------------------------------------------ programmatic keys

  Future<ApiKeyList> apiKeys() async {
    final j = await _req('GET', '$_kV1/api-keys', auth: true) as Map<String, dynamic>;
    final signing = j['signing'] is Map ? j['signing'] as Map : const {};
    return ApiKeyList(
      algorithm: _str(signing['algorithm']),
      stringToSign: _str(signing['stringToSign']),
      cannotWithdraw: signing['cannotWithdraw'] != false,
      keys: (j['keys'] is List ? j['keys'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((k) => ApiKeyRow(
                keyId: (k['keyId'] ?? '').toString(),
                label: (k['label'] ?? '').toString(),
                scopes: (k['scopes'] is List ? k['scopes'] as List : const [])
                    .map((s) => s.toString())
                    .toList(),
                ratePerMin: (k['ratePerMin'] as num?)?.toInt() ?? 0,
                createdAt: _str(k['createdAt']),
                lastUsedAt: _str(k['lastUsedAt']),
                revokedAt: _str(k['revokedAt']),
              ))
          .toList(),
    );
  }

  /// Mint a key. [scopes] may only be `read` or `read,trade` — withdrawal is
  /// not on the list and cannot be added, which is the point of keys existing
  /// at all.
  Future<NewApiKey> createApiKey({
    required String label,
    required List<String> scopes,
    int ratePerMin = 120,
  }) async {
    final j = await _req('POST', '$_kV1/api-keys', auth: true, body: {
      'label': label,
      'scopes': scopes,
      'ratePerMin': ratePerMin,
    }) as Map<String, dynamic>;
    return NewApiKey(
      keyId: (j['keyId'] ?? '').toString(),
      secret: (j['secret'] ?? '').toString(),
      scopes: (j['scopes'] is List ? j['scopes'] as List : scopes)
          .map((s) => s.toString())
          .toList(),
      ratePerMin: (j['ratePerMin'] as num?)?.toInt() ?? ratePerMin,
      warning: (j['warning'] ?? '').toString(),
    );
  }

  Future<void> revokeApiKey(String keyId) => _req(
        'DELETE',
        '$_kV1/api-keys/${Uri.encodeComponent(keyId)}',
        auth: true,
      );

  // --------------------------------------------------------- maker ladders

  /// Price a ladder before placing it. The quote carries the break-even,
  /// because a maker here pays the SAME fee as a taker with no rebate.
  Future<LadderQuote> ladderQuote({
    required String market,
    required String mid,
    required int spreadBps,
    required int rungs,
    required String baseCapital,
    required String quoteCapital,
  }) async {
    final q = '?market=${Uri.encodeComponent(market)}'
        '&mid=${Uri.encodeComponent(mid)}'
        '&spreadBps=$spreadBps&rungs=$rungs'
        '&base=${Uri.encodeComponent(baseCapital)}'
        '&quote=${Uri.encodeComponent(quoteCapital)}';
    final j = await _req('GET', '$_kV1/liquidity/quote$q', auth: true)
        as Map<String, dynamic>;
    return LadderQuote(
      market: (j['market'] ?? market).toString(),
      breakEvenBps: (j['breakEvenBps'] as num?)?.toInt() ?? 0,
      loses: j['loses'] == true,
      note: (j['note'] ?? '').toString(),
      baseNeeded: (j['baseNeeded'] ?? '—').toString(),
      quoteNeeded: (j['quoteNeeded'] ?? '—').toString(),
      bidCount: (j['bids'] is List ? (j['bids'] as List).length : 0),
      askCount: (j['asks'] is List ? (j['asks'] as List).length : 0),
    );
  }

  Future<List<LadderPosition>> ladders() async {
    final j = await _req('GET', '$_kV1/liquidity', auth: true);
    return (j is List ? j : const [])
        .whereType<Map<String, dynamic>>()
        .map((p) => LadderPosition(
              id: (p['id'] ?? '').toString(),
              market: (p['market'] ?? '').toString(),
              state: (p['state'] ?? '').toString(),
              mid: (p['mid'] ?? '—').toString(),
              spreadBps: (p['spreadBps'] as num?)?.toInt() ?? 0,
              rungs: (p['rungs'] as num?)?.toInt() ?? 0,
              orders: (p['orders'] as num?)?.toInt() ?? 0,
              filled: (p['filled'] ?? '—').toString(),
              resting: (p['resting'] ?? '—').toString(),
              createdAt: _str(p['createdAt']),
            ))
        .toList();
  }

  /// Place a ladder. [acceptLoss] is set ONLY by the user ticking the box after
  /// reading the break-even, never defaulted true.
  Future<Map<String, dynamic>> openLadder({
    required String market,
    required String mid,
    required int spreadBps,
    required int rungs,
    required String baseCapital,
    required String quoteCapital,
    bool acceptLoss = false,
  }) async {
    final j = await _req('POST', '$_kV1/liquidity', auth: true, body: {
      'market': market,
      'mid': mid,
      'spreadBps': spreadBps,
      'rungs': rungs,
      'base': baseCapital,
      'quote': quoteCapital,
      'acceptLoss': acceptLoss,
    });
    return j is Map<String, dynamic> ? j : <String, dynamic>{};
  }

  /// Close a ladder. The answer names the cancelled count AND the rungs that
  /// had already filled — those were real trades and are not reversed.
  Future<({int cancelled, int alreadyFilledOrGone})> closeLadder(String id) async {
    final j = await _req(
      'POST',
      '$_kV1/liquidity/${Uri.encodeComponent(id)}/close',
      auth: true,
    );
    final m = j is Map ? j : const {};
    return (
      cancelled: (m['cancelled'] as num?)?.toInt() ?? 0,
      alreadyFilledOrGone: (m['alreadyFilledOrGone'] as num?)?.toInt() ?? 0,
    );
  }

  // --------------------------------------------------------- the price oracle

  /// Last price per market symbol, for portfolio and bot marks.
  ///
  /// This is the seam the removal left empty — marks degraded to "unpriced"
  /// rather than showing a fake number, which was right, and this fills it
  /// with a real figure. Markets that have never traded stay absent rather
  /// than reporting zero.
  Future<Map<String, num>> lastPrices() async {
    final out = <String, num>{};
    for (final m in await getMarkets()) {
      final p = m.last;
      if (p != null) out[m.id] = p;
    }
    return out;
  }

  /// Indicative quote seam kept for the agent tools.
  Future<Map<String, dynamic>> quote(
      String from, String to, String amount, Map<String, dynamic> opts) async {
    try {
      final book = await getBook('$from-$to');
      final mid = book?.mid;
      if (mid == null) return const {'amountOut': '0', 'reason': 'no two-sided book'};
      final a = num.tryParse(amount) ?? 0;
      return {'amountOut': (a * mid).toString(), 'price': mid.toString()};
    } catch (e) {
      return {'amountOut': '0', 'reason': e.toString()};
    }
  }

  static num? _num(Object? v) {
    if (v == null) return null;
    if (v is num) return v;
    return num.tryParse(v.toString());
  }

  /// A non-empty string, or null. The venue sends JSON `null` for "no chain",
  /// "no reason", "never used"; `'null'` on a screen is a bug people report.
  static String? _str(Object? v) {
    if (v == null) return null;
    final s = v.toString();
    return s.isEmpty ? null : s;
  }

  /// `{asset, decimals, networks[], maxSingleWithdrawal}` — the shape shared by
  /// `/v1/withdrawal-options` and each entry of `/public/liquidity`. One mapper
  /// so the native-chain convention cannot be honoured in one place and
  /// forgotten in the other.
  ///
  /// ONLY ONE OF THE TWO ROUTES SENDS `native`. `/v1/withdrawal-options` does
  /// (publicapi.ts:875) because a caller that sends a single-chain asset's
  /// label back as `network=<SYMBOL>` 400s. `/public/liquidity` does NOT:
  /// `publish()` (liquidity.ts:273) drops the field. Defaulting it to false on
  /// the public route mislabelled every single-chain asset's own chain as a
  /// named network. The server builds that row as `network: chain ?? symbol`
  /// with `native: chain === undefined`, so `network == asset` IS the native
  /// row, and inferring it from that reconstructs exactly what `publish` threw
  /// away. The server's explicit flag always wins where it is present.
  static AssetDepth _assetDepth(Map<String, dynamic> j) {
    final asset = (j['asset'] ?? '').toString();
    return AssetDepth(
      asset: asset,
      decimals: (j['decimals'] as num?)?.toInt() ?? 8,
      maxSingleWithdrawal: (j['maxSingleWithdrawal'] ?? '—').toString(),
      updatedAt: _str(j['updatedAt']),
      networks: (j['networks'] is List ? j['networks'] as List : const [])
          .whereType<Map<String, dynamic>>()
          .map((n) {
        final net = (n['network'] ?? '').toString();
        return ChainDepth(
          network: net,
          label: (n['label'] ?? n['network'] ?? '').toString(),
          available: (n['available'] ?? '—').toString(),
          open: n['open'] == true,
          native: n.containsKey('native')
              ? n['native'] == true
              : net.isNotEmpty && net == asset,
          note: _str(n['note']),
        );
      }).toList(),
    );
  }
}
