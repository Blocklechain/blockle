extends Node
# Wallet — the game's tie-in to the Blockle ecosystem. Blockle Idle is a crypto-FREE
# game: this autoload NEVER holds a key, never signs, and never moves funds. It does
# exactly two things:
#
#   1. CONNECT a Blockle wallet (read the player's address) and read, display-only,
#      the BLOCK-721 NFT "collectibles" that address owns — so cosmetics the player
#      owns on-chain light up in their world.
#   2. Hand a MINT request off to the Blockle wallet app, which does all the signing.
#      The game only opens the wallet and waits for the result; it stays display-only.
#
# Connect + mint use a relay-poll handshake (no fragile inbound deep-links): the game
# opens the wallet via `blockle://dapp?req=<id>` and polls the relay for the result.
# This mirrors how WalletConnect pairs, and works identically on every platform the
# game ships to.
#
# PLATFORM SPLIT (App Store safety): on iOS the game is a pure read-only viewer — the
# Mint CTA is hidden (can_mint() == false) so there is no outbound crypto action.
# Web/Android/desktop get the full mint handoff. Flip ALLOW_MINT_ON_IOS to change it.

signal connected(address: String)
signal disconnected()
signal nfts_changed(nfts: Array)
signal connect_failed(reason: String)
signal mint_started()
signal mint_done(cosmetic_id: String, token: String, tx: String)
signal mint_failed(reason: String)

const API_BASE := "https://blockle.org/api"
const NFTS_PATH := "/explorer/nfts/"       # + <address>  -> {address,count,nfts:[{contract,tokenId}]}
const SESSION_PATH := "/dapp/session"      # POST -> {reqId}; GET /<reqId> -> {status,address,result}
const WALLET_SCHEME := "blockle://dapp?req="
const POLL_SECONDS := 2.0
const POLL_TIMEOUT := 180.0                # give up waiting on the wallet after 3 min

# Set true only if you deliberately want the mint handoff on iOS too (App Review risk).
const ALLOW_MINT_ON_IOS := false

var _poll_timer: Timer
var _poll_elapsed := 0.0
var _active_req := ""
var _active_kind := ""
var _active_cosmetic := ""

func _ready() -> void:
	_poll_timer = Timer.new()
	_poll_timer.wait_time = POLL_SECONDS
	_poll_timer.one_shot = false
	_poll_timer.timeout.connect(_on_poll_tick)
	add_child(_poll_timer)

# ---- persisted state (lives in Game.state so Save.gd serialises it) ----------

func _store() -> Dictionary:
	if not Game.state.has("wallet"):
		Game.state["wallet"] = {}
	var w: Dictionary = Game.state["wallet"]
	if not w.has("address"): w["address"] = ""
	if not w.has("nfts"): w["nfts"] = []            # [{contract, tokenId}]
	if not w.has("minted"): w["minted"] = {}        # cosmetic_id -> {contract, tokenId, tx}
	return w

func address() -> String:
	return _store()["address"]

func is_connected_wallet() -> bool:
	return address() != ""

func owned_nfts() -> Array:
	return _store()["nfts"]

# ---- capability gating -------------------------------------------------------

func is_ios() -> bool:
	return OS.get_name() == "iOS"

# The game can display owned NFT cosmetics everywhere; minting is the only gated action.
func can_mint() -> bool:
	return ALLOW_MINT_ON_IOS or not is_ios()

# ---- connect -----------------------------------------------------------------

func connect_wallet() -> void:
	_start_session("connect", {}, "")

func disconnect_wallet() -> void:
	var w := _store()
	w["address"] = ""
	w["nfts"] = []
	Game.emit_signal("state_dirty")
	emit_signal("disconnected")

# ---- mint (handoff only) -----------------------------------------------------

# Hand a "mint this cosmetic as an NFT" request to the Blockle wallet. The wallet
# builds + signs the LaunchNft tx; we only open it and await the result. No-op on
# platforms where minting is gated off.
func mint_cosmetic(cosmetic_id: String) -> void:
	if not can_mint():
		emit_signal("mint_failed", "minting is not available on this platform")
		return
	if not is_connected_wallet():
		emit_signal("mint_failed", "connect a wallet first")
		return
	var def: Dictionary = Cosmetics.item(cosmetic_id)
	var payload := {
		"cosmetic": cosmetic_id,
		"name": def.get("name", "Blockle Idle Collectible"),
		"uid": cosmetic_id,
		"address": address(),
	}
	emit_signal("mint_started")
	_start_session("mint", payload, cosmetic_id)

# ---- relay handshake ---------------------------------------------------------

func _start_session(kind: String, payload: Dictionary, cosmetic_id: String) -> void:
	_active_kind = kind
	_active_cosmetic = cosmetic_id
	var body := JSON.stringify({"app": "idle", "kind": kind, "payload": payload})
	var req := _new_request()
	req.request_completed.connect(func(_r, code, _h, data):
		req.queue_free()
		if code != 200:
			_fail(kind, "could not reach the Blockle relay (%d)" % code)
			return
		var res = JSON.parse_string(data.get_string_from_utf8())
		if typeof(res) != TYPE_DICTIONARY or not res.has("reqId"):
			_fail(kind, "unexpected relay response")
			return
		_active_req = String(res["reqId"])
		# Open the Blockle wallet app; it fetches the session by reqId and handles it.
		OS.shell_open(WALLET_SCHEME + _active_req)
		_poll_elapsed = 0.0
		_poll_timer.start()
	)
	var err := req.request(API_BASE + SESSION_PATH, ["Content-Type: application/json"], HTTPClient.METHOD_POST, body)
	if err != OK:
		req.queue_free()
		_fail(kind, "no network")

func _on_poll_tick() -> void:
	_poll_elapsed += POLL_SECONDS
	if _poll_elapsed >= POLL_TIMEOUT:
		_poll_timer.stop()
		_fail(_active_kind, "timed out waiting for the wallet")
		return
	if _active_req == "":
		_poll_timer.stop()
		return
	var req := _new_request()
	req.request_completed.connect(func(_r, code, _h, data):
		req.queue_free()
		if code != 200:
			return   # transient; keep polling
		var res = JSON.parse_string(data.get_string_from_utf8())
		if typeof(res) != TYPE_DICTIONARY:
			return
		var status := String(res.get("status", "pending"))
		if status == "pending":
			return
		_poll_timer.stop()
		if status == "approved":
			_on_approved(res)
		elif status == "rejected":
			_fail(_active_kind, "cancelled in the wallet")
		else:
			_fail(_active_kind, status)
	)
	req.request(API_BASE + SESSION_PATH + "/" + _active_req, [], HTTPClient.METHOD_GET)

func _on_approved(res: Dictionary) -> void:
	if _active_kind == "connect":
		var addr := String(res.get("address", ""))
		if addr == "":
			_fail("connect", "the wallet returned no address")
			return
		var w := _store()
		w["address"] = addr
		Game.emit_signal("state_dirty")
		emit_signal("connected", addr)
		refresh_nfts()
	elif _active_kind == "mint":
		var result: Dictionary = res.get("result", {})
		var token := String(result.get("token", ""))
		var tx := String(result.get("tx", ""))
		if token == "":
			_fail("mint", "mint did not complete")
			return
		var w := _store()
		w["minted"][_active_cosmetic] = {"contract": token, "tokenId": result.get("tokenId", ""), "tx": tx}
		Game.emit_signal("state_dirty")
		emit_signal("mint_done", _active_cosmetic, token, tx)
		refresh_nfts()   # the new NFT should now show up, display-only
	_active_req = ""

func _fail(kind: String, reason: String) -> void:
	_active_req = ""
	if kind == "mint":
		emit_signal("mint_failed", reason)
	else:
		emit_signal("connect_failed", reason)

# ---- owned-NFT read (display-only, public endpoint) --------------------------

func refresh_nfts() -> void:
	var addr := address()
	if addr == "":
		return
	var req := _new_request()
	req.request_completed.connect(func(_r, code, _h, data):
		req.queue_free()
		if code != 200:
			return
		var res = JSON.parse_string(data.get_string_from_utf8())
		if typeof(res) != TYPE_DICTIONARY:
			return
		var nfts: Array = res.get("nfts", [])
		var w := _store()
		w["nfts"] = nfts
		Game.emit_signal("state_dirty")
		_grant_recognised_collectibles(nfts)
		emit_signal("nfts_changed", nfts)
	)
	req.request(API_BASE + NFTS_PATH + addr, [], HTTPClient.METHOD_GET)

# Any owned NFT whose collection is a known Blockle Idle collectible, OR that this
# player minted from the game, grants the matching cosmetic so it becomes equippable
# and shows in their world. Ownership is the ONLY gate — purely visual, no economy.
func _grant_recognised_collectibles(nfts: Array) -> void:
	var owned_contracts := {}
	for n in nfts:
		owned_contracts[String(n.get("contract", ""))] = true
	# a) cosmetics this player minted from the game
	var minted: Dictionary = _store()["minted"]
	for cid in minted.keys():
		var rec: Dictionary = minted[cid]
		if owned_contracts.has(String(rec.get("contract", ""))):
			if not Cosmetics.is_owned(cid):
				Cosmetics.grant(cid)
	# b) official collectible drops (registry: collection contract -> cosmetic id)
	for item in Cosmetics.all_items():
		var coll := String(item.get("nft_collection", ""))
		if coll != "" and owned_contracts.has(coll):
			if not Cosmetics.is_owned(item.get("id", "")):
				Cosmetics.grant(item.get("id", ""))

func _new_request() -> HTTPRequest:
	var r := HTTPRequest.new()
	add_child(r)
	return r
