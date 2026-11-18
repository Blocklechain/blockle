extends Node
# OfflineManager — rewards time away from the game. Idle games live or die on
# this: when the player returns we credit production for the elapsed wall-clock
# time, capped so leaving for a week is not strictly better than playing. The
# cap and multiplier both grow with research, giving the tree real weight.

func base_cap_hours() -> float:
	return 8.0 + Research.offline_cap_hours_bonus()

func apply_offline() -> Dictionary:
	var now := Time.get_unix_time_from_system()
	var last := float(Game.state.get("last_saved", now))
	# A clock that moved backwards (timezone/DST/manual change) must not mint
	# resources, hence max(0, ...).
	var elapsed: float = max(0.0, now - last)
	var hours_cap := base_cap_hours()
	var capped: float = min(elapsed, hours_cap * 3600.0)
	var rates := Production.total_rates()
	var mult := 1.0 + Research.offline_mult()
	var earnings := {}
	for res_id in rates.keys():
		var amt: float = rates[res_id] * capped * mult
		if amt > 0.0:
			Game.add_resource(res_id, amt)
			earnings[res_id] = amt
	return {
		"elapsed": elapsed,
		"capped": capped,
		"hours_cap": hours_cap,
		"earnings": earnings,
		"rates": rates,
		"mult": mult,
	}
