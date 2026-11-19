class_name Kin
extends RefCounted
# Kin — the Blocklings: the little people of the island.
#
# One of these is a handful of numbers, not a node. World owns the list, ticks
# them, and draws them in the same back-to-front pass as everything else so they
# sort correctly against trees and cottages. Keeping them data (rather than
# scene nodes) is what lets dozens of them cost almost nothing.
#
# Each one wanders the island on the tile grid: it picks a nearby walkable tile,
# strolls there with a little two-frame bob, pauses to look around, and at night
# heads home to a cottage. Their colour and build are seeded, so the same island
# is always inhabited by the same recognisable crowd.

var gx := 0.0          # smooth grid position (they move between tiles)
var gy := 0.0
var tx := 0.0          # the tile being walked toward
var ty := 0.0
var z := 1.0           # ground elevation under them
var seedv := 0
var body: Array = []   # colour triple
var hat: Color = Color(0, 0, 0, 0)
var speed := 0.55
var pause := 0.0       # seconds left standing still
var bob := 0.0         # animation phase
var facing := 1.0      # +1 = facing screen-right, -1 = left
var home := Vector2(0, 0)
var going_home := false

func grid() -> Vector2:
	return Vector2(gx, gy)
