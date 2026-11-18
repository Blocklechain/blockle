extends Node
# IAPManager — honest bridge to the native app store (Apple StoreKit via the
# "InAppStore" singleton, or Google Play via "GodotGooglePlayBilling").
#
# Real entitlement verification happens through the native store, not here: we
# only grant a cosmetic after the native layer reports a confirmed purchase or
# restore. We NEVER fabricate a purchase — if no store is present (editor or an
# unsupported build) purchase() fails loudly instead of granting anything.
#
# There are NO ads and NO subscriptions in this game. Every product is a
# one-time, cosmetic-only, non-consumable purchase.

signal purchase_completed(id: String)
signal purchase_failed(reason: String)
signal restored(ids: Array)

var store = null          # the native billing singleton, or null when unsupported
var _is_google := false   # the two stores expose different signal/method names

func _ready() -> void:
	if Engine.has_singleton("InAppStore"):
		store = Engine.get_singleton("InAppStore")
		_is_google = false
		store.connect("purchase_success", Callable(self, "_on_ios_purchase_success"))
		store.connect("purchase_fail", Callable(self, "_on_ios_purchase_fail"))
	elif Engine.has_singleton("GodotGooglePlayBilling"):
		store = Engine.get_singleton("GodotGooglePlayBilling")
		_is_google = true
		store.connect("purchases_updated", Callable(self, "_on_google_purchases_updated"))
		store.connect("purchase_error", Callable(self, "_on_google_purchase_error"))
		store.startConnection()
	else:
		store = null         # editor / desktop / unsupported: no faking purchases

func available() -> bool:
	return store != null

# The purchasable catalog is exactly the cosmetic catalog.
func products() -> Array:
	return Cosmetics.all_items()

# Kicks off a native purchase. If no store is available we fail honestly and
# return WITHOUT granting anything — a missing store never yields an entitlement.
func purchase(product_id: String) -> void:
	if not available():
		emit_signal("purchase_failed", "Store unavailable in this build")
		return
	if _is_google:
		store.purchase(product_id)
	else:
		store.purchase({ "product_id": product_id })

# Asks the native store to re-deliver previously-bought non-consumables so a
# player who reinstalls or switches devices gets their cosmetics back.
func restore_purchases() -> void:
	if not available():
		emit_signal("purchase_failed", "Store unavailable in this build")
		return
	if _is_google:
		store.queryPurchases()
	else:
		store.restore_purchases()

# ---- native callbacks: iOS StoreKit -----------------------------------------

func _on_ios_purchase_success(result) -> void:
	var product_id := _product_id_from_result(result)
	_grant_from_product(product_id)

func _on_ios_purchase_fail(_result) -> void:
	emit_signal("purchase_failed", "Purchase could not be completed")

# ---- native callbacks: Google Play Billing ----------------------------------

func _on_google_purchases_updated(purchases) -> void:
	var granted := []
	for p in purchases:
		var product_id := _product_id_from_result(p)
		var id := _grant_from_product(product_id)
		if id != "":
			granted.append(id)
	# queryPurchases (restore) routes here too; report the set that came back.
	if granted.size() > 0:
		emit_signal("restored", granted)

func _on_google_purchase_error(_code, _message) -> void:
	emit_signal("purchase_failed", "Purchase could not be completed")

# ---- shared helpers ---------------------------------------------------------

func _product_id_from_result(result) -> String:
	if typeof(result) == TYPE_DICTIONARY:
		return result.get("product_id", result.get("sku", ""))
	return str(result)

# Maps a confirmed native product id to its cosmetic and grants it. Only called
# from native success/restore callbacks, so a grant always follows real
# verification by the store.
func _grant_from_product(product_id: String) -> String:
	var id := Cosmetics.item_id_for_product(product_id)
	if id == "":
		push_warning("IAP: no cosmetic maps to product " + product_id)
		return ""
	Cosmetics.grant(id)
	Game.save_now()
	emit_signal("purchase_completed", id)
	return id

# Local-testing shortcut ONLY. Guarded so it is inert in release builds and can
# never be used to bypass a real purchase on a shipped app.
func _debug_grant(id: String) -> void:
	if not OS.is_debug_build():
		return
	Cosmetics.grant(id)
	Game.save_now()
	emit_signal("purchase_completed", id)
