extends Node
# AudioManager — plays sfx through a small round-robin pool and one music stream.
# No audio ships yet, so every path is guarded with ResourceLoader.exists: the
# game must be fully playable (and silent) before any .wav/.ogg lands. Volumes
# live in Game.state.settings so they persist and the options screen can bind to
# the same source of truth.

const SFX_POOL_SIZE := 6
const SFX_DIR := "res://audio/sfx/"
const MUSIC_DIR := "res://audio/music/"

var _sfx_players: Array = []
var _music: AudioStreamPlayer
var _current_music := ""

func _ready() -> void:
	for i in SFX_POOL_SIZE:
		var p := AudioStreamPlayer.new()
		p.bus = "Master"
		add_child(p)
		_sfx_players.append(p)
	_music = AudioStreamPlayer.new()
	_music.bus = "Master"
	add_child(_music)
	_apply_saved_volumes()

func _apply_saved_volumes() -> void:
	# Game may not be booted when autoloads first _ready; guard the read.
	var settings: Dictionary = _settings()
	_set_music_db(float(settings.get("music", 0.6)))
	_set_sfx_db(float(settings.get("sfx", 0.8)))

func _settings() -> Dictionary:
	if Game != null and typeof(Game.state) == TYPE_DICTIONARY:
		var s = Game.state.get("settings", null)
		if typeof(s) == TYPE_DICTIONARY:
			return s
	return {}

# Linear 0..1 slider to decibels, with 0 fully silenced instead of -inf noise.
func _lin_to_db(v01: float) -> float:
	var v: float = clamp(v01, 0.0, 1.0)
	if v <= 0.0:
		return -80.0
	return linear_to_db(v)

func _free_sfx_player() -> AudioStreamPlayer:
	for p in _sfx_players:
		if not p.playing:
			return p
	# All busy — reuse the first (oldest) so a tap never drops silently.
	return _sfx_players[0] if _sfx_players.size() > 0 else null

func play_sfx(sfx_name: String) -> void:
	var stream := _load_audio(SFX_DIR + sfx_name)
	if stream == null:
		return
	var p := _free_sfx_player()
	if p == null:
		return
	p.stream = stream
	p.play()

func play_music(realm_id: String) -> void:
	if realm_id == _current_music and _music != null and _music.playing:
		return
	var stream := _load_audio(MUSIC_DIR + realm_id)
	if stream == null:
		# No track for this realm — go quiet rather than leave the last one.
		if _music != null:
			_music.stop()
		_current_music = ""
		return
	# Loop seamlessly where the import settings allow it.
	if stream is AudioStreamOggVorbis:
		(stream as AudioStreamOggVorbis).loop = true
	elif stream is AudioStreamWAV:
		(stream as AudioStreamWAV).loop_mode = AudioStreamWAV.LOOP_FORWARD
	_music.stream = stream
	_music.play()
	_current_music = realm_id

# Tries .ogg then .wav for the given extension-less base path.
func _load_audio(base: String) -> AudioStream:
	for ext in [".ogg", ".wav"]:
		var path: String = base + ext
		if ResourceLoader.exists(path):
			var r = load(path)
			if r is AudioStream:
				return r
	return null

func set_music_volume(v01: float) -> void:
	if Game != null and typeof(Game.state) == TYPE_DICTIONARY and Game.state.has("settings"):
		Game.state["settings"]["music"] = clamp(v01, 0.0, 1.0)
	_set_music_db(v01)

func set_sfx_volume(v01: float) -> void:
	if Game != null and typeof(Game.state) == TYPE_DICTIONARY and Game.state.has("settings"):
		Game.state["settings"]["sfx"] = clamp(v01, 0.0, 1.0)
	_set_sfx_db(v01)

func _set_music_db(v01: float) -> void:
	if _music != null:
		_music.volume_db = _lin_to_db(v01)

func _set_sfx_db(v01: float) -> void:
	var db := _lin_to_db(v01)
	for p in _sfx_players:
		p.volume_db = db
