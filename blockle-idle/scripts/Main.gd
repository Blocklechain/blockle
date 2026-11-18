extends Node2D
# Main — mounts the island and frames it. Nothing else yet: the rule for this
# rebuild is that one screen must look genuinely good before any system returns.

var _world: World

func _ready() -> void:
	_world = World.new()
	add_child(_world)
	_frame()
	get_viewport().size_changed.connect(_frame)

func _frame() -> void:
	# Centre the island, sitting a little below the middle so sky reads above it.
	var vp := get_viewport_rect().size
	_world.position = Vector2(vp.x * 0.5, vp.y * 0.46).round()
