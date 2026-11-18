extends Node
# SaveManager — the only code that touches disk. One JSON file holds the whole
# Game.state dict, so persistence stays a single stringify/parse. Everything here
# is defensive: a corrupt or partial file must degrade to a clean new game, never
# crash boot, and migrate() backfills anything a newer version added.

const PATH := "user://blockle_idle_save.json"

func load_or_new() -> Dictionary:
	# A missing file is the common first-run path, not an error.
	if not FileAccess.file_exists(PATH):
		return Game.new_state()
	var f := FileAccess.open(PATH, FileAccess.READ)
	if f == null:
		push_warning("Save: could not open %s, starting fresh" % PATH)
		return Game.new_state()
	var text := f.get_as_text()
	f.close()
	var parsed = JSON.parse_string(text)
	# Anything that is not a well-formed dict (empty file, truncated write,
	# hand-edited garbage) falls back rather than propagating bad state.
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("Save: corrupt save at %s, starting fresh" % PATH)
		return Game.new_state()
	return migrate(parsed)

func save(state: Dictionary) -> void:
	var text := JSON.stringify(state)
	# Write to a temp file first and swap it in, so a crash mid-write can never
	# leave a half-flushed save that unload_or_new would reject.
	var tmp := PATH + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		push_warning("Save: could not open %s for writing" % tmp)
		return
	f.store_string(text)
	f.flush()
	f.close()
	var err := DirAccess.rename_absolute(ProjectSettings.globalize_path(tmp), ProjectSettings.globalize_path(PATH))
	if err != OK:
		# Rename across some sandboxed user:// backends can refuse; fall back to
		# a direct write so the player still keeps their progress.
		var g := FileAccess.open(PATH, FileAccess.WRITE)
		if g != null:
			g.store_string(text)
			g.flush()
			g.close()

func migrate(s: Dictionary) -> Dictionary:
	# Backfill any top-level key a newer build expects but an older save lacks.
	var defaults := Game.new_state()
	for k in defaults.keys():
		if not s.has(k):
			s[k] = defaults[k]
	# "cosmetics" is added by the Cosmetics manager and may predate this field.
	if not s.has("cosmetics"):
		s["cosmetics"] = {}
	# Every resource the game knows about must exist so res()/UI never see null.
	if typeof(s.get("resources", null)) != TYPE_DICTIONARY:
		s["resources"] = {}
	for r in GameData.resources:
		if not s["resources"].has(r["id"]):
			s["resources"][r["id"]] = 0.0
	s["version"] = Game.SAVE_VERSION
	return s

func has_save() -> bool:
	return FileAccess.file_exists(PATH)

func wipe() -> void:
	# Debug / "start over" support — remove the file if present.
	if FileAccess.file_exists(PATH):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(PATH))
