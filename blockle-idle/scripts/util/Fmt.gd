class_name Fmt
extends RefCounted

# Large-number formatting for an idle game: 1.2K, 3.4M, 5.6B ... then aa, ab, ac
# for the astronomically large values the late game produces.
const SUFFIX := ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"]

static func short(n: float) -> String:
	if n < 0.0:
		return "-" + short(-n)
	if n < 1000.0:
		# small values: show up to one decimal under 10, else whole
		if n < 10.0 and n != floor(n):
			return String.num(n, 1)
		return str(int(round(n)))
	var tier := int(floor(log(n) / log(1000.0)))
	if tier < SUFFIX.size():
		var scaled := n / pow(1000.0, tier)
		return String.num(scaled, 2).rstrip("0").rstrip(".") + SUFFIX[tier]
	# beyond the named suffixes: use letter pairs aa, ab, ...
	var idx := tier - SUFFIX.size()
	var first := int(idx / 26)
	var second := idx % 26
	var letters := char(97 + first) + char(97 + second)
	var scaled2 := n / pow(1000.0, tier)
	return String.num(scaled2, 2).rstrip("0").rstrip(".") + letters

static func rate(n: float) -> String:
	return short(n) + "/s"

static func time_span(seconds: float) -> String:
	var s := int(seconds)
	var d := s / 86400
	var h := (s % 86400) / 3600
	var m := (s % 3600) / 60
	if d > 0:
		return "%dd %dh" % [d, h]
	if h > 0:
		return "%dh %dm" % [h, m]
	if m > 0:
		return "%dm %ds" % [m, s % 60]
	return "%ds" % (s % 60)

static func color(hex: String) -> Color:
	return Color(hex)
